package ai.hader.app;

import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.getcapacitor.BridgeActivity;

/**
 * Custom MainActivity (copied over the Capacitor-generated one during CI) that
 * adds two native behaviours the remote-loaded web app can't provide itself:
 *
 *   1. Pull-to-refresh — wraps the WebView in a SwipeRefreshLayout; a swipe down
 *      at the top of the page reloads it.
 *   2. Auto offline screen — a connectivity listener swaps to the bundled
 *      offline page the moment the network drops, and reloads the site when it
 *      comes back (works even while the app is already open).
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

        // ---- 1. Pull-to-refresh ------------------------------------------------
        try {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) {
                int index = parent.indexOfChild(webView);
                ViewGroup.LayoutParams lp = webView.getLayoutParams();
                parent.removeView(webView);

                final SwipeRefreshLayout swipe = new SwipeRefreshLayout(this);
                swipe.setColorSchemeColors(0xFF360516);
                swipe.addView(webView, new ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT));
                parent.addView(swipe, index, lp);

                swipe.setOnRefreshListener(() -> {
                    webView.reload();
                    swipe.postDelayed(() -> swipe.setRefreshing(false), 1200);
                });
                // Only allow the pull gesture when the page is scrolled to the top.
                swipe.setOnChildScrollUpCallback((p, child) -> webView.getScrollY() > 0);
            }
        } catch (Exception ignored) {
            // If wrapping fails on some device, fall back to no pull-to-refresh
            // rather than crashing the app.
        }

        // ---- 2. Automatic offline screen --------------------------------------
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
