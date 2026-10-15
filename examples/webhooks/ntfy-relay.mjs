#!/usr/bin/env node
// Turns Offdesk agent run webhooks into ntfy notifications (https://ntfy.sh).
//
//   OFFDESK_WEBHOOK_SECRET=whsec_… NTFY_URL=https://ntfy.sh/your-topic node ntfy-relay.mjs
//
// Then add a webhook in Offdesk pointing at this script (default http://<host>:8787/),
// e.g. with the events run.request and run.ended. It checks every request's
// Standard Webhooks signature, drops repeats, and posts a short message to ntfy.
// No dependencies; Node 18 or newer.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const secret = process.env.OFFDESK_WEBHOOK_SECRET;
const ntfyUrl = process.env.NTFY_URL;
const port = Number(process.env.PORT ?? 8787);
if (!secret?.startsWith("whsec_") || !ntfyUrl) {
  console.error("Set OFFDESK_WEBHOOK_SECRET (whsec_…) and NTFY_URL (https://ntfy.sh/<topic>)");
  process.exit(1);
}
const key = Buffer.from(secret.slice("whsec_".length), "base64");
const TOLERANCE_SECONDS = 5 * 60;
const seen = new Set();

/** Standard Webhooks: HMAC-SHA256 of `<id>.<timestamp>.<body>`, base64, as `v1,<sig>`. */
function verified(headers, body) {
  const id = headers["webhook-id"];
  const timestamp = Number(headers["webhook-timestamp"]);
  const signatures = String(headers["webhook-signature"] ?? "").split(" ");
  if (!id || !Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signatures.some((signature) => {
    const [version, value] = signature.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** A title and message for an event, or null to stay quiet. */
function describe(event) {
  if (event.type === "integration.test") {
    return { title: "Offdesk", message: `Test from ${event.data.integration}`, priority: "low" };
  }
  const run = event.data?.run;
  if (!run) return null;
  const where = `${run.agent} · ${event.data.machine?.name ?? run.machine_id} · ${run.cwd}`;
  switch (event.type) {
    case "run.request":
      // The question shows when the webhook's content level is "requests" or "notes"
      return {
        title: `${run.agent} waits on you`,
        message: `${run.request?.prompt ?? run.request?.kind ?? "a request"}\n${where}`,
        priority: "high",
      };
    case "run.ended":
      return {
        title: `${run.agent} ${run.status}`,
        message: `${run.report?.text || run.label || "finished"}\n${where}`,
        priority: "default",
      };
    default:
      return { title: `${run.agent}: ${event.type.replace("run.", "")}`, message: where, priority: "low" };
  }
}

createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on("end", async () => {
    if (!verified(req.headers, body)) {
      res.writeHead(401).end();
      return;
    }
    const id = req.headers["webhook-id"];
    // Offdesk delivers at least once: the same id again is a retry
    if (seen.has(id)) {
      res.writeHead(204).end();
      return;
    }
    const note = describe(JSON.parse(body));
    if (note) {
      const sent = await fetch(ntfyUrl, {
        method: "POST",
        headers: { Title: note.title, Priority: note.priority },
        body: note.message,
      }).catch(() => null);
      // Not delivered: Offdesk retries later
      if (!sent?.ok) {
        res.writeHead(502).end();
        return;
      }
    }
    seen.add(id);
    if (seen.size > 10_000) seen.delete(seen.values().next().value);
    res.writeHead(204).end();
  });
}).listen(port, () => console.log(`Relaying Offdesk webhooks on :${port} to ${ntfyUrl}`));
