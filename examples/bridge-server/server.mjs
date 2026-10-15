#!/usr/bin/env node
// A minimal Offdesk bridge server (docs/agent-bridge-protocol.md): a hub dials in, and
// this prints its agent runs as they change and can answer them or start agents, as far
// as the person allowed on the hub. A starting point for your own, and what the hub's
// bridge is tested against.
//
//   npm install && node server.mjs            # prints a pairing code
//   offdesk bridges add mine ws://127.0.0.1:8790/bridge --code <code> --scope runs:read,runs:answer
//
// Control it over HTTP on the same port (from this machine only):
//   GET  /state                     hubs, machines, runs, recent events
//   POST /pairing-code              a new one-time code (10 minutes)
//   POST /answer  {run_id, option_id? | text? | approve?}   answers the run's open request
//   POST /start   {machine_id, agent, cwd, prompt?, label?}
//
// State (paired hubs, what each acknowledged) is kept in bridge-data.json, so a restart
// of this server resumes where it was.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 8790);
const host = process.env.HOST ?? "127.0.0.1";
const dataFile = process.env.DATA ?? "bridge-data.json";
const PAIRING_MINUTES = 10;
const COMMAND_TIMEOUT_MS = 15_000;

/** Paired hubs: hub_id → { keyHash, acked }. */
const data = existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, "utf8")) : { hubs: {} };
const save = () => writeFileSync(dataFile, JSON.stringify(data, null, 2));
const sha256 = (text) => createHash("sha256").update(text).digest();

const codes = new Map(); // code → expires at (ms)
function newCode() {
  const raw = randomBytes(5).toString("hex").toUpperCase();
  const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  codes.set(code, Date.now() + PAIRING_MINUTES * 60_000);
  console.log(`Pairing code: ${code} (single use, ${PAIRING_MINUTES} minutes)`);
  return code;
}

const live = { socket: null, hubId: null, machines: [], runs: new Map(), events: [], duplicates: 0 };
const pending = new Map(); // command_id → resolve

function accept(req) {
  const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const hubId = req.headers["x-offdesk-hub"];
  const code = req.headers["x-offdesk-pairing-code"];
  if (!key || !hubId) return false;
  if (code) {
    const expires = codes.get(code);
    if (!expires || expires < Date.now()) return false;
    codes.delete(code); // single use
    data.hubs[hubId] = { keyHash: sha256(key).toString("hex"), acked: 0 };
    save();
    console.log(`Paired hub ${hubId}`);
    return true;
  }
  const hub = data.hubs[hubId];
  if (!hub) return false;
  const given = sha256(key);
  const stored = Buffer.from(hub.keyHash, "hex");
  return given.length === stored.length && timingSafeEqual(given, stored);
}

function describe(run) {
  const asks = run.request ? ` · waits: ${run.request.prompt ?? run.request.kind}` : "";
  return `${run.agent} ${run.status} in ${run.cwd}${asks}`;
}

function onMessage(socket, hubId, message) {
  switch (message.type) {
    case "hello":
      console.log(`Hub ${message.hub_id} (Offdesk ${message.hub_version}, protocol ${message.protocol}) may: ${message.access.scopes.join(", ")}`);
      break;
    case "snapshot":
      live.machines = message.machines;
      live.runs = new Map(message.runs.map((run) => [run.id, run]));
      console.log(`Snapshot: ${message.machines.length} machine(s), ${message.runs.length} run(s)`);
      for (const run of message.runs) console.log(`  ${run.id.slice(0, 8)} ${describe(run)}`);
      break;
    case "event": {
      const hub = data.hubs[hubId];
      // At least once: a seq already stored is a repeat after a reconnect
      if (message.seq <= hub.acked) {
        live.duplicates += 1;
      } else {
        const { type, data: body } = message.event;
        if (body?.run) live.runs.set(body.run.id, body.run);
        if (body?.machine && type.startsWith("machine.")) {
          live.machines = live.machines.filter((m) => m.id !== body.machine.id).concat([{ ...body.machine }]);
        }
        live.events.push({ seq: message.seq, type, run: body?.run?.id });
        if (live.events.length > 200) live.events.shift();
        console.log(`#${message.seq} ${type}${body?.run ? ` ${body.run.id.slice(0, 8)} ${describe(body.run)}` : ""}`);
        hub.acked = message.seq;
        save();
      }
      socket.send(JSON.stringify({ type: "ack", seq: message.seq }));
      break;
    }
    case "result":
      pending.get(message.command_id)?.(message);
      pending.delete(message.command_id);
      console.log(`Result ${message.command_id}: ${message.ok ? "ok" : `refused (${message.status}): ${message.error}`}`);
      break;
    case "ping":
      socket.send(JSON.stringify({ type: "pong" }));
      break;
  }
}

function command(body) {
  if (!live.socket) return Promise.resolve({ ok: false, error: "no hub connected" });
  const command_id = `cmd_${randomBytes(8).toString("hex")}`;
  live.socket.send(JSON.stringify({ ...body, command_id }));
  return new Promise((resolve) => {
    pending.set(command_id, resolve);
    setTimeout(() => {
      if (pending.delete(command_id)) resolve({ ok: false, error: "the hub didn't answer in time" });
    }, COMMAND_TIMEOUT_MS);
  });
}

const http = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value, null, 2));
  };
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = body ? JSON.parse(body) : {};
  if (req.method === "GET" && req.url === "/state") {
    return reply(200, {
      connected: live.hubId,
      paired: Object.keys(data.hubs),
      machines: live.machines,
      runs: [...live.runs.values()],
      events: live.events,
      duplicates: live.duplicates,
    });
  }
  if (req.method === "POST" && req.url === "/pairing-code") return reply(200, { code: newCode() });
  if (req.method === "POST" && req.url === "/answer") {
    const run = live.runs.get(input.run_id);
    const request_id = input.request_id ?? run?.request?.id;
    if (!request_id) return reply(409, { ok: false, error: "that run isn't waiting on anything" });
    const { run_id, option_id, text, approve } = input;
    return reply(200, await command({ type: "answer", run_id, request_id, option_id, text, approve }));
  }
  if (req.method === "POST" && req.url === "/start") return reply(200, await command({ type: "start", ...input }));
  reply(404, { error: "GET /state, POST /pairing-code, /answer or /start" });
});

const wss = new WebSocketServer({ noServer: true });
http.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/bridge") || !accept(req)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  const hubId = req.headers["x-offdesk-hub"];
  wss.handleUpgrade(req, socket, head, (ws) => {
    live.socket?.close();
    live.socket = ws;
    live.hubId = hubId;
    console.log(`Hub ${hubId} connected`);
    ws.on("message", (raw) => onMessage(ws, hubId, JSON.parse(raw.toString())));
    ws.on("close", () => {
      if (live.socket === ws) {
        live.socket = null;
        live.hubId = null;
      }
      console.log(`Hub ${hubId} disconnected`);
    });
  });
});

http.listen(port, host, () => {
  console.log(`Offdesk bridge server on ws://${host}:${port}/bridge (control: http://${host}:${port}/state)`);
  newCode();
});
