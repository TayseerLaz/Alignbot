# Hader — Android APK (TWA wrapper of the PWA)

This packages the **whole `hader.ai` site** (marketing root + the `/app` portal)
as an installable Android app using a **Trusted Web Activity (TWA)**. The APK is
a thin native shell that opens the live PWA full-screen — so every web deploy
updates the app instantly, no rebuild needed (only version bumps / icon changes
require a new APK).

> iOS is **not** covered here (Apple has no APK / sideload). iOS ships via the
> Capacitor plan in [../../docs/MOBILE-APP-PLAN.md](../../docs/MOBILE-APP-PLAN.md).

---

## Prerequisites (the two that live outside this repo)

1. **Deploy the PWA to `hader.ai` first.** The APK loads the live site, so the
   manifest + service worker + icons committed in `apps/web` must be live at
   `https://hader.ai/app/...`. Until then the app opens the old site.
2. **Host `assetlinks.json`** at `https://hader.ai/.well-known/assetlinks.json`
   with the APK's signing fingerprint (steps below). Without it the app still
   installs but opens with a browser URL bar instead of full-screen.

Local build tooling: **Node 18+** and a **JDK**. Bubblewrap downloads its own
JDK 17 + Android SDK on first run (~700 MB) — you do not need Android Studio.

---

## Option A — PWABuilder (no local tooling, fastest)

Once the PWA is deployed:

1. Go to <https://www.pwabuilder.com>, enter `https://hader.ai/app/dashboard`.
2. Package for **Android** → download the `.apk` (test) / `.aab` (Play) + the
   generated `assetlinks.json`.
3. Host that `assetlinks.json` at `https://hader.ai/.well-known/assetlinks.json`.
4. Transfer the `.apk` to a phone and install (enable "install unknown apps").

This is the recommended path to get an APK on a phone quickly.

---

## Option B — Bubblewrap (repeatable, in-repo)

From `apps/mobile/`:

```bash
# 1. Install the CLI
npm i -g @bubblewrap/cli

# 2. Initialise the Android project from our config (creates ./android.keystore).
#    (Requires the PWA manifest to be live at the webManifestUrl in twa-manifest.json.)
bubblewrap init --manifest ./twa-manifest.json
#    ^ on first run it offers to download the JDK + Android SDK — accept.

# 3. Build the APK/AAB
bubblewrap build
#    → outputs app-release-signed.apk  and  app-release-bundle.aab

# 4. Print the signing fingerprint and paste it into assetlinks.json
bubblewrap fingerprint list
#    Copy the SHA-256 into apps/mobile/assetlinks.json (replace the placeholder),
#    then deploy that file to https://hader.ai/.well-known/assetlinks.json
```

Install the APK on a device:

```bash
adb install app-release-signed.apk    # or transfer the file and tap it
```

`twa-manifest.json` is the source of truth (packageId `ai.hader.app`, brand
oxblood theme, launches `/app/dashboard`, scope = whole origin). Bump
`appVersionCode` / `appVersionName` for each store update.

---

## Hosting assetlinks.json (Caddy)

The file must be served from the **origin root**, not under `/app`. Add this to
the portal's site block in [../../infra/caddy/Caddyfile](../../infra/caddy/Caddyfile)
(replace the fingerprint first), then reload Caddy:

```caddy
handle /.well-known/assetlinks.json {
    header Content-Type application/json
    respond `[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"ai.hader.app","sha256_cert_fingerprints":["<YOUR_SHA256>"]}}]` 200
}
```

Verify: `curl https://hader.ai/.well-known/assetlinks.json` returns the JSON, and
the app opens full-screen (no URL bar) after reinstall.

---

## Play Store (later)

Upload the `.aab` to a Play internal-testing track. Requires a Google Play
Developer account ($25 one-time), a privacy policy URL, data-safety form, and
store listing assets. Keep the **upload keystore** (`android.keystore`) safe —
losing it means you can't push updates under the same app.
