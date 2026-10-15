# Webhooks

A webhook sends agent run events (a run started, it waits on you, it ended…) as
signed JSON POSTs to a URL you choose: your own service, a notifier such as ntfy,
or a task system. It only tells; it can't answer or start anything.

Add one in **Settings › Webhooks** (name, URL, events, what it sees) or with the API
below. The signing secret (`whsec_…`) is shown once, when you add it.

## Events

| Type | When |
|---|---|
| `run.started` | A coding agent run opened (detected in a terminal, or started from the hub) |
| `run.request` | It waits on you: an approval, a question, or input |
| `run.request_resolved` | That request was answered or went away |
| `run.status` | Its status changed otherwise (working, idle…) |
| `run.progress` | Its task list moved (e.g. 3 of 7) |
| `run.report` | It reported a note, that it's blocked, or that it finished |
| `run.ended` | It ended: done, error, or gone |
| `integration.test` | You pressed Test |

A webhook gets the types you chose (all of them when none are chosen). The default in
Settings is `run.request` and `run.ended`.

## The request

```
POST <your URL>
content-type: application/json
webhook-id: msg_2f6c…            same on every retry of this event
webhook-timestamp: 1792050000    seconds
webhook-signature: v1,<base64>   HMAC-SHA256 of "<id>.<timestamp>.<body>"

{
  "type": "run.request",
  "timestamp": "2026-10-15T10:12:30.511Z",
  "data": {
    "seq": 3,
    "run": { "id": "…", "agent": "claude", "status": "waiting", "cwd": "~/work/shop",
             "request": { "id": "…", "kind": "question", "options": [] }, … },
    "machine": { "id": "…", "name": "studio" }
  }
}
```

`data.run` is the same run object as `GET /api/agent-runs/{id}`, cut to the webhook's
content level:

- **status only** (`metadata`): status, agent, folder, machine, times, label, reference.
- **what they ask** (`requests`): also a request's text and options.
- **their notes** (`notes`): also the agent's reports and the step it's on.

Terminal output is never sent.

## Checking it

The signature follows [Standard Webhooks](https://www.standardwebhooks.com/), so their
libraries verify it as is (`new Webhook(secret).verify(body, headers)`). By hand: take
the base64 after `whsec_` as the key, compute HMAC-SHA256 over
`<webhook-id>.<webhook-timestamp>.<raw body>`, base64 it, and compare with the part
after `v1,` (in constant time). Refuse timestamps more than a few minutes off.

## Delivery

- At least once: events wait in the hub's database until your URL answers 2xx, and a
  hub restart loses none. Drop repeats by `webhook-id`.
- `data.seq` counts the events of one run, so you can put them in order. A webhook that
  filters events sees gaps in it.
- Failures are retried after 5 s, 10 s, 20 s… up to an hour apart, for 24 hours; then
  the event is given up on. Settings shows the last error.
- Redirects aren't followed. A request has 10 seconds.
- Turning a webhook off stops new events for it (what waits is kept); removing it
  drops what waits.

## Example: ntfy

`examples/webhooks/ntfy-relay.mjs` turns events into [ntfy](https://ntfy.sh)
notifications, checking each signature and dropping repeats:

```
OFFDESK_WEBHOOK_SECRET=whsec_… NTFY_URL=https://ntfy.sh/<your-topic> node examples/webhooks/ntfy-relay.mjs
```

Then add a webhook pointing at `http://<that machine>:8787/` with "Waits on you" and
"Ended". With "what they ask", the notification shows the question.

## API

People and full-access tokens only:

- `GET /api/integrations`: webhooks, without their secrets.
- `POST /api/integrations` `{ name, url, events?, content?, machines?, include_production? }`:
  returns `{ integration, secret }`.
- `PATCH /api/integrations/{id}` `{ enabled }`, `DELETE /api/integrations/{id}`.
- `POST /api/integrations/{id}/test`: sends `integration.test`.
- `GET /api/integrations/{id}/deliveries`: recent deliveries and their errors.
