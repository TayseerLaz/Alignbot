# Hader — Native Mobile App Plan (Capacitor → App Store + Google Play)

> **Status:** PLAN (no code yet). Owner sign-off required before Phase 1.
> **Decision locked:** Capacitor (native shell for iOS + Android), not a thin TWA.
> **Goal:** Ship the Hader portal as a real, installable mobile app that *feels
> native* (not a browser tab), distributable as a signed Android `.aab`/`.apk`
> and iOS `.ipa`, and publishable to both stores.

---

## 1. Where we are today

- The portal is `apps/web` — **Next.js 15 App Router**, served under
  `basePath: '/app'` at `https://hader.ai/app`, talking to a **separate API
  origin** `https://api.hader.ai`.
- It is already a **PWA**: [manifest.webmanifest](../apps/web/public/manifest.webmanifest),
  [sw.js](../apps/web/public/sw.js), [offline.html](../apps/web/public/offline.html),
  icon set, SW registration ([pwa-register.tsx](../apps/web/src/components/pwa-register.tsx)),
  and an in-app install button ([pwa-install-button.tsx](../apps/web/src/components/shell/pwa-install-button.tsx) / [pwa.ts](../apps/web/src/lib/pwa.ts)).
- Auth: in-memory **Bearer** access token + **httpOnly refresh cookie**
  (`sameSite: 'lax'`, domain `*.hader.ai`) refreshed against `api.hader.ai`
  with `credentials: 'include'` ([api.ts](../apps/web/src/lib/api.ts),
  [session.tsx](../apps/web/src/lib/session.tsx)).
- Shell: sidebar + top bar + mobile **drawer** ([app-shell.tsx](../apps/web/src/components/shell/app-shell.tsx),
  [sidebar.tsx](../apps/web/src/components/shell/sidebar.tsx)). Responsive, but
  laid out like a desktop dashboard, not a phone app.

### Two hard constraints that shape everything

1. **The app is SSR, not static.** It uses middleware (per-request CSP nonce),
   a server `redirect()` on `/`, and `headers()` in the root layout. It cannot
   be `next export`'d into a static bundle without a real SPA refactor. →
   Capacitor should **load the hosted site** (`server.url`) rather than bundle
   assets, at least for Phase 1.

2. **Auth is cookie-based and cross-origin.** It works in a browser only
   because `hader.ai` and `api.hader.ai` are *same-site*. Inside a native
   WebView this is fragile (iOS WKWebView / ITP), and if we ever bundle assets
   (origin `capacitor://localhost`) it **breaks outright** (cross-site → Lax
   cookie never sent). → We need a **native token auth mode** (below). This is
   the single biggest technical risk.

---

## 2. Architecture decision

**Capacitor in "hosted" mode for Phase 1.** A new `apps/mobile` Capacitor
project whose `server.url` points at `https://hader.ai/app` (prod) or a LAN dev
URL locally. The native shell provides the app identity, splash, status bar,
push, secure storage, deep links, and back-button handling; the UI is the same
Next.js app we already ship — so web and mobile never diverge.

```
apps/
  web/        # existing Next.js portal (unchanged runtime)
  mobile/     # NEW — Capacitor project
    capacitor.config.ts   # server.url + plugins
    ios/                  # generated native Xcode project (committed)
    android/              # generated native Gradle project (committed)
    resources/            # source icon + splash for asset generation
```

**Why hosted, not bundled:**
- Zero SSR refactor; middleware/redirects/fonts keep working.
- One deploy updates web *and* the app content instantly (no store round-trip
  for content/logic changes — only native-shell changes need resubmission).
- The existing service worker still provides offline caching inside the WebView.

**Trade-off / future option:** hosted mode needs a network on first launch
(mitigated by the SW cache + a native splash/offline screen). A later phase can
migrate to a **bundled SPA** for true offline-first and faster cold start —
but that requires the SPA refactor in §Appendix A and is explicitly out of
scope for v1.

