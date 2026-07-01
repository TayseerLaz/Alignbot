package ai.hader.app;

import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * Custom MainActivity (copied over the Capacitor-generated one during CI).
 *
 * Adds an automatic offline screen: a ConnectivityManager callback swaps to the
 * bundled offline page the instant the network drops (works while the app is
 * open, not just at launch) and reloads the site when it comes back.
 *
 * NOTE: native pull-to-refresh (SwipeRefreshLayout) was intentionally removed.
 * The web app scrolls an inner container rather than the document, so the native
 * layout can't detect the real scroll position and would hijack scroll gestures
 * as refreshes. If pull-to-refresh is wanted, it must be implemented inside the
 * web app against its own scroll container.
 */
public class MainActivity extends BridgeActivity {

    private static final String HOME_URL = "https://hader.ai/";
    private static final String OFFLINE_ASSET = "file:///android_asset/public/offline.html";

    private boolean showingOffline = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebView webView = this.getBridge().getWebView();
        if (webView == null) return;

        try {
            ConnectivityManager cm =
                    (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onLost(Network network) {
                        runOnUiThread(() -> {
                            showingOffline = true;
                            webView.loadUrl(OFFLINE_ASSET);
                        });
                    }

                    @Override
                    public void onAvailable(Network network) {
                        runOnUiThread(() -> {
                            if (showingOffline) {
                                showingOffline = false;
                                webView.loadUrl(HOME_URL);
                            }
                        });
                    }
                });
            }
        } catch (Exception ignored) {
            // Connectivity monitoring is best-effort.
        }
    }
}
