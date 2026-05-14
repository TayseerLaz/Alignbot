'use client';

import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

// localStorage key for the persisted collapse preference. Stored as
// "1" (collapsed) or "0" (expanded); read on mount, updated on toggle.
const COLLAPSED_KEY = 'aligned:sidebar:collapsed';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  // Start expanded by default, then read the saved preference on mount
  // so the initial server-rendered tree matches and we don't flash a
  // collapse-then-expand on hydration.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(COLLAPSED_KEY);
      if (saved === '1') setCollapsed(true);
    } catch {
      /* localStorage blocked → keep default */
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* noop */
      }
      return next;
    });
  };

  // Brand-blue glass sidebar — same gradient family as the login page.
  // The aside fills the full column; the sidebar component renders
  // glass pill rows on top of it.
  const sidebarBg =
    'bg-[radial-gradient(ellipse_120%_60%_at_50%_0%,#1F4A78_0%,#0E2747_45%,#061224_100%)]';

  return (
    <div className="flex min-h-dvh bg-surface-muted">
      {/* Desktop sidebar — width animates between full (16rem) and
          icon-only (4.5rem). */}
      <aside
        className={`hidden shrink-0 text-white transition-[width] duration-200 ease-in-out lg:block ${sidebarBg} ${
          collapsed ? 'w-[4.5rem]' : 'w-64'
        }`}
      >
        <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      </aside>

      {/* Mobile sidebar drawer */}
      {mobileOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      ) : null}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 transform text-white transition-transform lg:hidden ${sidebarBg} ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar onNavigate={() => setMobileOpen(false)} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-white px-4 lg:px-6">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileOpen(true)}
            className="lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </Button>
          {/* Desktop-only collapse/expand toggle in the top bar so it's
              always reachable even when the sidebar is icons-only and
              its inner toggle isn't visible. */}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleCollapsed}
            className="hidden lg:inline-flex"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
          </Button>
          <TopBar />
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="container-page py-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
