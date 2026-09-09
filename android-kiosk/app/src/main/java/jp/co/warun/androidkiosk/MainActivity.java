package jp.co.warun.androidkiosk;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.util.Log;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    private static final String TAG = "WarunKiosk";
    private static final String HEALTH_URL = "http://192.168.11.6:25173/v1/health";
    private static final String DEBUG_EXTRA = "debugViewport";
    private static final String DEBUG_NORMAL_EXIT_ACTION = "jp.co.warun.androidkiosk.action.DEBUG_NORMAL_EXIT";
    private static final int MAX_RENDERER_RECOVERY_ATTEMPTS = 2;
    private static final long RENDERER_START_WATCHDOG_MS = 8000L;
    private WebView webView;
    private TextView debugView;
    private TextView recoveryView;
    private FrameLayout rootView;
    private WindowInsets lastInsets;
    private String pageSnapshot = "pending";
    private boolean debugEnabled;
    private boolean pairingFlowActive;
    private boolean rendererRecoveryInProgress;
    private int rendererRecoveryAttempts;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Runnable rendererStartWatchdog;
    private final StringBuilder diagnosticLog = new StringBuilder();
    private long debugTimingStartElapsedRealtime;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (handleDebugNormalExitIntent(getIntent())) return;
        debugEnabled = BuildConfig.DEBUG && getIntent().getBooleanExtra(DEBUG_EXTRA, false);
        debugTiming("onCreate");
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.BLACK);
        applyImmersiveMode();

        FrameLayout root = new FrameLayout(this);
        rootView = root;
        createAndAttachWebView();
        createRecoveryView();

        if (debugEnabled) {
            debugView = new TextView(this);
            debugView.setTextColor(Color.WHITE);
            debugView.setTextSize(11);
            debugView.setBackgroundColor(0xCC222222);
            debugView.setPadding(12, 8, 12, 8);
            debugView.setTextIsSelectable(true);
            FrameLayout.LayoutParams debugParams = new FrameLayout.LayoutParams(-2, -2);
            debugParams.topMargin = 8;
            debugParams.leftMargin = 8;
            root.addView(debugView, debugParams);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                lastInsets = insets;
                refreshDebug();
                return insets;
            });
        }

        setContentView(root);
        loadUrlForIntent(getIntent());
        root.post(() -> {
            lastInsets = root.getRootWindowInsets();
            refreshDebug();
        });
        if (debugEnabled) runNativeHttpProbes();
    }

    private WebView createAndAttachWebView() {
        WebView freshWebView = new WebView(this);
        configureWebView(freshWebView);
        webView = freshWebView;
        pageSnapshot = "pending";
        debugTiming("webViewCreated");
        if (rootView != null) {
            rootView.addView(freshWebView, 0, new FrameLayout.LayoutParams(-1, -1));
        }
        return freshWebView;
    }

    private void createRecoveryView() {
        recoveryView = new TextView(this);
        recoveryView.setText("表示を再試行してください");
        recoveryView.setTextColor(Color.WHITE);
        recoveryView.setTextSize(18);
        recoveryView.setGravity(android.view.Gravity.CENTER);
        recoveryView.setBackgroundColor(Color.BLACK);
        recoveryView.setOnClickListener(view -> retryRendererRecovery());
        rootView.addView(recoveryView, new FrameLayout.LayoutParams(-1, -1));
        recoveryView.setVisibility(View.GONE);
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap favicon) {
                cancelRendererStartWatchdog();
                debugTiming("pageStarted");
                debugEvent("pageStarted url=" + safeUrl(url));
                super.onPageStarted(v, url, favicon);
            }

            @Override
            public void onPageCommitVisible(WebView v, String url) {
                cancelRendererStartWatchdog();
                debugTiming("pageCommitVisible");
                debugEvent("pageCommitVisible url=" + safeUrl(url));
                super.onPageCommitVisible(v, url);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                cancelRendererStartWatchdog();
                debugTiming("pageFinished");
                debugEvent("pageFinished url=" + safeUrl(url));
                if (PairingUrlPolicy.isPairingUrl(url)) pairingFlowActive = true;
                if (!PairingUrlPolicy.isPairingUrl(url)) {
                    rendererRecoveryAttempts = 0;
                    hideRecoveryView();
                }
                evaluatePageSnapshot(v);
                super.onPageFinished(v, url);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    debugEvent("receivedError main=true code=" + error.getErrorCode()
                            + " description=" + redact(error.getDescription().toString())
                            + " url=" + safeUrl(request.getUrl().toString()));
                }
                super.onReceivedError(v, request, error);
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest request, android.webkit.WebResourceResponse response) {
                if (request.isForMainFrame()) {
                    debugEvent("receivedHttpError main=true status=" + response.getStatusCode()
                            + " reason=" + redact(response.getReasonPhrase())
                            + " url=" + safeUrl(request.getUrl().toString()));
                }
                super.onReceivedHttpError(v, request, response);
            }

            @Override
            @android.annotation.TargetApi(26)
            public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail detail) {
                debugEvent("renderProcessGone didCrash=" + detail.didCrash()
                        + " rendererPriorityAtExit=" + detail.rendererPriorityAtExit());
                recoverFromRendererGone(v);
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                boolean blocked = !isAllowedWebViewUrl(request.getUrl());
                if (blocked) debugEvent("blockedNavigation url=" + safeUrl(request.getUrl().toString()));
                return blocked;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                android.net.Uri uri = android.net.Uri.parse(url);
                boolean blocked = !isAllowedWebViewUrl(uri);
                if (blocked) debugEvent("blockedNavigation url=" + safeUrl(url));
                return blocked;
            }
        });
        if (debugEnabled) {
            view.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onConsoleMessage(ConsoleMessage message) {
                    if (pairingFlowActive) return true;
                    debugEvent("console level=" + message.messageLevel()
                            + " line=" + message.lineNumber()
                            + " message=" + redact(message.message()));
                    return true;
                }
            });
        }
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
    }

    private boolean isAllowedWebViewUrl(android.net.Uri uri) {
        if (uri == null || !PairingUrlPolicy.isAllowedOriginUrl(uri.toString())) return false;
        return !"/pairing.html".equals(uri.getPath()) || PairingUrlPolicy.isValidPairingUrl(uri.toString());
    }

    private void loadUrlForIntent(Intent incoming) {
        boolean isActionView = incoming != null && Intent.ACTION_VIEW.equals(incoming.getAction());
        String rawUrl = incoming == null ? null : incoming.getDataString();
        boolean acceptedPairing = isActionView && PairingUrlPolicy.isValidPairingUrl(rawUrl);
        pairingFlowActive = acceptedPairing;
        if (isActionView) debugEvent(acceptedPairing ? "externalIntent accepted path=/pairing.html" : "externalIntent rejected");
        String targetUrl = PairingUrlPolicy.resolveNavigationUrl(isActionView, rawUrl);
        sanitizeIntent(incoming);
        if (webView == null) createAndAttachWebView();
        debugTiming("loadUrl");
        webView.clearHistory();
        webView.loadUrl(targetUrl);
        scheduleRendererStartWatchdog(webView);
    }

    private void recoverFromRendererGone(WebView failedWebView) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            runOnUiThread(() -> recoverFromRendererGone(failedWebView));
            return;
        }
        if (rendererRecoveryInProgress) return;
        rendererRecoveryInProgress = true;
        try {
            boolean wasCurrentWebView = failedWebView == webView;
            if (wasCurrentWebView) {
                disposeWebView();
            } else {
                disposeWebViewInstance(failedWebView);
            }
            if (!wasCurrentWebView) return;
            pairingFlowActive = false;
            if (rendererRecoveryAttempts >= MAX_RENDERER_RECOVERY_ATTEMPTS) {
                showRecoveryView();
                return;
            }
            rendererRecoveryAttempts++;
            debugTiming("rendererRecovery");
            debugEvent("rendererRecovery attempt=" + rendererRecoveryAttempts);
            hideRecoveryView();
            WebView freshWebView = createAndAttachWebView();
            freshWebView.clearHistory();
            debugTiming("loadUrl(recovery)");
            freshWebView.loadUrl(PairingUrlPolicy.START_URL);
            scheduleRendererStartWatchdog(freshWebView);
        } finally {
            rendererRecoveryInProgress = false;
        }
    }

    private void retryRendererRecovery() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            runOnUiThread(this::retryRendererRecovery);
            return;
        }
        rendererRecoveryAttempts = 0;
        pairingFlowActive = false;
        hideRecoveryView();
        disposeWebView();
        WebView freshWebView = createAndAttachWebView();
        freshWebView.clearHistory();
        debugTiming("loadUrl(retry)");
        freshWebView.loadUrl(PairingUrlPolicy.START_URL);
        scheduleRendererStartWatchdog(freshWebView);
    }

    private void scheduleRendererStartWatchdog(WebView expectedWebView) {
        cancelRendererStartWatchdog();
        rendererStartWatchdog = () -> {
            rendererStartWatchdog = null;
            if (expectedWebView == webView && expectedWebView.getParent() != null
                    && "pending".equals(pageSnapshot)) {
                debugTiming("rendererStartWatchdog");
                debugEvent("rendererStartWatchdog timeout");
                recoverFromRendererGone(expectedWebView);
            }
        };
        mainHandler.postDelayed(rendererStartWatchdog, RENDERER_START_WATCHDOG_MS);
    }

    private void cancelRendererStartWatchdog() {
        if (rendererStartWatchdog != null) {
            mainHandler.removeCallbacks(rendererStartWatchdog);
            rendererStartWatchdog = null;
        }
    }

    private void disposeWebView() {
        debugTiming("webViewDispose");
        cancelRendererStartWatchdog();
        WebView currentWebView = webView;
        webView = null;
        disposeWebViewInstance(currentWebView);
    }

    private void disposeWebViewInstance(WebView view) {
        if (view == null) return;
        view.stopLoading();
        ViewGroup parent = view.getParent() instanceof ViewGroup
                ? (ViewGroup) view.getParent() : null;
        if (parent != null) parent.removeView(view);
        view.setWebChromeClient(null);
        view.setWebViewClient(null);
        view.destroy();
    }

    private void showRecoveryView() {
        if (recoveryView != null) recoveryView.setVisibility(View.VISIBLE);
        debugEvent("rendererRecovery exhausted");
    }

    private void hideRecoveryView() {
        if (recoveryView != null) recoveryView.setVisibility(View.GONE);
    }

    private void sanitizeIntent(Intent incoming) {
        if (incoming == null) return;
        incoming.setAction(Intent.ACTION_MAIN);
        incoming.setData(null);
        incoming.setClipData(null);
        incoming.setSelector(null);
        incoming.replaceExtras((Bundle) null);
    }

    private boolean handleDebugNormalExitIntent(Intent intent) {
        if (!BuildConfig.DEBUG || intent == null
                || !DEBUG_NORMAL_EXIT_ACTION.equals(intent.getAction())) return false;
        android.content.ComponentName component = intent.getComponent();
        boolean explicitSelf = component != null
                && getPackageName().equals(component.getPackageName())
                && MainActivity.class.getName().equals(component.getClassName());
        if (!explicitSelf) return false;
        disposeWebView();
        finishAndRemoveTask();
        return true;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (handleDebugNormalExitIntent(intent)) return;
        setIntent(intent);
        if (BuildConfig.DEBUG && intent != null && intent.getBooleanExtra(DEBUG_EXTRA, false)) debugEnabled = true;
        loadUrlForIntent(intent);
    }

    private void applyImmersiveMode() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private void evaluatePageSnapshot(WebView view) {
        if (!debugEnabled) return;
        String js = "(() => { const v=window.visualViewport; const b=document.body; const r=document.getElementById('root'); const d=document.documentElement; const text=b?b.innerText:''; return JSON.stringify({readyState:document.readyState,origin:location.origin,pathname:location.pathname,title:document.title,bodyChildElementCount:b?b.childElementCount:null,bodyInnerTextLength:b?text.length:null,rootExists:!!r,rootChildElementCount:r?r.childElementCount:null,reactRootGenerated:!!(r&&r.childElementCount),registrationVisible:text.includes('端末登録'),htmlLength:d?d.outerHTML.length:null,iw:innerWidth,ih:innerHeight,vw:v&&v.width,vh:v&&v.height,dpr:devicePixelRatio,land:matchMedia('(orientation: landscape)').matches}); })()";
        view.evaluateJavascript(js, value -> {
            pageSnapshot = redact(value);
            if (pageSnapshot.contains("\\\"readyState\\\":\\\"complete\\\"")) {
                debugTiming("domReady");
            }
            if (pageSnapshot.contains("\\\"rootExists\\\":true")
                    && pageSnapshot.contains("\\\"rootChildElementCount\\\":1")) {
                debugTiming("reactRootGenerated");
            }
            if (pageSnapshot.contains("\\\"registrationVisible\\\":true")) {
                debugTiming("terminalRegistrationVisible");
            }
            debugEvent("domSnapshot " + pageSnapshot);
        });
    }

    private void runNativeHttpProbes() {
        new Thread(() -> {
            probeHttp(HEALTH_URL);
            probeHttp(PairingUrlPolicy.START_URL);
        }, "debug-http-probe").start();
    }

    private void probeHttp(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            connection.setInstanceFollowRedirects(false);
            int status = connection.getResponseCode();
            String contentType = connection.getHeaderField("Content-Type");
            String contentLength = connection.getHeaderField("Content-Length");
            debugEvent("nativeHttp url=" + safeUrl(url) + " status=" + status
                    + " contentType=" + redact(contentType == null ? "unknown" : contentType)
                    + " contentLength=" + (contentLength == null ? "unknown" : contentLength));
        } catch (Exception error) {
            debugEvent("nativeHttp url=" + safeUrl(url) + " error=" + redact(error.getClass().getSimpleName() + ": " + error.getMessage()));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void debugEvent(String message) {
        if (!debugEnabled) return;
        String line = message == null ? "unknown" : message;
        Log.i(TAG, line);
        runOnUiThread(() -> {
            if (diagnosticLog.length() > 7000) diagnosticLog.delete(0, 1800);
            diagnosticLog.append(line).append('\n');
            refreshDebug();
        });
    }

    private void debugTiming(String event) {
        if (!BuildConfig.DEBUG || !debugEnabled) return;
        if (debugTimingStartElapsedRealtime == 0L) {
            debugTimingStartElapsedRealtime = SystemClock.elapsedRealtime();
        }
        long elapsed = SystemClock.elapsedRealtime() - debugTimingStartElapsedRealtime;
        debugEvent(String.format(Locale.US, "timing t+%dms event=%s", elapsed, event));
    }

    @Override
    protected void onStart() {
        super.onStart();
        debugTiming("onStart");
    }

    @Override
    protected void onResume() {
        super.onResume();
        debugTiming("onResume");
    }

    @Override
    protected void onPause() {
        debugTiming("onPause");
        super.onPause();
    }

    @Override
    protected void onStop() {
        debugTiming("onStop");
        super.onStop();
    }

    private void refreshDebug() {
        if (!debugEnabled || debugView == null) return;
        DisplayMetrics metrics = getResources().getDisplayMetrics();
        int left = 0, top = 0, right = 0, bottom = 0;
        int cutoutLeft = 0, cutoutTop = 0, cutoutRight = 0, cutoutBottom = 0;
        if (lastInsets != null && android.os.Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets bars = lastInsets.getInsets(WindowInsets.Type.systemBars());
            android.graphics.Insets cutout = lastInsets.getInsets(WindowInsets.Type.displayCutout());
            left = bars.left; top = bars.top; right = bars.right; bottom = bars.bottom;
            cutoutLeft = cutout.left; cutoutTop = cutout.top; cutoutRight = cutout.right; cutoutBottom = cutout.bottom;
        }
        int webLeft = webView == null ? -1 : webView.getLeft();
        int webTop = webView == null ? -1 : webView.getTop();
        int webRight = webView == null ? -1 : webView.getRight();
        int webBottom = webView == null ? -1 : webView.getBottom();
        int webVisibility = webView == null ? -1 : webView.getVisibility();
        float webAlpha = webView == null ? 0f : webView.getAlpha();
        debugView.setText(String.format(Locale.US,
                "DEBUG DIAGNOSTICS\nDOM=%s\nWebView bounds=[%d,%d][%d,%d] visibility=%d alpha=%.2f\nOverlay bounds=[%d,%d][%d,%d] visibility=%d alpha=%.2f\nAndroid display %dx%d px density=%.4f densityDpi=%d\nSystem insets L%d T%d R%d B%d\nCutout insets L%d T%d R%d B%d\n%s",
                pageSnapshot,
                webLeft, webTop, webRight, webBottom, webVisibility, webAlpha,
                debugView.getLeft(), debugView.getTop(), debugView.getRight(), debugView.getBottom(), debugView.getVisibility(), debugView.getAlpha(),
                metrics.widthPixels, metrics.heightPixels, metrics.density, metrics.densityDpi,
                left, top, right, bottom, cutoutLeft, cutoutTop, cutoutRight, cutoutBottom,
                diagnosticLog.toString()));
    }

    private static String safeUrl(String rawUrl) {
        return PairingUrlPolicy.safeLogUrl(rawUrl);
    }

    private static String redact(String value) {
        if (value == null) return "unknown";
        String safe = Pattern.compile("(?i)(token|cookie|credential|password|authorization|deviceId|pairing|qr|secret)(\\s*[:=]\\s*)[^\\s,;]+")
                .matcher(value).replaceAll("$1$2[REDACTED]");
        if (safe.length() > 400) safe = safe.substring(0, 400) + "…";
        return safe;
    }

    @Override
    protected void onDestroy() {
        disposeWebView();
        pairingFlowActive = false;
        debugView = null;
        recoveryView = null;
        rootView = null;
        lastInsets = null;
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            android.webkit.WebBackForwardList history = webView.copyBackForwardList();
            int previousIndex = history.getCurrentIndex() - 1;
            if (pairingFlowActive && previousIndex >= 0
                    && PairingUrlPolicy.isPairingUrl(history.getItemAtIndex(previousIndex).getUrl())) return;
            webView.goBack();
        }
    }
}
