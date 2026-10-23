import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  watch,
  runChecks,
  sendNtfy,
  centralTime,
  centralISO,
  isoWeek,
  URLS,
  TIMEOUT_MS,
  STALE_MS,
  SECOND_LOOK_MS,
} from './watch.mjs';

const TOPIC = 'zz-test-topic-4f9a1c';
// 2026-10-22 20:13:00 Central (CDT, UTC-5)
const T0 = Date.UTC(2026, 9, 23, 1, 13, 0);
const MIN = 60_000;

// A fake world: the three addresses, a clock, a wait that costs nothing, and a place to keep state.
function makeWorld(overrides = {}) {
  const w = {
    t: T0,
    page: { status: 200 },
    health: { status: 200, body: { version: '0.3.1', env: 'production', store: 'ok', signin: 'ready' } },
    snapshotAgeMs: 5_000,
    snapshot: { status: 200, source: 'coinbase', coins: [{ symbol: 'BTC' }] },
    calls: [],
    ntfyCalls: [],
    ntfyStatus: 200,
    waits: [],
    sent: [],
    logs: [],
    stateWrites: [],
    stored: null,
    sendError: false,
    onWait: null,
    ...overrides,
  };
  w.now = () => w.t;
  w.wait = async (ms) => {
    w.waits.push(ms);
    w.t += ms;
    if (w.onWait) w.onWait(w);
  };
  w.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://ntfy.sh/')) {
      w.ntfyCalls.push({ url, init });
      return new Response('{}', { status: w.ntfyStatus });
    }
    w.calls.push({ url, method: init.method ?? 'GET', redirect: init.redirect });
    const answer = (what) => {
      if (what === 'hang') return new Promise(() => {});
      if (what === 'throw') throw new TypeError('fetch failed');
      return what;
    };
    if (url === URLS.page) {
      const p = answer(w.page);
      if (p instanceof Promise) return p;
      return new Response('<html></html>', { status: p.status });
    }
    if (url === URLS.health) {
      const h = answer(w.health);
      if (h instanceof Promise) return h;
      return new Response(typeof h.body === 'string' ? h.body : JSON.stringify(h.body), { status: h.status });
    }
    if (url === URLS.snapshot) {
      const s = answer(w.snapshot);
      if (s instanceof Promise) return s;
      const body = {
        asOf: new Date(w.t - w.snapshotAgeMs).toISOString(),
        source: s.source,
        coins: s.coins,
      };
      if (s.noAsOf) delete body.asOf;
      if (s.asOf) body.asOf = s.asOf(w.t);
      return new Response(JSON.stringify(body), { status: s.status });
    }
    throw new Error('unexpected address ' + url);
  };
  w.opts = (extra = {}) => ({
    env: { NTFY_TOPIC: TOPIC },
    fetch: w.fetch,
    now: w.now,
    wait: w.wait,
    log: (line) => w.logs.push(line),
    readState: () => (w.stored ? structuredClone(w.stored) : null),
    writeState: (s) => {
      w.stateWrites.push(structuredClone(s));
      w.stored = structuredClone(s);
    },
    send: async ({ topic, message }) => {
      if (w.sendError) throw new Error('boom ' + topic);
      w.sent.push({ topic, message });
    },
    timeoutMs: 50,
    ...extra,
  });
  return w;
}

const okState = (week = '2026-W43') => ({ state: 'ok', since: '2026-10-22T08:00:00-05:00', checkedWeek: week });

// ---------- constants and time helpers ----------

test('the numbers of the spec: 15 s timeout, 60 s stale line, two minutes to the second look', () => {
  assert.equal(TIMEOUT_MS, 15_000);
  assert.equal(STALE_MS, 60_000);
  assert.equal(SECOND_LOOK_MS, 120_000);
});

test('the three addresses are exactly the ones of the spec', () => {
  assert.deepEqual(URLS, {
    page: 'https://thepulseboard.io/',
    health: 'https://thepulseboard.io/api/health',
    snapshot: 'https://thepulseboard.io/api/crypto/snapshot',
  });
});

test('times are Central as HH:mm, in summer and in winter', () => {
  assert.equal(centralTime(T0), '20:13');
  assert.equal(centralTime(Date.UTC(2026, 11, 1, 2, 13, 0)), '20:13'); // CST, UTC-6
  assert.equal(centralTime(Date.UTC(2026, 9, 23, 5, 5, 0)), '00:05');
});

