'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useSession } from '@/lib/session';

import { DEFAULT_LAYOUT, WIDGETS_BY_ID, type WidgetId } from './widget-registry';

// localStorage-backed layout persistence. Per-user (keyed by user id) so
// two operators sharing a browser don't collide on each other's saved
// layouts. localStorage is the right tool here: this is a UI preference,
// not state we'd ever want to read from another device — and a backend
// endpoint is overkill for "which 6 of 8 widgets do I want visible".
//
// The hook also exposes onboarding-dismissed as a separate flag — the
// onboarding banner has its own "hide" affordance that lives outside the
// widget-bank Edit mode (per spec).

const STORAGE_VERSION = 1;
const STORAGE_PREFIX = 'aligned-dashboard-layout';
const ONBOARDING_DISMISSED_PREFIX = 'aligned-dashboard-onboarding-dismissed';

interface StoredLayout {
  v: number;
  widgets: WidgetId[];
}

function storageKey(userId: string | null): string {
  return `${STORAGE_PREFIX}:${userId ?? 'anonymous'}`;
}

function onboardingKey(userId: string | null): string {
  return `${ONBOARDING_DISMISSED_PREFIX}:${userId ?? 'anonymous'}`;
}

function loadLayout(userId: string | null): WidgetId[] {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT;
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as StoredLayout;
    if (!parsed || parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.widgets)) {
      return DEFAULT_LAYOUT;
    }
    // Drop any ids that no longer exist in the registry (a widget was
    // renamed / removed since the operator last saved). Idempotent —
    // it's fine to write back the same shape.
    return parsed.widgets.filter((id): id is WidgetId => id in WIDGETS_BY_ID);
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function saveLayout(userId: string | null, widgets: WidgetId[]): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: StoredLayout = { v: STORAGE_VERSION, widgets };
    window.localStorage.setItem(storageKey(userId), JSON.stringify(payload));
  } catch {
    /* Quota errors etc. — silently ignore; the layout falls back to default. */
  }
}

export interface DashboardLayoutApi {
  /** Widgets the operator currently has on their dashboard, in render order. */
  visible: WidgetId[];
  /** Widgets not currently selected — surfaced in the Add-widget dialog. */
  hidden: WidgetId[];
  /** True when an id is on the operator's dashboard. */
  has: (id: WidgetId) => boolean;
  /** Add a hidden widget back onto the dashboard. No-op if already visible. */
  add: (id: WidgetId) => void;
  /** Remove a visible widget. No-op if already hidden. */
  remove: (id: WidgetId) => void;
  /** Restore every widget marked defaultOn — useful for "reset layout". */
  reset: () => void;
  /** Has the onboarding banner been dismissed for this user? */
  onboardingDismissed: boolean;
  /** Persist a dismissal of the onboarding banner. */
  dismissOnboarding: () => void;
}

export function useDashboardLayout(): DashboardLayoutApi {
  const { session } = useSession();
  const userId = session?.user.id ?? null;

  // Lazy initial state so the first render on the server matches the
  // first render in the browser (we read from localStorage in useEffect,
  // not in the initializer — Next.js SSR would crash otherwise).
  const [visible, setVisible] = useState<WidgetId[]>(DEFAULT_LAYOUT);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setVisible(loadLayout(userId));
    setOnboardingDismissed(
      typeof window !== 'undefined' &&
        window.localStorage.getItem(onboardingKey(userId)) === '1',
    );
    setHydrated(true);
  }, [userId]);

  const persist = useCallback(
    (next: WidgetId[]) => {
      setVisible(next);
      if (hydrated) saveLayout(userId, next);
    },
    [userId, hydrated],
  );

  const has = useCallback((id: WidgetId) => visible.includes(id), [visible]);

  const add = useCallback(
    (id: WidgetId) => {
      if (visible.includes(id)) return;
      // Insert in the registry's canonical order so the dashboard
      // reads top-to-bottom predictably regardless of click order.
      const order = Object.keys(WIDGETS_BY_ID) as WidgetId[];
      const next = [...visible, id].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      persist(next);
    },
    [visible, persist],
  );

  const remove = useCallback(
    (id: WidgetId) => {
      if (!visible.includes(id)) return;
      persist(visible.filter((x) => x !== id));
    },
    [visible, persist],
  );

  const reset = useCallback(() => {
    persist(DEFAULT_LAYOUT);
  }, [persist]);

  const dismissOnboarding = useCallback(() => {
    setOnboardingDismissed(true);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(onboardingKey(userId), '1');
      } catch {
        /* ignore */
      }
    }
  }, [userId]);

  const hidden = useMemo(() => {
    const all = Object.keys(WIDGETS_BY_ID) as WidgetId[];
    return all.filter((id) => !visible.includes(id));
  }, [visible]);

  return { visible, hidden, has, add, remove, reset, onboardingDismissed, dismissOnboarding };
}
