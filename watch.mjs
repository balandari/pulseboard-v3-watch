// PulseBoard alert watcher. Node 20.11+, no packages.
// Checks thepulseboard.io, and tells ntfy when something breaks and when it is fixed.
// It reads and writes only words and times; it never touches anyone's holdings.

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const URLS = {
  page: 'https://thepulseboard.io/',
  health: 'https://thepulseboard.io/api/health',
  snapshot: 'https://thepulseboard.io/api/crypto/snapshot',
};
export const TIMEOUT_MS = 15_000; // a request that takes longer fails its check
export const STALE_MS = 60_000; // the app's own stale line (FRESHNESS.staleMs)
export const SECOND_LOOK_MS = 120_000; // wait before the second look
const ZONE = 'America/Chicago';

// ---------- Central time ----------

function centralParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return p;
}

export function centralTime(ms) {
  const p = centralParts(ms);
  return `${p.hour}:${p.minute}`;
}

export function centralISO(ms) {
  const p = centralParts(ms);
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

export function isoWeek(ms) {
  const p = centralParts(ms);
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  const dayNum = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dayNum); // the Thursday of this ISO week
  const year = day.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((day.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ---------- requests ----------

class CheckError extends Error {}

// Runs fn(signal) but gives up after timeoutMs. The timeout covers reading the body too.
async function withTimeout(fn, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CheckError('timeout'));
    }, timeoutMs);
  });
  const work = Promise.resolve().then(() => fn(controller.signal));
  work.catch(() => {}); // a late failure after the timeout is not news
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function get(url, { fetch, timeoutMs }) {
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(url, { method: 'GET', cache: 'no-store', redirect: 'manual', signal });
      const text = await res.text();
      return { status: res.status, text };
    }, timeoutMs);
  } catch (err) {
    if (err instanceof CheckError) throw err;
    throw new CheckError('cannot connect'); // never pass on the original message
  }
}

function parseJson(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const pass = (name) => ({ name, ok: true, reason: '', fault: null });
const fail = (name, fault, reason, extra = {}) => ({ name, ok: false, reason, fault, ...extra });

async function checkPage(ctx) {
  let res;
  try {
    res = await get(URLS.page, ctx);
  } catch (err) {
    return fail('page', 'page', err.message);
  }
  if (res.status !== 200) return fail('page', 'page', `status ${res.status}`);
  return pass('page');
}

async function checkHealth(ctx) {
  let res;
  try {
    res = await get(URLS.health, ctx);
  } catch (err) {
    return fail('health', 'health', err.message);
  }
  if (res.status !== 200) return fail('health', 'health', `status ${res.status}`);
  const body = parseJson(res.text);
  if (!body) return fail('health', 'health', 'bad JSON');
  const storeBad = body.store !== 'ok';
  const signinBad = body.signin !== 'ready';
  if (storeBad && signinBad) return fail('health', 'health', 'store not ok, signin not ready');
  if (storeBad) return fail('health', 'health-store', 'store not ok');
  if (signinBad) return fail('health', 'health-signin', 'signin not ready');
  return pass('health');
}

async function checkSnapshot(ctx) {
  let res;
  try {
    res = await get(URLS.snapshot, ctx);
  } catch (err) {
    return fail('snapshot', 'snapshot', err.message);
  }
  if (res.status !== 200) return fail('snapshot', 'snapshot', `status ${res.status}`);
  const body = parseJson(res.text);
  if (!body) return fail('snapshot', 'snapshot', 'bad JSON');
  if (body.source !== 'coinbase') return fail('snapshot', 'snapshot', 'source not coinbase');
  if (!Array.isArray(body.coins) || body.coins.length < 1) return fail('snapshot', 'snapshot', 'no coins');
  const asOf = typeof body.asOf === 'string' ? Date.parse(body.asOf) : NaN;
  if (Number.isNaN(asOf)) return fail('snapshot', 'snapshot', 'asOf missing');
  const ageMs = ctx.now() - asOf;
  if (ageMs < -STALE_MS) return fail('snapshot', 'snapshot', 'asOf in the future');
  if (ageMs >= STALE_MS) {
    return fail('snapshot', 'snapshot-stale', `asOf ${Math.floor(ageMs / 1000)} s old`, { ageMs });
  }
  return pass('snapshot');
}

// Runs the three checks. fetch, now and timeoutMs are parameters so tests can plant faults.
export async function runChecks({ fetch = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  const ctx = { fetch, now, timeoutMs };
  return Promise.all([checkPage(ctx), checkHealth(ctx), checkSnapshot(ctx)]);
}

// ---------- messages ----------

function faultPhrase(fault, ageMs) {
  switch (fault) {
    case 'page':
      return 'the site is not answering';
    case 'health-store':
      return 'the database check failed';
    case 'health-signin':
      return 'the sign-in check failed';
    case 'health':
      return 'the health check failed';
    case 'snapshot-stale': {
      const minutes = Math.max(1, Math.floor(ageMs / 60_000));
      return `prices on the site are ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} old`;
    }
    default:
      return 'the prices on the site are not available';
  }
}

// One message for the whole set of broken things, in check order.
function faultsMessage(results, sinceMs) {
  const phrases = results.map((r) => faultPhrase(r.fault, r.ageMs));
  return `PulseBoard: ${phrases.join(' and ')} (since ${centralTime(sinceMs)})`;
}

const fixedMessage = (sinceMs) => `PulseBoard: fixed, all fine since ${centralTime(sinceMs)}`;

// ---------- ntfy ----------

export async function sendNtfy({ fetch = globalThis.fetch, topic, message, timeoutMs = TIMEOUT_MS }) {
  let status;
  try {
    status = await withTimeout(async (signal) => {
      const res = await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Title: 'PulseBoard' },
        body: message,
        signal,
      });
      return res.status;
    }, timeoutMs);
  } catch (err) {
    throw new Error(err instanceof CheckError ? err.message : 'cannot connect'); // no topic, no details
  }
  if (status < 200 || status >= 300) throw new Error(`ntfy answered ${status}`);
}