test('the ISO time carries the Central offset', () => {
  assert.equal(centralISO(T0), '2026-10-22T20:13:00-05:00');
  assert.equal(centralISO(Date.UTC(2026, 11, 1, 2, 13, 0)), '2026-11-30T20:13:00-06:00');
});

test('ISO week in Central time', () => {
  assert.equal(isoWeek(T0), '2026-W43');
  assert.equal(isoWeek(Date.UTC(2027, 0, 2, 12, 0, 0)), '2026-W53');
  assert.equal(isoWeek(Date.UTC(2026, 0, 6, 12, 0, 0)), '2026-W02');
  // 00:30 UTC on Monday 2026-10-26 is still Sunday evening in Chicago: week 43
  assert.equal(isoWeek(Date.UTC(2026, 9, 26, 0, 30, 0)), '2026-W43');
});

// ---------- the single checks ----------

test('all three fine: every check passes', async () => {
  const w = makeWorld();
  const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 50 });
  assert.deepEqual(r.map((c) => [c.name, c.ok]), [['page', true], ['health', true], ['snapshot', true]]);
});

test('the page answering 500 fails the page check', async () => {
  const w = makeWorld({ page: { status: 500 } });
  const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 50 });
  const page = r.find((c) => c.name === 'page');
  assert.equal(page.ok, false);
  assert.equal(page.fault, 'page');
  assert.match(page.reason, /500/);
});

test('health with store "error" fails as health-store', async () => {
  const w = makeWorld();
  w.health.body.store = 'error';
  const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 50 });
  const h = r.find((c) => c.name === 'health');
  assert.equal(h.ok, false);
  assert.equal(h.fault, 'health-store');
});

test('health with signin not ready fails as health-signin', async () => {
  const w = makeWorld();
  w.health.body.signin = 'down';
  const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 50 });
  assert.equal(r.find((c) => c.name === 'health').fault, 'health-signin');
});

test('health with both wrong, a 503, or text that is not JSON fails as plain health', async () => {
  for (const mutate of [
    (w) => { w.health.body.store = 'error'; w.health.body.signin = 'down'; },
    (w) => { w.health.status = 503; },
    (w) => { w.health.body = 'not json at all'; },
    (w) => { w.health = 'throw'; },
  ]) {
    const w = makeWorld();
    mutate(w);
    const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 50 });
    const h = r.find((c) => c.name === 'health');
    assert.equal(h.ok, false);
    assert.equal(h.fault, 'health');
  }
});

test('a snapshot 4 minutes old fails as snapshot-stale with its age', async () => {
  const w = makeWorld({ snapshotAgeMs: 241_000 });
  const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 50 });
  const s = r.find((c) => c.name === 'snapshot');
  assert.equal(s.ok, false);
  assert.equal(s.fault, 'snapshot-stale');
  assert.equal(s.ageMs, 241_000);
  assert.equal(s.reason, 'asOf 241 s old');
});

test('the stale line is exactly 60 seconds: 59 s is fresh, 60 s is stale', async () => {
  const fresh = makeWorld({ snapshotAgeMs: 59_000 });
  const rf = await runChecks({ fetch: fresh.fetch, now: fresh.now, timeoutMs: 50 });
  assert.equal(rf.find((c) => c.name === 'snapshot').ok, true);

  const stale = makeWorld({ snapshotAgeMs: 60_000 });
  const rs = await runChecks({ fetch: stale.fetch, now: stale.now, timeoutMs: 50 });
  const s = rs.find((c) => c.name === 'snapshot');
  assert.equal(s.ok, false);
  assert.equal(s.fault, 'snapshot-stale');
});

test('a snapshot whose source is not coinbase fails', async () => {
  const w = makeWorld();
  w.snapshot.source = 'fallback';
  const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 50 });
  const s = r.find((c) => c.name === 'snapshot');
  assert.equal(s.ok, false);
  assert.equal(s.fault, 'snapshot');
  assert.match(s.reason, /source/);
});

