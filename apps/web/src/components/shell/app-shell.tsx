'use client';

import { Menu, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';

import { CommandPaletteProvider, useCommandPalette } from './command-palette';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

// localStorage key for the persisted collapse preference.
const COLLAPSED_KEY = 'aligned:sidebar:collapsed';

// The ⌘K trigger — a search-box affordance so the command palette is
// discoverable (not just a hidden hotkey). Full pill on desktop, icon on mobile.
function CommandTrigger() {
  const { open } = useCommandPalette();
  return (
    <>
      <button
        onClick={open}
        className="hidden h-8 items-center gap-2 rounded-md border border-border bg-surface-muted pl-2.5 pr-1.5 text-sm text-foreground-subtle transition-colors hover:border-border-strong hover:text-foreground-muted sm:flex"
        aria-label="Open command palette"
      >
        <Search className="size-4" />
        <span>Search…</span>
        <Kbd className="ml-2">⌘K</Kbd>
      </button>
      <Button variant="ghost" size="icon" onClick={open} className="sm:hidden" aria-label="Search">
        <Search className="size-5" />
      </Button>
    </>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
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

  return (
    <CommandPaletteProvider>
      <div className="flex h-dvh bg-surface-muted">
        <aside
          className={`hidden h-dvh shrink-0 border-r border-border bg-surface transition-[width] duration-200 ease-in-out lg:block ${
            collapsed ? 'w-[4.25rem]' : 'w-60'
          }`}
        >
          <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        </aside>

        {/* Mobile sidebar drawer */}
        {mobileOpen ? (
          <div
            className="fixed inset-0 z-40 bg-foreground/30 lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
        ) : null}
        <aside
          className={`fixed inset-y-0 left-0 z-50 w-60 transform border-r border-border bg-surface transition-transform lg:hidden ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <Sidebar onNavigate={() => setMobileOpen(false)} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 lg:px-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="size-5" />
            </Button>
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
            <CommandTrigger />
            <TopBar />
          </header>
          <main className="flex-1 overflow-y-auto">
            <div className="container-page space-y-5 py-6">{children}</div>
          </main>
        </div>
      </div>
    </CommandPaletteProvider>
  );
}