**iOS App Store risk (Guideline 4.2 "minimum functionality"):** Apple rejects
apps that are "just a website in a webview." We de-risk by shipping genuine
native capabilities: **push notifications**, native splash/status-bar/haptics,
offline handling, deep links, and an app-like bottom-tab UX. This is the reason
we chose Capacitor over a TWA/PWABuilder wrapper.

---

## 3. Workstreams

### A. Native token auth (highest priority — unblocks everything)

The refresh-cookie model won't survive a native WebView reliably. Add a
**native session mode** parallel to the existing cookie flow:

- API: on `login` / `refresh` / `switch-org`, when the client identifies as
  native (e.g. header `X-Client: hader-native` or a `/auth/native/*` route),
  return the **refresh token in the JSON body** instead of (or in addition to)
  the `Set-Cookie`. Keep rotation + reuse-detection identical.
- App: store the refresh token in **Capacitor Preferences / Secure Storage**
  (Keychain on iOS, Keystore-backed on Android), not in JS memory or cookies.
- App: teach [api.ts](../apps/web/src/lib/api.ts) to detect the native runtime
  (`Capacitor.isNativePlatform()`) and, in that mode, send the stored refresh
  token explicitly (header/body) rather than relying on `credentials: 'include'`.
- Keep the browser path 100% unchanged (cookie flow stays for the web PWA).

**Deliverable:** login persists across app restarts on a real device with no
cookie dependency. This is the gate for Phase 1 sign-off.

### B. Mobile app-shell UI (makes it feel like an app)

Driven by a `standalone`/native detector (extend [pwa.ts](../apps/web/src/lib/pwa.ts)):

- **Bottom tab bar** on mobile (Inbox, Catalog, Dashboard, More) replacing the
  hamburger drawer as the primary nav; drawer/sidebar stays for desktop.
- **Safe-area insets** (`env(safe-area-inset-*)`) for notches/home indicator;
  `viewport-fit=cover` is already set.
- Hide web-only chrome in native (the "Install"/"Open in app" button, any
  "open in browser" hints).
- Native **back button** (Android) wired to router history via Capacitor `App`
  plugin; prevent accidental app-exit mid-flow.
- Momentum/scroll + pull-to-refresh behavior tuned; disable long-press callouts
  and text-selection where it feels non-native.
- **Status bar** + **splash screen** themed to brand oxblood `#360516`.
- Loading/skeleton polish so cold start doesn't flash a white page.

### C. Native plugins & platform integration

- `@capacitor/splash-screen`, `@capacitor/status-bar`, `@capacitor/keyboard`,
  `@capacitor/app` (back button, deep-link events, appstate),
  `@capacitor/preferences` (token storage), `@capacitor/haptics`.
- **Push notifications** (`@capacitor/push-notifications`): APNs (iOS) + FCM
  (Android). Requires: a device-token **registration endpoint** on the API, a
  `device_tokens` table (org/user scoped, RLS), and a send path (wire into the
  existing notification system + BullMQ). Map existing in-app notifications
  (new message, booking, quota) to push.
- **Deep links / Universal Links:** password-reset, invite, and billing-return
  links currently point at `hader.ai/app/...`. Configure **Universal Links**
  (iOS `apple-app-site-association`) and **App Links** (Android `assetlinks.json`)
  so those URLs open the app. Both files are served from the API/web at the
  domain root.

### D. Build, signing & release engineering

- **Android:** generate a signed **`.aab`** (Play) + `.apk` (sideload/testing).
  Create an upload keystore; store secrets in GitHub Actions (or build locally
  first). Set `applicationId` (e.g. `ai.hader.app`), versionCode/versionName.
- **iOS:** requires **macOS + Xcode** (cannot build iOS on this Windows box).
  Apple Developer account, signing certs, provisioning profiles, bundle id
  (e.g. `ai.hader.app`). Build `.ipa` via Xcode/Fastlane.
- **CI (optional, later):** Fastlane lanes for both; iOS needs a macOS runner.
  Phase 1 can be manual local builds to get a device-installable artifact fast.