test('a snapshot with no coins (empty or missing) fails', async () => {
  for (const coins of [[], undefined]) {
    const w = makeWorld();
    w.snapshot.coins = coins;
    const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 50 });
    const s = r.find((c) => c.name === 'snapshot');
    assert.equal(s.ok, false);
    assert.equal(s.fault, 'snapshot');
    assert.match(s.reason, /no coins/);
  }
});

test('a snapshot with no usable asOf, or a 500, fails', async () => {
  const a = makeWorld();
  a.snapshot.noAsOf = true;
  const ra = await runChecks({ fetch: a.fetch, now: a.now, timeoutMs: 50 });
  assert.equal(ra.find((c) => c.name === 'snapshot').ok, false);

  const b = makeWorld();
  b.snapshot.status = 500;
  const rb = await runChecks({ fetch: b.fetch, now: b.now, timeoutMs: 50 });
  assert.equal(rb.find((c) => c.name === 'snapshot').ok, false);
});

test('a request that cannot connect fails its check', async () => {
  const w = makeWorld({ page: 'throw' });
  const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 50 });
  const page = r.find((c) => c.name === 'page');
  assert.equal(page.ok, false);
  assert.equal(page.reason, 'cannot connect');
});

test('a request that never answers fails its check at the timeout', async () => {
  const w = makeWorld({ page: 'hang' });
  const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 20 });
  const page = r.find((c) => c.name === 'page');
  assert.equal(page.ok, false);
  assert.equal(page.reason, 'timeout');
  assert.equal(r.find((c) => c.name === 'health').ok, true);
});

test('the real timeout is 15 seconds: still waiting at 14.999 s, failed at 15 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = makeWorld({ health: 'hang' });
  let result = null;
  const p = runChecks({ fetch: w.fetch, now: w.now }).then((r) => { result = r; });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await flush();
  t.mock.timers.tick(14_999);
  await flush();
  assert.equal(result, null);
  t.mock.timers.tick(1);
  await p;
  const h = result.find((c) => c.name === 'health');
  assert.equal(h.ok, false);
  assert.equal(h.reason, 'timeout');
});

