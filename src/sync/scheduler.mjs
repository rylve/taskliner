export const DEFAULT_PUSH_DEBOUNCE_MS = 4_000;
export const DEFAULT_PUSH_RETRY_BASE_MS = 30_000;
export const DEFAULT_PUSH_RETRY_MAX_MS = 5 * 60_000;
export const DEFAULT_ACTIVE_PULL_MS = 10 * 60_000;
export const DEFAULT_IDLE_PULL_MS = 15 * 60_000;

export function createSyncOperationQueue() {
  let tail = Promise.resolve();
  return {
    run(operation) {
      if (typeof operation !== "function") throw new TypeError("A sync operation must be a function");
      const current = tail.then(operation, operation);
      tail = current.catch(() => undefined);
      return current;
    },
  };
}

function asDelay(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * Schedule local changes and remote pulls without knowing how transport works.
 * The callbacks are intentionally injected so OAuth and Drive remain outside
 * the local editing path.
 */
export function createSyncScheduler({
  onPush = async () => undefined,
  onPull = async () => undefined,
  onError = () => undefined,
  pushDebounceMs = DEFAULT_PUSH_DEBOUNCE_MS,
  pushRetryBaseMs = DEFAULT_PUSH_RETRY_BASE_MS,
  pushRetryMaxMs = DEFAULT_PUSH_RETRY_MAX_MS,
  activePullMs = DEFAULT_ACTIVE_PULL_MS,
  idlePullMs = DEFAULT_IDLE_PULL_MS,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  now = () => Date.now(),
} = {}) {
  if (typeof onPush !== "function" || typeof onPull !== "function") {
    throw new TypeError("Sync scheduler callbacks must be functions");
  }
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("Sync scheduler requires timer functions");
  }

  const pushDelay = asDelay(pushDebounceMs, DEFAULT_PUSH_DEBOUNCE_MS);
  const pushRetryBaseDelay = asDelay(pushRetryBaseMs, DEFAULT_PUSH_RETRY_BASE_MS);
  const pushRetryMaxDelay = Math.max(pushRetryBaseDelay, asDelay(pushRetryMaxMs, DEFAULT_PUSH_RETRY_MAX_MS));
  const activeDelay = asDelay(activePullMs, DEFAULT_ACTIVE_PULL_MS);
  const idleDelay = asDelay(idlePullMs, DEFAULT_IDLE_PULL_MS);
  let pushTimer = null;
  let pullTimer = null;
  let running = false;
  let online = true;
  let visible = true;
  let realtimeConnected = false;
  let pushQueued = false;
  let lastPullAt = null;
  let pullInFlight = false;
  let pushInFlight = false;
  let pushFailureCount = 0;

  const pushRetryDelay = () => Math.min(
    pushRetryMaxDelay,
    pushRetryBaseDelay * (2 ** Math.max(0, pushFailureCount - 1)),
  );

  const reportError = (error, phase) => {
    try {
      onError(error, phase);
    } catch {
      // Error reporting must not stop the scheduler.
    }
  };

  const clearPushTimer = () => {
    if (pushTimer !== null) clearTimeoutFn(pushTimer);
    pushTimer = null;
  };

  const clearPullTimer = () => {
    if (pullTimer !== null) clearTimeoutFn(pullTimer);
    pullTimer = null;
  };

  const runPush = async () => {
    if (!running || !online || !visible || pushInFlight || !pushQueued) return false;
    pushInFlight = true;
    pushQueued = false;
    let rescheduleDelay = pushDelay;
    try {
      const completed = await onPush();
      if (completed === false) pushQueued = true;
      pushFailureCount = 0;
      return completed !== false;
    } catch (error) {
      pushQueued = true;
      pushFailureCount += 1;
      rescheduleDelay = pushRetryDelay();
      reportError(error, "push");
      return false;
    } finally {
      pushInFlight = false;
      if (pushQueued) schedulePush(rescheduleDelay);
    }
  };

  const runPull = async () => {
    if (!online || !visible || pullInFlight) return false;
    pullInFlight = true;
    try {
      await onPull();
      lastPullAt = now();
      return true;
    } catch (error) {
      reportError(error, "pull");
      return false;
    } finally {
      pullInFlight = false;
    }
  };

  const schedulePull = () => {
    clearPullTimer();
    if (!running || !online || !visible || realtimeConnected) return;
    pullTimer = setTimeoutFn(() => {
      pullTimer = null;
      return runPull().finally(schedulePull);
    }, visible ? activeDelay : idleDelay);
  };

  const schedulePush = (delay = pushFailureCount > 0 ? pushRetryDelay() : pushDelay) => {
    clearPushTimer();
    if (!running || !online || !visible || !pushQueued) return;
    pushTimer = setTimeoutFn(() => {
      pushTimer = null;
      return runPush();
    }, delay);
  };

  return {
    start() {
      running = true;
      schedulePull();
      schedulePush();
      return this.getStatus();
    },

    stop() {
      running = false;
      clearPushTimer();
      clearPullTimer();
      return this.getStatus();
    },

    noteLocalChange() {
      pushQueued = true;
      schedulePush();
      return this.getStatus();
    },

    clearLocalChanges() {
      pushQueued = false;
      pushFailureCount = 0;
      clearPushTimer();
      return this.getStatus();
    },

    setOnline(nextOnline) {
      online = !!nextOnline;
      if (!online) {
        clearPushTimer();
        clearPullTimer();
      } else {
        pushFailureCount = 0;
        schedulePush();
        schedulePull();
      }
      return this.getStatus();
    },

    setVisible(nextVisible) {
      visible = !!nextVisible;
      if (!visible) {
        clearPushTimer();
        clearPullTimer();
        return this.getStatus();
      }
      schedulePush();
      schedulePull();
      return this.getStatus();
    },

    setRealtimeConnected(nextConnected) {
      const connected = !!nextConnected;
      if (connected === realtimeConnected) return this.getStatus();
      realtimeConnected = connected;
      schedulePull();
      return this.getStatus();
    },

    async syncNow() {
      if (!online) return false;
      clearPullTimer();
      await runPull();
      await runPush();
      schedulePull();
      return true;
    },

    getStatus() {
      return {
        running,
        online,
        visible,
        realtimeConnected,
        pushQueued,
        lastPullAt,
        pushInFlight,
        pullInFlight,
      };
    },
  };
}
