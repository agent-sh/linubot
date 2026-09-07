package sh.agent.linubot;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private WebView browser;
    private String origin;
    private LinearLayout root;
    private TextView connectionStatus;
    private boolean loadFailed;
    private boolean downloading;
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        origin = getPreferences(MODE_PRIVATE).getString("origin", "");
        if (origin.isEmpty()) showSetup(); else connect(origin);
    }
    private void layout() {
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(245,243,237));
        root.setOnApplyWindowInsetsListener((view, insets) -> { view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom()); return insets; });
        setContentView(root);
    }
    private void showSetup() {
        if (browser != null) { browser.destroy(); browser = null; }
        layout(); LinearLayout form = new LinearLayout(this); form.setOrientation(LinearLayout.VERTICAL); form.setPadding(dp(24),dp(40),dp(24),dp(24)); root.addView(form);
        TextView title = new TextView(this); title.setText("Your bots, with you."); title.setTextSize(30); form.addView(title);
        TextView help = new TextView(this); help.setText("On Linux, open Linubot Settings → Phone access. Enable access, then copy the HTTPS computer address here. Keep Tailscale connected on both devices."); help.setPadding(0,dp(18),0,dp(18)); form.addView(help);
        EditText address = new EditText(this); address.setSingleLine(true); address.setHint("https://computer.tailnet.ts.net:45874"); address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI); address.setText(origin); form.addView(address);
        Button connect = new Button(this); connect.setText("Connect to my computer"); form.addView(connect);
        TextView error = new TextView(this); form.addView(error);
        connect.setOnClickListener(v -> {
            try {
                Uri uri = Uri.parse(address.getText().toString().trim());
                if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || !(uri.getPath() == null || uri.getPath().isEmpty() || "/".equals(uri.getPath()))) throw new IllegalArgumentException();
                origin = uri.buildUpon().path("").build().toString();
                getPreferences(MODE_PRIVATE).edit().putString("origin", origin).apply(); connect(origin);
            } catch (Exception ex) { error.setText("Enter the HTTPS computer address shown in Linubot, without a path or pairing code."); }
        });
    }
    private boolean sameOrigin(Uri uri) {
        Uri base = Uri.parse(origin);
        return "https".equals(uri.getScheme()) && base.getHost().equalsIgnoreCase(uri.getHost() == null ? "" : uri.getHost()) && (base.getPort() == -1 ? 443 : base.getPort()) == (uri.getPort() == -1 ? 443 : uri.getPort()) && uri.getUserInfo() == null;
    }
    private void connect(String address) {
        layout();
        LinearLayout bar = new LinearLayout(this); bar.setGravity(android.view.Gravity.CENTER_VERTICAL); bar.setPadding(dp(8),0,dp(8),0); root.addView(bar);
        connectionStatus = new TextView(this); connectionStatus.setText("Linubot"); bar.addView(connectionStatus,new LinearLayout.LayoutParams(0,dp(48),1));
        Button menu = new Button(this); menu.setText("Connection"); bar.addView(menu);
        menu.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Your Linux computer").setMessage(origin).setPositiveButton("Refresh", (dialog,which) -> browser.reload()).setNeutralButton("Change computer", (dialog,which) -> {
            CookieManager.getInstance().removeAllCookies(removed -> { CookieManager.getInstance().flush(); getPreferences(MODE_PRIVATE).edit().remove("origin").apply(); showSetup(); });
        }).setNegativeButton("Close", null).show());
        browser = new WebView(this); root.addView(browser,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1));
        WebSettings settings = browser.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setSafeBrowsingEnabled(true); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(browser,false);
        browser.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon) { loadFailed=false; connectionStatus.setText("Connecting…"); }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (sameOrigin(request.getUrl())) return false;
                if (request.isForMainFrame() && ("https".equals(request.getUrl().getScheme()) || "http".equals(request.getUrl().getScheme()))) { try { startActivity(new Intent(Intent.ACTION_VIEW,request.getUrl())); } catch (Exception ignored) { connectionStatus.setText("No browser available"); } }
                return true;
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); loadFailed=true; connectionStatus.setText("HTTPS certificate rejected"); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) { loadFailed=true; connectionStatus.setText("Offline. Check Linux and Tailscale, then Refresh."); } }
            @Override public void onPageFinished(WebView view,String url) { CookieManager.getInstance().flush(); if (!loadFailed && sameOrigin(Uri.parse(url))) connectionStatus.setText("Linubot"); }
        });
        browser.setDownloadListener((url,userAgent,contentDisposition,mimeType,length) -> download(url,length));
        browser.loadUrl(address + "/");
    }
    private void download(String url,long advertisedLength) {
        if (downloading || !sameOrigin(Uri.parse(url))) { connectionStatus.setText("Only this computer’s files can be downloaded"); return; }
        if (advertisedLength > 20 * 1024 * 1024) { connectionStatus.setText("File is larger than 20 MB"); return; }
        final String cookie = CookieManager.getInstance().getCookie(url);
        downloading = true; connectionStatus.setText("Downloading file…");
        new Thread(() -> {
            java.io.File file = null; javax.net.ssl.HttpsURLConnection connection = null;
            try {
                java.io.File directory = new java.io.File(getCacheDir(),"downloads"); directory.mkdirs();
                java.io.File[] previous = directory.listFiles();
                if (previous != null && previous.length >= 20) throw new java.io.IOException("Clear the app cache before downloading more files");
                connection = (javax.net.ssl.HttpsURLConnection) new java.net.URL(url).openConnection();
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
                if (cookie != null) connection.setRequestProperty("Cookie",cookie);
                if (connection.getResponseCode() != 200) throw new java.io.IOException("Download unavailable. Refresh the connection and try again.");
                String contentType = connection.getContentType();
                final String shareType = contentType != null && contentType.startsWith("text/") ? "text/plain" : "application/octet-stream";
                file = new java.io.File(directory,"linubot-" + java.util.UUID.randomUUID() + ("text/plain".equals(shareType) ? ".md" : ".bin"));
                try (java.io.InputStream input=connection.getInputStream(); java.io.OutputStream output=new java.io.FileOutputStream(file)) {
                    byte[] buffer=new byte[8192]; int size,total=0;
                    while ((size=input.read(buffer))!=-1) { total+=size; if (total>20*1024*1024) throw new java.io.IOException("File is larger than 20 MB"); output.write(buffer,0,size); }
                }
                final Uri uri = androidx.core.content.FileProvider.getUriForFile(this,"sh.agent.linubot.files",file);
                runOnUiThread(() -> { downloading=false; connectionStatus.setText("File ready"); Intent share=new Intent(Intent.ACTION_SEND); share.setType(shareType); share.putExtra(Intent.EXTRA_STREAM,uri); share.setClipData(android.content.ClipData.newRawUri("Linubot file",uri)); share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); startActivity(Intent.createChooser(share,"Save or share Linubot file")); });
            } catch (Exception error) {
                if (file!=null) file.delete();
                runOnUiThread(() -> { downloading=false; connectionStatus.setText("File download failed. Check the connection or app cache."); });
            } finally { if (connection!=null) connection.disconnect(); }
        },"linubot-download").start();
    }
    @Override public void onBackPressed() { if (browser != null && browser.canGoBack()) browser.goBack(); else super.onBackPressed(); }
    @Override protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); }
    @Override protected void onDestroy() { if (browser != null) browser.destroy(); super.onDestroy(); }
}