test('a body that never finishes also fails at the timeout', async () => {
  const w = makeWorld();
  w.fetch = async (url) => {
    if (url === URLS.page) {
      const stream = new ReadableStream({ start() {} });
      return new Response(stream, { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 20 });
  assert.equal(r.find((c) => c.name === 'page').reason, 'timeout');
});

test('only GET requests, only the three addresses', async () => {
  const w = makeWorld();
  await watch(w.opts());
  assert.ok(w.calls.length >= 3);
  for (const c of w.calls) assert.equal(c.method, 'GET');
  for (const c of w.calls) assert.equal(c.redirect, 'manual');
  assert.deepEqual([...new Set(w.calls.map((c) => c.url))].sort(), Object.values(URLS).sort());
});

// ---------- whole runs ----------

test('all fine with state already ok: sends nothing, no second look, leaves the state alone', async () => {
  const w = makeWorld({ stored: okState() });
  const r = await watch(w.opts());
  assert.equal(r.ok, true);
  assert.equal(w.sent.length, 0);
  assert.equal(w.waits.length, 0);
  assert.equal(w.stateWrites.length, 0);
  assert.deepEqual(w.stored, okState());
});

test('no state file yet and all fine: writes ok, sends nothing', async () => {
  const w = makeWorld();
  await watch(w.opts());
  assert.equal(w.sent.length, 0);
  assert.equal(w.stateWrites.length, 1);
  assert.deepEqual(w.stored, { state: 'ok', since: '2026-10-22T20:13:00-05:00', checkedWeek: '2026-W43' });
});

test('page answering 500 both times: one message, waits exactly two minutes', async () => {
  const w = makeWorld({ stored: okState(), page: { status: 500 } });
  const r = await watch(w.opts());
  assert.equal(r.ok, true);
  assert.deepEqual(w.waits, [120_000]);
  assert.deepEqual(w.sent, [{ topic: TOPIC, message: 'PulseBoard: the site is not answering (since 20:13)' }]);
  assert.equal(w.stored.state, 'page');
  assert.equal(w.stored.since, '2026-10-22T20:13:00-05:00');
});

test('health store error both times: the database message', async () => {
  const w = makeWorld({ stored: okState() });
  w.health.body.store = 'error';
  await watch(w.opts());
  assert.deepEqual(w.sent.map((s) => s.message), ['PulseBoard: the database check failed (since 20:13)']);
  assert.equal(w.stored.state, 'health-store');
});

test('sign-in not ready both times: the sign-in message', async () => {
  const w = makeWorld({ stored: okState() });
  w.health.body.signin = 'down';
  await watch(w.opts());
  assert.deepEqual(w.sent.map((s) => s.message), ['PulseBoard: the sign-in check failed (since 20:13)']);
  assert.equal(w.stored.state, 'health-signin');
});

test('plain health trouble: the health message', async () => {
  const w = makeWorld({ stored: okState() });
  w.health.status = 503;
  await watch(w.opts());
  assert.deepEqual(w.sent.map((s) => s.message), ['PulseBoard: the health check failed (since 20:13)']);
  assert.equal(w.stored.state, 'health');
});

test('a snapshot 4 minutes old both times: the prices message', async () => {
  const w = makeWorld({ stored: okState(), snapshotAgeMs: 241_000 });
  await watch(w.opts());
  // the second look is two minutes later and the snapshot keeps its own clock, so it is 241 s old again
  assert.deepEqual(w.sent.map((s) => s.message), ['PulseBoard: prices on the site are 4 minutes old (since 20:13)']);
  assert.equal(w.stored.state, 'snapshot-stale');
});

test('one minute old reads in the singular', async () => {
  const w = makeWorld({ stored: okState(), snapshotAgeMs: 61_000 });
  await watch(w.opts());
  assert.deepEqual(w.sent.map((s) => s.message), ['PulseBoard: prices on the site are 1 minute old (since 20:13)']);
});

test('a snapshot with the wrong source: the prices-unavailable message', async () => {
  const w = makeWorld({ stored: okState() });
  w.snapshot.source = 'cache';
  await watch(w.opts());
  assert.deepEqual(w.sent.map((s) => s.message), ['PulseBoard: the prices on the site are not available (since 20:13)']);
  assert.equal(w.stored.state, 'snapshot');
});

test('a request that never answers, both looks: the site message', async () => {
  const w = makeWorld({ stored: okState(), page: 'hang' });
  await watch(w.opts({ timeoutMs: 20 }));
  assert.deepEqual(w.sent.map((s) => s.message), ['PulseBoard: the site is not answering (since 20:13)']);
});

test('a fault that clears within two minutes sends nothing and leaves the state', async () => {
  const w = makeWorld({ stored: okState(), page: { status: 500 } });
  w.onWait = (world) => { world.page = { status: 200 }; };
  const r = await watch(w.opts());
  assert.equal(r.ok, true);
  assert.deepEqual(w.waits, [120_000]);
  assert.equal(w.sent.length, 0);
  assert.equal(w.stateWrites.length, 0);
  assert.deepEqual(w.stored, okState());
});

test('a fault seen on the first look only, from a different check, does not count', async () => {
  const w = makeWorld({ stored: okState(), page: { status: 500 } });
  w.onWait = (world) => { world.page = { status: 200 }; world.health.body.store = 'error'; };
  await watch(w.opts());
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.stored, okState());
});

test('a fault that goes on: no new message while the state stays the same', async () => {
  const w = makeWorld({ stored: okState(), page: { status: 500 } });
  await watch(w.opts());
  assert.equal(w.sent.length, 1);
  w.t += 10 * MIN;
  await watch(w.opts());
  w.t += 10 * MIN;
  await watch(w.opts());
  assert.equal(w.sent.length, 1);
  assert.equal(w.stored.since, '2026-10-22T20:13:00-05:00');
});

test('a fault, a second different fault, then recovery: exactly three notifications', async () => {
  const w = makeWorld({ stored: okState(), page: { status: 500 } });
  await watch(w.opts()); // 1: the site is down
  w.t += 10 * MIN;
  w.page = { status: 200 };
  w.snapshotAgeMs = 4 * MIN + 1_000;
  await watch(w.opts()); // 2: the site is back, but the prices are stale
  w.t += 10 * MIN;
  await watch(w.opts()); // still stale: nothing
  w.t += 10 * MIN;
  w.snapshotAgeMs = 3_000;
  await watch(w.opts()); // 3: fixed
  w.t += 10 * MIN;
  await watch(w.opts()); // nothing
  assert.equal(w.sent.length, 3);
  assert.match(w.sent[0].message, /the site is not answering \(since 20:13\)/);
  assert.match(w.sent[1].message, /prices on the site are 4 minutes old \(since 20:2\d\)/);
  assert.match(w.sent[2].message, /^PulseBoard: fixed, all fine since 20:\d\d$/);
  assert.equal(w.stored.state, 'ok');
});

test('recovery sends exactly one "fixed" message with the time since all is fine', async () => {
  const w = makeWorld({ stored: { state: 'page', since: '2026-10-22T20:13:00-05:00', checkedWeek: '2026-W43' } });
  w.t = Date.UTC(2026, 9, 23, 1, 41, 0); // 20:41 Central
  await watch(w.opts());
  assert.deepEqual(w.sent, [{ topic: TOPIC, message: 'PulseBoard: fixed, all fine since 20:41' }]);
  assert.deepEqual(w.stored, { state: 'ok', since: '2026-10-22T20:41:00-05:00', checkedWeek: '2026-W43' });
  w.t += 10 * MIN;
  await watch(w.opts());
  assert.equal(w.sent.length, 1);
});

test('a new ISO week with everything fine rewrites only checkedWeek, sends nothing', async () => {
  const w = makeWorld({ stored: okState('2026-W42') });
  await watch(w.opts());
  assert.equal(w.sent.length, 0);
  assert.equal(w.stateWrites.length, 1);
  assert.deepEqual(w.stored, { state: 'ok', since: '2026-10-22T08:00:00-05:00', checkedWeek: '2026-W43' });
});

test('a run with no topic fails loudly, checks nothing, sends nothing', async () => {
  for (const env of [{}, { NTFY_TOPIC: '' }, { NTFY_TOPIC: '   ' }]) {
    const w = makeWorld({ stored: okState() });
    const r = await watch(w.opts({ env }));
    assert.equal(r.ok, false);
    assert.equal(w.sent.length, 0);
    assert.equal(w.calls.length, 0);
    assert.equal(w.stateWrites.length, 0);
    assert.ok(w.logs.some((l) => /NTFY_TOPIC/.test(l) && /not set/.test(l)));
  }
});

test('if the notification cannot be sent the run fails and the state is not saved', async () => {
  const w = makeWorld({ stored: okState(), page: { status: 500 }, sendError: true });
  const r = await watch(w.opts());
  assert.equal(r.ok, false);
  assert.equal(w.stateWrites.length, 0);
  assert.deepEqual(w.stored, okState());
  assert.ok(w.logs.some((l) => /notify: fail/.test(l)));
});

test('dry run: runs the checks, shows the message, sends and saves nothing, needs no topic', async () => {
  const w = makeWorld({ stored: okState(), page: { status: 500 } });
  const r = await watch(w.opts({ env: {}, dryRun: true }));
  assert.equal(r.ok, true);
  assert.equal(w.sent.length, 0);
  assert.equal(w.stateWrites.length, 0);
  assert.ok(w.logs.some((l) => l.includes('PulseBoard: the site is not answering (since 20:13)')));
});

// ---------- what is allowed to appear ----------

const PHRASE =
  '(?:the site is not answering|the database check failed|the sign-in check failed|the health check failed|prices on the site are \\d+ minutes? old|the prices on the site are not available)';
const ALLOWED_MESSAGES = [
  new RegExp('^PulseBoard: ' + PHRASE + '(?: and ' + PHRASE + ')* \\(since \\d\\d:\\d\\d\\)$'),
  /^PulseBoard: fixed, all fine since \d\d:\d\d$/,
];

test('every message is one of the spec words and times, nothing else', async () => {
  const scenarios = [
    (w) => { w.page = { status: 500 }; },
    (w) => { w.health.body.store = 'error'; },
    (w) => { w.health.body.signin = 'down'; },
    (w) => { w.health.status = 502; },
    (w) => { w.snapshotAgeMs = 300_000; },
    (w) => { w.snapshot.source = 'x'; },
    (w) => { w.stored = { state: 'page', since: '2026-10-22T20:00:00-05:00', checkedWeek: '2026-W43' }; },
  ];
  for (const s of scenarios) {
    const w = makeWorld({ stored: okState() });
    // a secret-looking body and extra fields must never leak into a message
    w.health.body.holdings = 'SECRET-HOLDINGS-123';
    w.health.body.version = 'SECRET-VERSION';
    s(w);
    await watch(w.opts());
    assert.equal(w.sent.length, 1);
    for (const m of w.sent) {
      assert.ok(ALLOWED_MESSAGES.some((re) => re.test(m.message)), 'unexpected message: ' + m.message);
      assert.ok(!m.message.includes(TOPIC));
      assert.ok(!/SECRET/.test(m.message));
    }
  }
});

test('the log has one line per check, only pass or fail with a short reason, never the topic, a body or a header', async () => {
  const w = makeWorld({ stored: okState(), snapshotAgeMs: 241_000 });
  w.health.body.holdings = 'SECRET-HOLDINGS-123';
  await watch(w.opts());
  const text = w.logs.join('\n');
  assert.ok(!text.includes(TOPIC));
  assert.ok(!/SECRET/.test(text));
  assert.ok(/snapshot: fail \(asOf 241 s old\)/.test(text));
  assert.ok(/^page: pass$/m.test(text));
  assert.ok(/^health: pass$/m.test(text));
  const checkLines = w.logs.filter((l) => /^(page|health|snapshot):/.test(l));
  assert.equal(checkLines.length, 6); // two looks, three checks each
  for (const l of checkLines) assert.match(l, /^(page|health|snapshot): (pass|fail \([^)]{1,60}\))$/);
});