### E. Store submission

- **Google Play:** $25 one-time. Data-safety form, content rating, privacy
  policy URL, listing copy, screenshots (phone + tablet), feature graphic.
  Internal-testing track first → closed → production.
- **Apple App Store:** $99/yr. App privacy nutrition labels, screenshots per
  device class, review notes with a **demo account**, and 4.2 mitigations called
  out explicitly. TestFlight first.
- Reusable assets: adapt the existing brand icon; generate all store sizes +
  screenshots from real app screens.

---

## 4. Phasing & milestones

| Phase | Outcome | Gate |
|---|---|---|
| **0. Plan sign-off** | This doc approved; accounts + bundle id + `ai.hader.app` confirmed | Owner OK |
| **1. Native auth + shell boot** | `apps/mobile` Capacitor project loads `hader.ai/app`; native token auth persists login; brand splash/status bar | Login survives app restart on a real Android device |
| **2. App-like UX** | Bottom-tab nav, safe-areas, back-button, native chrome hidden | Feels like an app, not a webview, on device |
| **3. Push + deep links** | Push registration + delivery; Universal/App Links open the app | Test push received; reset link opens app |
| **4. Android release** | Signed `.aab`, Play internal testing live | Installable from Play internal track |
| **5. iOS release** | Xcode build, TestFlight | Runs via TestFlight; passes internal 4.2 review |
| **6. Store launch** | Production submissions both stores | Approved + live |

Phases 1–3 are mostly shared code in `apps/web` + `apps/mobile` and buildable
on Windows for Android. **Phase 5 (iOS) needs a Mac.**

---

## 5. Prerequisites the owner must provide

- [ ] **Bundle / application id** (proposed `ai.hader.app`) — permanent, pick now.
- [ ] **Apple Developer Program** membership ($99/yr) + a **Mac with Xcode** for iOS builds.
- [ ] **Google Play Developer** account ($25 one-time).
- [ ] **FCM project** (Android push) + **APNs key** (iOS push).
- [ ] **Android upload keystore** (we can generate) stored securely.
- [ ] Public **privacy policy** URL (both stores require it).
- [ ] Confirmation that the API team is OK adding the **native auth mode** + the
      **device-token/push** endpoints (Workstreams A & C touch `apps/api`).

---

## 6. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| WebView cookie auth breaks (iOS ITP / cross-site) | App can't stay logged in | **Native token auth** (Workstream A) — do this first |
| Apple 4.2 "just a webview" rejection | iOS launch blocked | Native push, splash, deep links, app-like UX; Capacitor not TWA |
| SSR app not bundlable | No offline-first v1 | Hosted `server.url` mode; SW caching; static refactor deferred (Appendix A) |
| CSP blocks WebView | Blank app | Allow the native origin (`capacitor://localhost`, `https://localhost`) in `connect-src`/`frame-ancestors` as needed in [middleware.ts](../apps/web/src/middleware.ts) |
| iOS builds need macOS | Can't build on current machine | Plan a Mac / cloud-mac (e.g. macincloud, or a CI macOS runner) for Phase 5 |
| Content updates vs. native updates | Confusion over what needs resubmission | Hosted mode: web deploys are instant; only native-shell changes need store review |

---

## Appendix A — (Deferred) fully-bundled SPA option

If we later want true offline-first / no-network cold start, migrate the portal
to a static SPA: drop `basePath` server coupling, replace middleware-CSP with a
build-time policy, convert the `/` server redirect + `headers()` usage to
client logic, and `output: 'export'`. This mandates the native token auth from
Workstream A (already planned) and is a multi-day refactor — **out of scope for
v1**, revisit after the stores are live.

---

## Appendix B — What this does NOT change

- The web PWA at `hader.ai/app` keeps working exactly as-is (browser install
  path unchanged).
- No changes to tenant isolation, RLS, or the API's existing cookie flow — the
  native mode is additive.
