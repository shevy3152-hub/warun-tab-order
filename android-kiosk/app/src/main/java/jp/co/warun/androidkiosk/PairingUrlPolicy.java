package jp.co.warun.androidkiosk;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.regex.Pattern;

/** Pure URL policy for the LAN pairing handoff. It never exposes the fragment. */
public final class PairingUrlPolicy {
    public static final String START_URL = "http://192.168.11.6:25173/customer/customer-01";
    private static final String SCHEME = "http";
    private static final String HOST = "192.168.11.6";
    private static final int PORT = 25173;
    private static final String PATH = "/pairing.html";
    private static final Pattern PAIRING_FRAGMENT = Pattern.compile("p=[A-HJ-NP-Z2-9]{12}");

    private PairingUrlPolicy() {
    }

    public static String resolveNavigationUrl(boolean isActionView, String rawUrl) {
        return isActionView && isValidPairingUrl(rawUrl) ? rawUrl : START_URL;
    }

    public static boolean isValidPairingUrl(String rawUrl) {
        URI uri = parse(rawUrl);
        if (uri == null || !isAllowedOrigin(uri) || !PATH.equals(uri.getRawPath())) return false;
        if (uri.getUserInfo() != null || uri.getQuery() != null) return false;
        String fragment = uri.getRawFragment();
        return fragment != null && PAIRING_FRAGMENT.matcher(fragment).matches();
    }

    public static boolean isAllowedOriginUrl(String rawUrl) {
        URI uri = parse(rawUrl);
        return uri != null && isAllowedOrigin(uri) && uri.getUserInfo() == null;
    }

    public static boolean isPairingUrl(String rawUrl) {
        URI uri = parse(rawUrl);
        return uri != null && isAllowedOrigin(uri) && PATH.equals(uri.getRawPath());
    }

    public static String safeLogUrl(String rawUrl) {
        URI uri = parse(rawUrl);
        if (uri == null || uri.getHost() == null || uri.getScheme() == null) return "unparseable-url";
        String path = uri.getRawPath() == null ? "" : uri.getRawPath();
        return uri.getScheme() + "://" + uri.getHost() + ":" + uri.getPort() + path;
    }

    private static boolean isAllowedOrigin(URI uri) {
        return SCHEME.equals(uri.getScheme())
                && HOST.equals(uri.getHost())
                && PORT == uri.getPort();
    }

    private static URI parse(String rawUrl) {
        if (rawUrl == null || rawUrl.isEmpty()) return null;
        try {
            return new URI(rawUrl);
        } catch (URISyntaxException ignored) {
            return null;
        }
    }
}