test('the topic is never written to the log, not even when sending fails or the fetch throws', async () => {
  const w = makeWorld({ stored: okState(), page: 'throw', sendError: true });
  await watch(w.opts());
  assert.ok(!w.logs.join('\n').includes(TOPIC));
  assert.ok(!w.logs.join('\n').includes('fetch failed'));
});

// ---------- the sender ----------

test('the notification is a POST to ntfy.sh/<topic> with the message as the body and a short title', async () => {
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init });
    return new Response('{}', { status: 200 });
  };
  await sendNtfy({ fetch: fake, topic: TOPIC, message: 'PulseBoard: fixed, all fine since 20:41' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `https://ntfy.sh/${TOPIC}`);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.body, 'PulseBoard: fixed, all fine since 20:41');
  assert.equal(seen[0].init.headers.Title, 'PulseBoard');
});

test('a notification that ntfy refuses throws without the topic in the error', async () => {
  const fake = async () => new Response('nope', { status: 429 });
  await assert.rejects(
    sendNtfy({ fetch: fake, topic: TOPIC, message: 'x' }),
    (err) => !String(err.message).includes(TOPIC),
  );
});

// ---------- fix round 1 ----------

test('a fault that goes on, then a second thing breaks: one message naming both', async () => {
  const w = makeWorld({ stored: { state: 'page', since: '2026-10-22T20:13:00-05:00', checkedWeek: '2026-W43' }, page: { status: 500 } });
  w.health.body.store = 'error';
  w.t += 10 * MIN; // 20:23
  await watch(w.opts());
  assert.deepEqual(w.sent.map((s) => s.message), [
    'PulseBoard: the site is not answering and the database check failed (since 20:23)',
  ]);
  assert.equal(w.stored.state, 'page+health-store');
  assert.equal(w.stored.since, '2026-10-22T20:23:00-05:00');
  w.t += 10 * MIN;
  await watch(w.opts()); // same set: nothing new
  assert.equal(w.sent.length, 1);
});

