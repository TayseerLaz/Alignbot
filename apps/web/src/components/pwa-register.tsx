'use client';

// PWA runtime: registers the service worker (SW lives at /app/sw.js, Next.js
// basePath = /app → scope /app/). The install / "Open in app" affordance now
// lives in the top nav (components/shell/pwa-install-button + lib/pwa), which
// owns the single `beforeinstallprompt` capture.

import { useEffect } from 'react';

export function PwaRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    const register = () => {
      navigator.serviceWorker
        .register('/app/sw.js', { scope: '/app/' })
        .catch((err) => console.error('[PWA] SW registration failed:', err));
    };
    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
