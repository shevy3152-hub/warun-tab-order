package jp.co.warun.androidkiosk;

import java.net.URI;
import java.net.URISyntaxException;

/** Fixed, credential-free entry points for the separate QA application. */
public final class QaUrlPolicy {
    public static final String ORIGIN = "http://192.168.11.6:60291";
    public static final String START_URL = ORIGIN + "/qa-a90-kiosk-start.html";
    public static final String CUSTOMER_URL = ORIGIN + "/customer/customer-01";
    public static final String HEALTH_URL = ORIGIN + "/v1/health";

    private QaUrlPolicy() {}

    public static boolean isAllowedNavigationUrl(String rawUrl) {
        try {
            URI uri = new URI(rawUrl == null ? "" : rawUrl);
            if (!"http".equals(uri.getScheme()) || !"192.168.11.6".equals(uri.getHost())
                    || uri.getPort() != 60291 || uri.getUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null) return false;
            return "/qa-a90-kiosk-start.html".equals(uri.getRawPath())
                    || "/customer/customer-01".equals(uri.getRawPath());
        } catch (URISyntaxException error) {
            return false;
        }
    }

    public static String resolveNavigationUrl(boolean isActionView, String rawUrl) {
        return isActionView && isAllowedNavigationUrl(rawUrl) ? rawUrl : START_URL;
    }

    /** Diagnostic labels only: never expose user information, query, fragment or arbitrary paths. */
    public static String diagnosticUrl(String rawUrl) {
        try {
            URI uri = new URI(rawUrl == null ? "" : rawUrl);
            if (!"http".equals(uri.getScheme()) || !"192.168.11.6".equals(uri.getHost())
                    || uri.getPort() != 60291) return "other-origin";
            String path = uri.getRawPath();
            if ("/qa-a90-kiosk-start.html".equals(path) || "/customer/customer-01".equals(path)
                    || "/customer-rail-washi-japanese-halloween.png".equals(path)
                    || "/qa-a90-image-geometry.js".equals(path)
                    || "/v1/health".equals(path)) return ORIGIN + path;
            if (path != null && path.matches("/assets/[A-Za-z0-9_-]{1,80}\\.(js|css)"))
                return ORIGIN + path;
            return ORIGIN + "/other-path";
        } catch (URISyntaxException error) {
            return "invalid-url";
        }
    }
}