test('three broken things are joined in check order', async () => {
  const w = makeWorld({ stored: okState(), page: { status: 500 }, snapshotAgeMs: 241_000 });
  w.health.body.signin = 'down';
  await watch(w.opts());
  assert.deepEqual(w.sent.map((s) => s.message), [
    'PulseBoard: the site is not answering and the sign-in check failed and prices on the site are 4 minutes old (since 20:13)',
  ]);
  assert.equal(w.stored.state, 'page+health-signin+snapshot-stale');
});

test('one thing mends while another stays broken: a message for the smaller set, never "fixed"', async () => {
  const w = makeWorld({ stored: { state: 'page+health-store', since: '2026-10-22T20:13:00-05:00', checkedWeek: '2026-W43' } });
  w.health.body.store = 'error';
  await watch(w.opts());
  assert.deepEqual(w.sent.map((s) => s.message), ['PulseBoard: the database check failed (since 20:13)']);
  assert.equal(w.stored.state, 'health-store');
});

test('"fixed" is never sent while a check fails: an outage followed by a different failure keeps the state', async () => {
  const stored = { state: 'page', since: '2026-10-22T20:13:00-05:00', checkedWeek: '2026-W43' };
  const w = makeWorld({ stored, page: { status: 500 } });
  w.onWait = (world) => { world.page = { status: 200 }; world.health.body.store = 'error'; };
  await watch(w.opts());
  assert.equal(w.sent.length, 0);
  assert.equal(w.stateWrites.length, 0);
  assert.deepEqual(w.stored, stored);
});

