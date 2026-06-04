'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import type { DashboardLayoutApi } from './use-dashboard-layout';

// Edit-mode is plumbed via context so every widget — wherever it sits
// in the tree — can render its ADD/KEEP badge without prop-drilling.
// The layout API rides along on the same context so a widget's
// "remove" button works without each widget re-binding the hook.

interface EditModeContextValue {
  editing: boolean;
  setEditing: (v: boolean) => void;
  layout: DashboardLayoutApi;
}

const EditModeContext = createContext<EditModeContextValue | null>(null);

export function EditModeProvider({
  layout,
  children,
}: {
  layout: DashboardLayoutApi;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const value = useMemo(() => ({ editing, setEditing, layout }), [editing, layout]);
  return <EditModeContext.Provider value={value}>{children}</EditModeContext.Provider>;
}

export function useEditMode(): EditModeContextValue {
  const ctx = useContext(EditModeContext);
  if (!ctx) {
    // Misconfiguration — every dashboard widget must render inside
    // EditModeProvider. Throwing produces a clearer signal than the
    // silent "badges never appear" the operator would otherwise see.
    throw new Error('useEditMode must be used within an EditModeProvider');
  }
  return ctx;
}
