'use client';

// PWA runtime: registers the service worker and surfaces a branded
// "install app" prompt when the browser offers one (`beforeinstallprompt`).
//
// • SW lives at /app/sw.js (Next.js basePath = /app) → scope /app/.
// • The install banner is dismissible and remembers the dismissal so we don't
//   nag on every visit.
// • iOS/Safari never fires beforeinstallprompt, so the banner simply won't
//   appear there — installation happens via Share → "Add to Home Screen".

import { Download, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'hader:pwa-install-dismissed';

export function PwaRegister() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // ── Register the service worker ──────────────────────────────────────
    if ('serviceWorker' in navigator) {
      const register = () => {
        navigator.serviceWorker
          .register('/app/sw.js', { scope: '/app/' })
          .catch((err) => console.error('[PWA] SW registration failed:', err));
      };
      if (document.readyState === 'complete') register();
      else window.addEventListener('load', register, { once: true });
    }

    // ── Capture the install prompt ───────────────────────────────────────
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      let dismissed = false;
      try {
        dismissed = localStorage.getItem(DISMISS_KEY) === '1';
      } catch {
        /* private mode — show it anyway */
      }
      if (!dismissed) setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      setDeferred(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    try {
      await deferred.userChoice;
    } catch {
      /* ignore */
    }
    setDeferred(null);
    setVisible(false);
  };

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Install Hader app"
      className={cn(
        'fixed inset-x-4 bottom-4 z-[60] mx-auto max-w-sm rounded-2xl border p-4 shadow-lg',
        'bg-card border-border text-foreground',
        'sm:left-auto sm:right-4 sm:mx-0',
      )}
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-muted"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex items-start gap-3 pr-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/app/icons/icon-192.png"
          alt=""
          className="h-11 w-11 shrink-0 rounded-xl border border-border"
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold">Install Hader</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            Add Hader to your home screen for a faster, full-screen, offline-ready experience.
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={install}
          className={cn(
            'inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2',
            'bg-brand-500 text-on-brand text-sm font-semibold hover:bg-brand-600 transition-colors',
          )}
        >
          <Download className="h-4 w-4" />
          Install
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
