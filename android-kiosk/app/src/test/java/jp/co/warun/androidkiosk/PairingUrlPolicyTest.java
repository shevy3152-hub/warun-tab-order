package jp.co.warun.androidkiosk;

public final class PairingUrlPolicyTest {
    private static final String VALID = "http://192.168.11.6:25173/pairing.html#p=ABCDEFGHJKLM";

    public static void main(String[] args) {
        acceptsValidPairingUrl();
        rejectsWrongOriginAndShape();
        launcherAndInvalidViewUseFixedCustomerUrl();
        safeLogUrlRemovesQueryAndFragment();
        System.out.println("PairingUrlPolicyTest: PASS (4 cases)");
    }

    private static void acceptsValidPairingUrl() {
        require(PairingUrlPolicy.isValidPairingUrl(VALID), "valid pairing URL rejected");
        requireEquals(VALID, PairingUrlPolicy.resolveNavigationUrl(true, VALID), "valid URL resolution");
    }

    private static void rejectsWrongOriginAndShape() {
        require(!PairingUrlPolicy.isValidPairingUrl(VALID.replace("192.168.11.6", "192.168.11.7")), "wrong host accepted");
        require(!PairingUrlPolicy.isValidPairingUrl(VALID.replace("25173", "25174")), "wrong port accepted");
        require(!PairingUrlPolicy.isValidPairingUrl(VALID.replace("http:", "https:")), "https accepted");
        require(!PairingUrlPolicy.isValidPairingUrl(VALID.replace("/pairing.html", "/customer/customer-01")), "wrong path accepted");
        require(!PairingUrlPolicy.isValidPairingUrl(VALID.replace("192.168.11.6", "user@192.168.11.6")), "user info accepted");
        require(!PairingUrlPolicy.isValidPairingUrl(VALID.replace("#p=ABCDEFGHJKLM", "?x=1#p=ABCDEFGHJKLM")), "query accepted");
        require(!PairingUrlPolicy.isValidPairingUrl("http://192.168.11.6:25173/pairing.html"), "missing fragment accepted");
        require(!PairingUrlPolicy.isValidPairingUrl(VALID.replace("p=ABCDEFGHJKLM", "p=ABC")), "invalid fragment accepted");
        require(!PairingUrlPolicy.isValidPairingUrl(VALID.replace("#p=", "#code=")), "wrong fragment key accepted");
    }

    private static void launcherAndInvalidViewUseFixedCustomerUrl() {
        requireEquals(PairingUrlPolicy.START_URL, PairingUrlPolicy.resolveNavigationUrl(false, VALID), "launcher URL resolution");
        requireEquals(PairingUrlPolicy.START_URL, PairingUrlPolicy.resolveNavigationUrl(true, "http://192.168.11.6:25173/pairing.html#p=BAD"), "invalid view resolution");
    }

    private static void safeLogUrlRemovesQueryAndFragment() {
        requireEquals("http://192.168.11.6:25173/pairing.html", PairingUrlPolicy.safeLogUrl(VALID + "?ignored=1"), "fragment log removal");
        requireEquals("http://192.168.11.6:25173/pairing.html", PairingUrlPolicy.safeLogUrl("http://192.168.11.6:25173/pairing.html?x=1#p=ABCDEFGHJKLM"), "query and fragment log removal");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void requireEquals(String expected, String actual, String message) {
        if (!expected.equals(actual)) throw new AssertionError(message + ": expected=" + expected + ", actual=" + actual);
    }
}
