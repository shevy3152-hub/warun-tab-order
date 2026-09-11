package jp.co.warun.androidkiosk;

final class PinLockoutPolicy {
    static final int FAILURE_LIMIT = 5;
    static final long LOCKOUT_MS = 60_000L;
    private PinLockoutPolicy() { }

    static boolean isLocked(long nowMs, long lockoutUntilMs) {
        return lockoutUntilMs > nowMs;
    }

    static boolean reachesLimit(int failuresBeforeAttempt) {
        return failuresBeforeAttempt + 1 >= FAILURE_LIMIT;
    }
}
