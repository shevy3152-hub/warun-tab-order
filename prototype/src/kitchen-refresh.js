export const KITCHEN_REFRESH_TIMEOUT_MS = 10_000;

// One active read and one shared trailing request per kitchen-screen lifetime.
// New invalidations do not invalidate a usable, slower-than-poll response.
export function createKitchenRefresher({
  load, onData, onError,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  AbortControllerImpl = globalThis.AbortController,
  timeoutMs = KITCHEN_REFRESH_TIMEOUT_MS,
}) {
  let stopped = false;
  let authorizationError = null;
  let active = null;
  let queued = null;
  let suppressionVersion = 0;
  let appliedSuppressionVersion = 0;
  const stoppedError = () => Object.assign(new Error("Kitchen refresh stopped."), { code: "CANCELLED" });
  const pump = () => {
    if (stopped || authorizationError || active || !queued) return;
    const batch = queued;
    queued = null;
    active = batch;
    const requestSuppressionVersion = suppressionVersion;
    const controller = typeof AbortControllerImpl === "function" ? new AbortControllerImpl() : null;
    let timer;
    const cancelled = new Promise((_, reject) => { batch.cancel = () => reject(stoppedError()); });
    const timeout = new Promise((_, reject) => {
      timer = setTimeoutImpl(() => {
        reject(Object.assign(new Error("Kitchen refresh timed out."), { code: "TIMEOUT" }));
        controller?.abort();
      }, timeoutMs);
    });
    void (async () => {
      try {
        const data = await Promise.race([
          Promise.resolve().then(() => {
            if (stopped) throw stoppedError();
            return load({ signal: controller?.signal });
          }),
          timeout, cancelled,
        ]);
        if (stopped) throw stoppedError();
        onData(data, { suppressStaffCalls: suppressionVersion !== appliedSuppressionVersion });
        // A reconnect during this read also needs a post-reconnect baseline.
        appliedSuppressionVersion = requestSuppressionVersion;
        batch.resolve(data);
      } catch (error) {
        if (!stopped) {
          suppressionVersion++;
          if ([401, 403].includes(error?.status) || ["HTTP_401", "HTTP_403"].includes(error?.code)) {
            authorizationError = error;
            queued?.reject(error);
            queued = null;
          }
          onError(error);
        }
        batch.reject(error);
      } finally {
        clearTimeoutImpl(timer);
        controller?.abort();
        active = null;
        pump();
      }
    })();
  };
  return {
    refresh({ suppressStaffCalls = false } = {}) {
      if (stopped) return Promise.reject(stoppedError());
      if (authorizationError) return Promise.reject(authorizationError);
      if (suppressStaffCalls) suppressionVersion++;
      if (!queued) {
        let resolve, reject;
        const promise = new Promise((a, b) => { resolve = a; reject = b; });
        queued = { promise, resolve, reject };
      }
      const promise = queued.promise;
      pump();
      return promise;
    },
    stop() {
      stopped = true;
      queued?.reject(stoppedError());
      queued = null;
      active?.cancel();
    },
  };
}