test('different faults of one check do not confirm each other (store first, sign-in second)', async () => {
  const w = makeWorld({ stored: okState() });
  w.health.body.store = 'error';
  w.onWait = (world) => { world.health.body.store = 'ok'; world.health.body.signin = 'down'; };
  await watch(w.opts());
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.stored, okState());
});

test('a fault seen once that clears on the second look, from an alerted state, is "fixed"', async () => {
  const w = makeWorld({ stored: { state: 'page', since: '2026-10-22T20:00:00-05:00', checkedWeek: '2026-W43' }, page: { status: 500 } });
  w.onWait = (world) => { world.page = { status: 200 }; };
  await watch(w.opts());
  assert.deepEqual(w.sent.map((s) => s.message), ['PulseBoard: fixed, all fine since 20:15']);
  assert.equal(w.stored.state, 'ok');
});

test('every request uses redirect "manual" and a 302 fails the check', async () => {
  const w = makeWorld({ page: { status: 302 } });
  const r = await runChecks({ fetch: w.fetch, now: w.now, timeoutMs: 50 });
  assert.equal(r.find((c) => c.name === 'page').ok, false);
  assert.equal(r.find((c) => c.name === 'page').reason, 'status 302');
  for (const status of [301, 307, 308]) {
    const x = makeWorld({ health: { status, body: {} }, snapshot: { status, source: 'coinbase', coins: [{}] } });
    const rr = await runChecks({ fetch: x.fetch, now: x.now, timeoutMs: 50 });
    assert.equal(rr.find((c) => c.name === 'health').ok, false);
    assert.equal(rr.find((c) => c.name === 'snapshot').ok, false);
  }
  for (const c of w.calls) assert.equal(c.redirect, 'manual');
});

test('the notification request uses redirect "manual" and a 302 answer is a failed send', async () => {
  const seen = [];
  const fake = async (url, init) => {
    seen.push(init);
    return new Response('', { status: 302 });
  };
  await assert.rejects(sendNtfy({ fetch: fake, topic: TOPIC, message: 'x' }));
  assert.equal(seen[0].redirect, 'manual');
});

test('an asOf in the future fails as snapshot; 60 s ahead is still allowed, 61 s is not', async () => {
  const ahead = (ms) => ({ status: 200, source: 'coinbase', coins: [{}], asOf: (t) => new Date(t + ms).toISOString() });
  const tomorrow = makeWorld({ snapshot: ahead(86_400_000) });
  const r = await runChecks({ fetch: tomorrow.fetch, now: tomorrow.now, timeoutMs: 50 });
  const s = r.find((c) => c.name === 'snapshot');
  assert.equal(s.ok, false);
  assert.equal(s.fault, 'snapshot');
  assert.equal(s.reason, 'asOf in the future');

  const edge = makeWorld({ snapshot: ahead(60_000) });
  const re = await runChecks({ fetch: edge.fetch, now: edge.now, timeoutMs: 50 });
  assert.equal(re.find((c) => c.name === 'snapshot').ok, true);

  const over = makeWorld({ snapshot: ahead(61_000) });
  const ro = await runChecks({ fetch: over.fetch, now: over.now, timeoutMs: 50 });
  assert.equal(ro.find((c) => c.name === 'snapshot').reason, 'asOf in the future');
});

test('a failed send keeps the state but moves checkedWeek, and the run still fails', async () => {
  const w = makeWorld({ stored: okState('2026-W42'), page: { status: 500 }, sendError: true });
  const r = await watch(w.opts());
  assert.equal(r.ok, false);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.stored, { state: 'ok', since: '2026-10-22T08:00:00-05:00', checkedWeek: '2026-W43' });
  assert.equal(w.stateWrites.length, 1);
});

