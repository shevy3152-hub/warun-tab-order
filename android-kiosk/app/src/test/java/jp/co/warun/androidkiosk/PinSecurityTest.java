package jp.co.warun.androidkiosk;

import java.util.Arrays;

public final class PinSecurityTest {
    public static void main(String[] args) throws Exception {
        byte[] salt = PinSecurity.newSalt();
        byte[] expected = PinSecurity.derive("1234".toCharArray(), salt, PinSecurity.ITERATIONS);
        byte[] actual = PinSecurity.derive("1234".toCharArray(), salt, PinSecurity.ITERATIONS);
        byte[] wrong = PinSecurity.derive("1235".toCharArray(), salt, PinSecurity.ITERATIONS);
        require(PinSecurity.constantTimeEquals(expected, actual), "matching PIN rejected");
        require(!PinSecurity.constantTimeEquals(expected, wrong), "wrong PIN accepted");
        require(!Arrays.equals(salt, PinSecurity.newSalt()), "salt was not random");
        require(!PinLockoutPolicy.reachesLimit(3), "lockout reached too early");
        require(PinLockoutPolicy.reachesLimit(4), "fifth failure did not lock out");
        require(PinLockoutPolicy.isLocked(1000L, 1001L), "lockout not active");
        require(!PinLockoutPolicy.isLocked(1001L, 1001L), "lockout lasted too long");
        System.out.println("PinSecurityTest: PASS (7 cases)");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
