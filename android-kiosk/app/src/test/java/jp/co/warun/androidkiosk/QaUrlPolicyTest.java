package jp.co.warun.androidkiosk;

public final class QaUrlPolicyTest {
    public static void main(String[] args) {
        require(QaUrlPolicy.isAllowedNavigationUrl(QaUrlPolicy.START_URL), "QA entry rejected");
        require(QaUrlPolicy.isAllowedNavigationUrl(QaUrlPolicy.CUSTOMER_URL), "QA customer rejected");
        String[] rejected = {
            "http://192.168.11.6:25173/customer/customer-01",
            "http://192.168.11.7:60291/customer/customer-01",
            "https://192.168.11.6:60291/customer/customer-01",
            "http://localhost:60291/customer/customer-01",
            "http://192.168.11.6:60292/customer/customer-01",
            "http://192.168.11.6:60291/admin.html",
            "http://192.168.11.6:60291/pairing.html#p=ABCDEFGHJKLM",
            "http://user@192.168.11.6:60291/customer/customer-01",
            QaUrlPolicy.CUSTOMER_URL + "?url=https://example.com",
            QaUrlPolicy.CUSTOMER_URL + "#anything",
            "http://192.168.11.6:60291/customer/../customer/customer-01",
            "javascript:alert(1)", "file:///customer/customer-01", "not a url", "", null
        };
        for (String url : rejected) require(!QaUrlPolicy.isAllowedNavigationUrl(url), "unexpected URL accepted");
        require(QaUrlPolicy.START_URL.equals(QaUrlPolicy.resolveNavigationUrl(false, QaUrlPolicy.CUSTOMER_URL)), "launcher changed");
        require(QaUrlPolicy.START_URL.equals(QaUrlPolicy.resolveNavigationUrl(true, rejected[0])), "invalid intent changed entry");
        require(QaUrlPolicy.CUSTOMER_URL.equals(QaUrlPolicy.resolveNavigationUrl(true, QaUrlPolicy.CUSTOMER_URL)), "valid QA navigation rejected");
        require(!PairingUrlPolicy.isAllowedOriginUrl(QaUrlPolicy.START_URL), "standard policy now permits QA origin");
        require("http://192.168.11.6:25173/customer/customer-01".equals(PairingUrlPolicy.START_URL), "standard entry changed");
        require(QaUrlPolicy.START_URL.equals(QaUrlPolicy.diagnosticUrl(QaUrlPolicy.START_URL + "?private=value#private")), "diagnostic exposes query/fragment");
        require(QaUrlPolicy.START_URL.equals(QaUrlPolicy.diagnosticUrl("http://private@192.168.11.6:60291/qa-a90-kiosk-start.html")), "diagnostic exposes user information");
        require((QaUrlPolicy.ORIGIN + "/other-path").equals(QaUrlPolicy.diagnosticUrl(QaUrlPolicy.ORIGIN + "/private-value")), "diagnostic exposes arbitrary path");
        require("other-origin".equals(QaUrlPolicy.diagnosticUrl("https://private.example/private")), "diagnostic exposes other origin");
        require("invalid-url".equals(QaUrlPolicy.diagnosticUrl("not a url")), "invalid diagnostic URL");
        System.out.println("QaUrlPolicyTest: PASS (QA origin/routes, rejected URLs, standard isolation)");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