test('a failed send in the same week writes nothing', async () => {
  const w = makeWorld({ stored: okState(), page: { status: 500 }, sendError: true });
  await watch(w.opts());
  assert.equal(w.stateWrites.length, 0);
});

test('the real sender: with no send passed, a confirmed fault is POSTed to ntfy.sh/<topic>', async () => {
  const w = makeWorld({ stored: okState(), page: { status: 500 } });
  const o = w.opts();
  delete o.send;
  const r = await watch(o);
  assert.equal(r.ok, true);
  assert.equal(w.ntfyCalls.length, 1);
  assert.equal(w.ntfyCalls[0].url, `https://ntfy.sh/${TOPIC}`);
  assert.equal(w.ntfyCalls[0].init.method, 'POST');
  assert.equal(w.ntfyCalls[0].init.body, 'PulseBoard: the site is not answering (since 20:13)');
});

test('the real sender: ntfy answering 500 fails the run', async () => {
  const w = makeWorld({ stored: okState(), page: { status: 500 }, ntfyStatus: 500 });
  const o = w.opts();
  delete o.send;
  const r = await watch(o);
  assert.equal(r.ok, false);
  assert.deepEqual(w.stored, okState());
});

test('every log line is one of the known forms and none holds the topic', async () => {
  const known = [
    /^(page|health|snapshot): pass$/,
    /^(page|health|snapshot): fail \([^)]{1,60}\)$/,
    /^a check failed; second look in 2 minutes$/,
    /^notify: sent$/,
    /^notify: fail \(could not send\)$/,
    /^would send: (nothing|PulseBoard: .+)$/,
    /^state would be: [a-z+-]+ \(dry run, nothing saved\)$/,
    /^error: NTFY_TOPIC is not set; nothing was checked and nothing was sent$/,
  ];
  const runs = [
    async () => { const w = makeWorld({ stored: okState() }); await watch(w.opts()); return w; },
    async () => { const w = makeWorld({ stored: okState(), page: { status: 500 } }); w.health.body.store = 'error'; await watch(w.opts()); return w; },
    async () => { const w = makeWorld({ stored: okState(), page: 'throw', sendError: true }); await watch(w.opts()); return w; },
    async () => { const w = makeWorld({ stored: okState(), page: 'hang' }); await watch(w.opts({ timeoutMs: 20 })); return w; },
    async () => { const w = makeWorld({ stored: okState(), page: { status: 500 } }); await watch(w.opts({ dryRun: true })); return w; },
    async () => { const w = makeWorld({ stored: okState() }); await watch(w.opts({ env: {} })); return w; },
  ];
  for (const run of runs) {
    const w = await run();
    assert.ok(w.logs.length > 0);
    for (const line of w.logs) {
      assert.ok(known.some((re) => re.test(line)), 'unknown log line: ' + line);
      assert.ok(!line.includes(TOPIC));
    }
  }
});

// ---------- the workflow and package files ----------

const watchYml = () => fs.readFileSync(new URL('./.github/workflows/watch.yml', import.meta.url), 'utf8');

test('watch.yml checks out main, so a queued run reads the state the run before it committed', () => {
  assert.match(watchYml(), /uses: actions\/checkout@v5\s+with:\s+ref: main/);
});

test('watch.yml retries pull and push three times, 5 seconds apart, and fails if all fail', () => {
  const y = watchYml();
  assert.match(y, /for attempt in 1 2 3/);
  assert.match(y, /git pull --rebase/);
  assert.match(y, /git push/);
  assert.match(y, /sleep 5/);
  assert.match(y, /exit 1/);
});

test('watch.yml saves the state even when the check step failed, so the weekly keep-alive survives an ntfy outage', () => {
  assert.match(watchYml(), /name: Save the state[^\n]*\n\s+if: \$\{\{ !cancelled\(\) \}\}/);
});

test('package.json says Node 20.11 or newer, as watch.mjs does', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '>=20.11');
  assert.match(fs.readFileSync(new URL('./watch.mjs', import.meta.url), 'utf8').split('\n')[0], /Node 20\.11\+/);
});
