export const CUSTOMER_VISIT_CONFIG_TIMEOUT_MS = 10_000;
export const CUSTOMER_VISIT_CONFIG_RETRY_MS = 3_000;

// Visit readiness must not depend on the lifetime of the invalidation stream.
export function createCustomerVisitConfigRefresher({
  getConfig,
  onConfig,
  onAuthorizationFailure = () => {},
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  AbortControllerImpl = globalThis.AbortController,
  timeoutMs = CUSTOMER_VISIT_CONFIG_TIMEOUT_MS,
  retryMs = CUSTOMER_VISIT_CONFIG_RETRY_MS,
} = {}) {
  let stopped = false;
  let authorizationFailed = false;
  let inFlight = null;
  let lastStartedRequest = 0;
  let minimumRequest = 0;
  let queuedRefresh = null;
  let retryTimer = null;
  let timeoutTimer = null;
  let controller = null;
  const failureResult = (error) => {
    if ([401, 403].includes(error?.status) || ["HTTP_401", "HTTP_403"].includes(error?.code)) {
      return { status: "unauthorized", errorCode: error?.code || "HTTP_" + error.status };
    }
    return null;
  };

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeoutImpl(retryTimer);
    retryTimer = null;
  };
  const refresh = ({ afterCurrent = false } = {}) => {
    if (stopped || authorizationFailed) return Promise.resolve(null);
    if (afterCurrent) minimumRequest = lastStartedRequest + 1;
    if (inFlight) {
      if (!afterCurrent) return inFlight;
      if (!queuedRefresh) {
        const queued = {};
        queued.promise = new Promise((resolve, reject) => { queued.resolve = resolve; queued.reject = reject; });
        queuedRefresh = queued;
      }
      return queuedRefresh.promise;
    }
    clearRetry();
    const requestNumber = ++lastStartedRequest;
    const requestController = typeof AbortControllerImpl === "function" ? new AbortControllerImpl() : null;
    controller = requestController;
    let request;
    try { request = Promise.resolve(getConfig({ signal: requestController?.signal })); }
    catch (error) { request = Promise.resolve(failureResult(error)); }
    const timeout = new Promise((resolve) => {
      timeoutTimer = setTimeoutImpl(() => {
        requestController?.abort();
        resolve(null);
      }, timeoutMs);
    });
    inFlight = Promise.race([request.catch(failureResult), timeout]).then((config) => {
      if (stopped) return null;
      if (config?.status === "unauthorized" || ["HTTP_401", "HTTP_403"].includes(config?.errorCode)) {
        authorizationFailed = true;
        onAuthorizationFailure(config?.errorCode);
        return null;
      }
      // A connection sync needs a GET started after its request, not a shared older GET.
      if (requestNumber < minimumRequest) return null;
      if (config?.role === "customer" && Number.isSafeInteger(config.tableId) && config.tableId > 0
          && /^v1_[0-9a-f]{64}$/.test(config.visitContextId || "")) {
        onConfig(config);
        return config;
      }
      retryTimer = setTimeoutImpl(() => {
        retryTimer = null;
        void refresh();
      }, retryMs);
      return null;
    }).finally(() => {
      if (timeoutTimer !== null) clearTimeoutImpl(timeoutTimer);
      timeoutTimer = null;
      if (controller === requestController) controller = null;
      inFlight = null;
      const queued = queuedRefresh;
      queuedRefresh = null;
      if (queued) void refresh().then(queued.resolve, queued.reject);
    });
    return inFlight;
  };
  void refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      clearRetry();
      if (timeoutTimer !== null) clearTimeoutImpl(timeoutTimer);
      timeoutTimer = null;
      queuedRefresh?.resolve(null);
      queuedRefresh = null;
      controller?.abort();
    },
  };
}
