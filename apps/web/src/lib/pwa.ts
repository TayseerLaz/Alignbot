'use client';

// Shared PWA install state. A single module-level listener captures the
// browser's `beforeinstallprompt` (it fires once, early), and components
// subscribe via usePwaInstall(). Lets the top-nav "Open in app" button trigger
// the install, and hides itself once the app runs standalone (already installed).

import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let started = false;
const subs = new Set<() => void>();

function emit() {
  subs.forEach((s) => s());
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    emit();
  });
}

/**
 * True when the portal is running as the installed app (not a browser tab).
 * Covers EVERY installed display mode — a desktop PWA may run in `minimal-ui` or
 * `window-controls-overlay` (our manifest's display_override lists minimal-ui),
 * not just `standalone` — plus iOS (`navigator.standalone`) and Android TWAs.
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const mql = window.matchMedia;
  if (mql) {
    for (const mode of ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay']) {
      try {
        if (mql(`(display-mode: ${mode})`).matches) return true;
      } catch {
        /* ignore unsupported queries */
      }
    }
  }
  if ((window.navigator as unknown as { standalone?: boolean }).standalone === true) return true;
  if (typeof document !== 'undefined' && document.referrer.startsWith('android-app://')) return true;
  return false;
}

export function usePwaInstall() {
  start();
  const [, force] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const s = () => force((n) => n + 1);
    subs.add(s);
    return () => {
      subs.delete(s);
    };
  }, []);

  return {
    // Avoid SSR/hydration flash: callers should wait for `mounted` before
    // deciding visibility (standalone can only be read client-side).
    mounted,
    isStandalone: mounted ? isStandaloneDisplay() : false,
    canPrompt: !!deferred,
    installed,
    /** Fire the native install prompt. Returns false if the browser didn't offer one. */
    async promptInstall(): Promise<boolean> {
      if (!deferred) return false;
      try {
        await deferred.prompt();
        await deferred.userChoice;
      } catch {
        /* ignore */
      }
      deferred = null;
      emit();
      return true;
    },
  };
}
