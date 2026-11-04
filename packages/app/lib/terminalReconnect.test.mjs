import test from "node:test";
import assert from "node:assert/strict";

import { createTerminalReconnectController } from "./terminalReconnect.ts";

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();

  return {
    schedule(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    run(id) {
      const timer = timers.get(id);
      if (!timer) {
        return;
      }
      timers.delete(id);
      timer.callback();
    },
    ids() {
      return Array.from(timers.keys());
    },
    delayFor(id) {
      return timers.get(id)?.delayMs ?? null;
    },
  };
}

test("socket closes schedule a single reconnect until it fires", () => {
  const timers = createFakeTimers();
  const reconnects = [];
  const controller = createTerminalReconnectController({
    delayMs: 1000,
    openReadyState: 1,
    onReconnect: () => reconnects.push("reconnect"),
    schedule: (callback, delayMs) => timers.schedule(callback, delayMs),
    cancel: (timerId) => timers.cancel(timerId),
  });

  controller.scheduleReconnect();
  controller.scheduleReconnect();

  assert.deepEqual(timers.ids().length, 1);
  const [timerId] = timers.ids();
  assert.equal(timers.delayFor(timerId), 1000);

  timers.run(timerId);

  assert.deepEqual(reconnects, ["reconnect"]);
  assert.equal(controller.hasPendingReconnect(), false);
});

test("visible pages only reconnect when the socket is no longer open", () => {
  const timers = createFakeTimers();
  const controller = createTerminalReconnectController({
    delayMs: 250,
    openReadyState: 1,
    onReconnect: () => {},
    schedule: (callback, delayMs) => timers.schedule(callback, delayMs),
    cancel: (timerId) => timers.cancel(timerId),
  });

  controller.handleVisibilityChange("visible", 1);

  assert.deepEqual(timers.ids(), []);

  controller.handleVisibilityChange("visible", 3);

  assert.equal(timers.ids().length, 1);
});

test("pages reconnect after being hidden even when the socket still reports open", () => {
  const timers = createFakeTimers();
  const controller = createTerminalReconnectController({
    delayMs: 250,
    openReadyState: 1,
    onReconnect: () => {},
    schedule: (callback, delayMs) => timers.schedule(callback, delayMs),
    cancel: (timerId) => timers.cancel(timerId),
  });

  controller.handleVisibilityChange("hidden", 1);
  controller.handleVisibilityChange("visible", 1);

  assert.equal(timers.ids().length, 1);
});

test("socket open cancels any pending reconnect", () => {
  const timers = createFakeTimers();
  const controller = createTerminalReconnectController({
    delayMs: 250,
    openReadyState: 1,
    onReconnect: () => {},
    schedule: (callback, delayMs) => timers.schedule(callback, delayMs),
    cancel: (timerId) => timers.cancel(timerId),
  });

  controller.scheduleReconnect();
  assert.equal(controller.hasPendingReconnect(), true);

  controller.handleSocketOpen();

  assert.equal(controller.hasPendingReconnect(), false);
  assert.deepEqual(timers.ids(), []);
});

function createController(timers, options = {}) {
  return createTerminalReconnectController({
    delayMs: 1000,
    resumeDelayMs: 0,
    openReadyState: 1,
    onReconnect: () => {},
    schedule: (callback, delayMs) => timers.schedule(callback, delayMs),
    cancel: (timerId) => timers.cancel(timerId),
    ...options,
  });
}

test("returning to the foreground reconnects with the resume delay", () => {
  const timers = createFakeTimers();
  const controller = createController(timers);

  controller.handleVisibilityChange("hidden", 1);
  controller.handleVisibilityChange("visible", 1);

  const [timerId] = timers.ids();
  assert.equal(timers.ids().length, 1);
  assert.equal(timers.delayFor(timerId), 0);
});

test("a visible page with a socket that is not open reconnects with the resume delay", () => {
  const timers = createFakeTimers();
  const controller = createController(timers);

  controller.handleVisibilityChange("visible", 3);

  const [timerId] = timers.ids();
  assert.equal(timers.delayFor(timerId), 0);
});

test("socket-close reconnects keep the close delay", () => {
  const timers = createFakeTimers();
  const controller = createController(timers);

  controller.scheduleReconnect();

  const [timerId] = timers.ids();
  assert.equal(timers.delayFor(timerId), 1000);
});

test("the resume delay defaults to the close delay", () => {
  const timers = createFakeTimers();
  const controller = createController(timers, { resumeDelayMs: undefined });

  controller.handleVisibilityChange("hidden", 1);
  controller.handleVisibilityChange("visible", 1);

  const [timerId] = timers.ids();
  assert.equal(timers.delayFor(timerId), 1000);
});

test("resuming shortens a pending close reconnect to the resume delay", () => {
  const timers = createFakeTimers();
  const reconnects = [];
  const controller = createController(timers, {
    onReconnect: () => reconnects.push("reconnect"),
  });

  controller.scheduleReconnect();
  controller.handleVisibilityChange("hidden", 3);
  controller.handleVisibilityChange("visible", 3);

  assert.equal(timers.ids().length, 1);
  const [timerId] = timers.ids();
  assert.equal(timers.delayFor(timerId), 0);

  timers.run(timerId);
  assert.deepEqual(reconnects, ["reconnect"]);
  assert.equal(controller.hasPendingReconnect(), false);
});

test("a socket close does not lengthen a pending resume reconnect", () => {
  const timers = createFakeTimers();
  const controller = createController(timers);

  controller.handleVisibilityChange("hidden", 1);
  controller.handleVisibilityChange("visible", 1);
  controller.scheduleReconnect();

  assert.equal(timers.ids().length, 1);
  const [timerId] = timers.ids();
  assert.equal(timers.delayFor(timerId), 0);
});
