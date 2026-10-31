package com.craftagents.companion;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;

/** Isolated, inert visual preview. Never receives a URL, credential, cookie, or data/action bridge. */
final class StaticPageView extends WebView {
    static final String CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; "
        + "style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; "
        + "object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; "
        + "form-action 'none'; base-uri 'none'";
    @SuppressLint("SetJavaScriptEnabled")
    StaticPageView(Context context, String html, Runnable rendererFailed) {
        super(context);
        setBackgroundColor(Color.WHITE);
        WebSettings s = getSettings();
        s.setJavaScriptEnabled(false);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false); s.setAllowUniversalAccessFromFileURLs(false);
        s.setBlockNetworkLoads(true); s.setBlockNetworkImage(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setDomStorageEnabled(false); s.setDatabaseEnabled(false);
        s.setGeolocationEnabled(false); s.setSaveFormData(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false); s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(true); s.setSafeBrowsingEnabled(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setBuiltInZoomControls(true); s.setDisplayZoomControls(false);
        CookieManager.getInstance().setAcceptCookie(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false);
        setDownloadListener((url, agent, disposition, mime, length) -> { /* Downloads are disabled. */ });
        setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> result, FileChooserParams params) { result.onReceiveValue(null); return true; }
        });
        setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) { return true; }
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                // CSP confines data: to images/fonts. Refuse every network/local/custom-scheme request.
                if ("data".equals(request.getUrl().getScheme())) return null;
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) { rendererFailed.run(); return true; }
            @Override public void onReceivedSslError(WebView v, SslErrorHandler handler, SslError error) { handler.cancel(); }
        });
        // The first CSP precedes untrusted authored HTML; later policies cannot loosen it.
        // The synthetic origin is unrelated to the server and receives no auth headers.
        String document = "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\""
            + CSP + "\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            + "<style>body{margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>" + html + "</body></html>";
        loadDataWithBaseURL("https://companion-preview.invalid/", document, "text/html", "UTF-8", null);
    }
}
