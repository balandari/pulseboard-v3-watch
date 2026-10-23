# PulseBoard watch

A small free watcher that keeps an eye on [thepulseboard.io](https://thepulseboard.io) and sends one phone notification when something breaks, and one when it is fixed. Nothing else.

## What it checks

Every 10 minutes (at 3, 13, 23, 33, 43 and 53 minutes past the hour) a GitHub job asks three addresses, with plain GET requests:

1. The page itself (`/`) answers 200.
2. `/api/health` answers 200 and says the database store is `ok` and sign-in is `ready`.
3. `/api/crypto/snapshot` answers 200, comes from `coinbase`, has at least one coin, and its prices are less than 60 seconds old.

A request that takes longer than 15 seconds, or cannot connect, counts as a failure. If any check fails, the job waits two minutes and looks again. Only a fault seen both times counts, so a short hiccup stays quiet.

## What a message looks like

All times are Central.

- `PulseBoard: the site is not answering (since 20:13)`
- `PulseBoard: the database check failed (since 20:13)`
- `PulseBoard: prices on the site are 4 minutes old (since 20:13)`
- `PulseBoard: fixed, all fine since 20:41`

You get one message when a fault is confirmed, one more if what is broken changes, and one when everything passes again. While nothing changes, nothing is sent.

## The topic is a secret

Messages go to `https://ntfy.sh/<topic>`. Anyone who knows the topic name can read the messages, so it is stored as the GitHub secret `NTFY_TOPIC` (Settings, Secrets and variables, Actions). It is never in the code, the logs or this page. If `NTFY_TOPIC` is missing, the run stops with a clear line in the log and sends nothing.

## Run it by hand

On GitHub: Actions, then "watch", then "Run workflow".

On your own computer, a safe test that checks the live site and sends nothing:

```
node watch.mjs --dry-run
```

The tests need no network: `node --test`.

## Stop it

On GitHub: Actions, then "watch", then the three dots, then "Disable workflow".

## What it keeps

`state.json` holds only words and times: `ok` or a short name of what broke, since when, and the ISO week of the last run. The job commits it when it changes, and once a week so GitHub does not switch off the schedule in a quiet public repository.

It holds nothing of anyone's holdings, accounts or sign-ins. The logs say only which checks passed or failed.
