export const DEFAULT_PUSH_DEBOUNCE_MS = 4_000;
export const DEFAULT_ACTIVE_PULL_MS = 10 * 60_000;
export const DEFAULT_IDLE_PULL_MS = 15 * 60_000;

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
    if (!online || !visible || pushInFlight || !pushQueued) return false;
    pushInFlight = true;
    pushQueued = false;
    try {
      await onPush();
      return true;
    } catch (error) {
      pushQueued = true;
      reportError(error, "push");
      return false;
    } finally {
      pushInFlight = false;
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

  const schedulePush = () => {
    clearPushTimer();
    if (!online || !visible || !pushQueued) return;
    pushTimer = setTimeoutFn(() => {
      pushTimer = null;
      return runPush();
    }, pushDelay);
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

    setOnline(nextOnline) {
      online = !!nextOnline;
      if (!online) {
        clearPushTimer();
        clearPullTimer();
      } else {
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
