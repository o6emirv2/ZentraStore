"use strict";

// A shared quota gate prevents independent background loops from exhausting a
// recovering database. Durable work remains in Firestore and is never discarded.
let quotaUntil = 0;
let quotaFailures = 0;
function quotaError(error) {
  return ["8", "resource-exhausted", "RESOURCE_EXHAUSTED"].includes(
    String(error?.code || ""),
  );
}
function createWorker({
  run,
  onError,
  idleMs = 60_000,
  activeMs = 1500,
  clock = Date.now,
  random = Math.random,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let timer = null,
    enabled = false,
    running = false,
    failures = 0,
    errorCode = "";
  const jitter = (value) => Math.ceil(value * (1 + random() * 0.15));
  const queue = (delay) => {
    if (!enabled) return;
    cancel(timer);
    timer = schedule(tick, Math.max(delay, quotaUntil - clock(), 0));
    timer?.unref?.();
  };
  async function tick() {
    if (!enabled || running) return;
    if (quotaUntil > clock()) return queue(quotaUntil - clock());
    running = true;
    let next = idleMs;
    try {
      const count = await run();
      failures = 0;
      errorCode = "";
      if (quotaUntil && quotaUntil <= clock()) {
        quotaUntil = 0;
        quotaFailures = 0;
      }
      next = Number(count) > 0 ? activeMs : idleMs;
    } catch (error) {
      failures += 1;
      const code = String(error?.code || "WORKER_FAILED");
      if (quotaError(error)) {
        quotaFailures += 1;
        quotaUntil =
          clock() +
          jitter(
            Math.min(3_600_000, 900_000 * 2 ** Math.min(quotaFailures - 1, 2)),
          );
        next = quotaUntil - clock();
      } else
        next = jitter(
          Math.min(900_000, idleMs * 2 ** Math.min(failures - 1, 4)),
        );
      if (errorCode !== code) onError?.(error, { retryAfterMs: next });
      errorCode = code;
    } finally {
      running = false;
      queue(next);
    }
  }
  return {
    start() {
      if (enabled) return;
      enabled = true;
      queue(1000);
    },
    wake() {
      if (enabled && !running) queue(20);
    },
    stop() {
      enabled = false;
      cancel(timer);
    },
    status() {
      return { enabled, running, failures, quotaUntil, errorCode };
    },
  };
}
module.exports = { createWorker, quotaError };