// ---------- state.json ----------

const STATE_PATH = fileURLToPath(new URL('./state.json', import.meta.url));

export function readStateFile(path = STATE_PATH) {
  try {
    const s = JSON.parse(fs.readFileSync(path, 'utf8'));
    return s && typeof s.state === 'string' ? s : null;
  } catch {
    return null;
  }
}

export function writeStateFile(state, path = STATE_PATH) {
  fs.writeFileSync(path, JSON.stringify(state) + '\n');
}

// ---------- the run ----------

function logResults(log, results) {
  for (const r of results) log(r.ok ? `${r.name}: pass` : `${r.name}: fail (${r.reason})`);
}

export async function watch({
  env = process.env,
  fetch = globalThis.fetch,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  readState = readStateFile,
  writeState = writeStateFile,
  send = (args) => sendNtfy({ fetch, ...args }),
  dryRun = false,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const topic = String(env.NTFY_TOPIC ?? '').trim();
  if (!dryRun && !topic) {
    log('error: NTFY_TOPIC is not set; nothing was checked and nothing was sent');
    return { ok: false, messages: [], state: null };
  }

  const firstMs = now();
  const first = await runChecks({ fetch, now, timeoutMs });
  logResults(log, first);

  // The state is the set of confirmed fault codes in check order joined by "+", or "ok".
  let confirmed = [];
  let lastMs = firstMs;
  let secondAllPass = false;
  const firstFailed = first.some((r) => !r.ok);
  if (firstFailed) {
    log('a check failed; second look in 2 minutes');
    await wait(SECOND_LOOK_MS);
    const second = await runChecks({ fetch, now, timeoutMs });
    logResults(log, second);
    lastMs = now();
    secondAllPass = second.every((r) => r.ok);
    // only a fault code seen on both looks counts (checks run in check order)
    const firstCodes = new Set(first.filter((r) => !r.ok).map((r) => r.fault));
    confirmed = second.filter((r) => !r.ok && firstCodes.has(r.fault));
  }

  let prev = null;
  try {
    prev = readState();
  } catch {
    prev = null;
  }
  const prevName = prev && typeof prev.state === 'string' ? prev.state : null;
  const week = isoWeek(lastMs);

  // What the state becomes. A fault seen only once is not news, so when nothing is confirmed
  // and the second look still had a failure, the state stays exactly as it was.
  let stateName;
  if (!firstFailed) stateName = 'ok';
  else if (confirmed.length > 0) stateName = confirmed.map((r) => r.fault).join('+');
  else if (secondAllPass) stateName = 'ok';
  else stateName = prevName ?? 'ok';

  let next;
  let message = null;
  if (stateName === prevName) {
    next = { state: prev.state, since: prev.since, checkedWeek: week };
  } else if (stateName === 'ok') {
    next = { state: 'ok', since: centralISO(lastMs), checkedWeek: week };
    if (prevName !== null) message = fixedMessage(lastMs);
  } else {
    next = { state: stateName, since: centralISO(firstMs), checkedWeek: week };
    message = faultsMessage(confirmed, firstMs);
  }

  const messages = message ? [message] : [];
  if (dryRun) {
    log(message ? `would send: ${message}` : 'would send: nothing');
    log(`state would be: ${next.state} (dry run, nothing saved)`);
    return { ok: true, messages, state: next };
  }

  if (message) {
    try {
      await send({ topic, message });
      log('notify: sent');
    } catch {
      log('notify: fail (could not send)');
      // The state stays as it was, so the next run tries again; only the week moves, so the
      // weekly keep-alive never stops during a long ntfy outage.
      if (prev && prev.checkedWeek !== week) writeState({ state: prev.state, since: prev.since, checkedWeek: week });
      return { ok: false, messages: [], state: prev };
    }
  }

  const changed = !prev || prev.state !== next.state || prev.since !== next.since || prev.checkedWeek !== next.checkedWeek;
  if (changed) writeState(next);
  return { ok: true, messages, state: next };
}

// ---------- command line ----------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dryRun = process.argv.includes('--dry-run');
  watch({ dryRun })
    .then((r) => {
      if (!r.ok) process.exitCode = 1;
    })
    .catch(() => {
      console.log('error: the watcher stopped unexpectedly');
      process.exitCode = 1;
    });
}
