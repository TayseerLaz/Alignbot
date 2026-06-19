'use client';

import { isHrefDisabled } from '@aligned/shared';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { AppShell } from '@/components/shell/app-shell';
import { useSession } from '@/lib/session';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, session } = useSession();

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  // ALIGNED-admin per-tenant access control: if the current page belongs to a
  // feature the admin disabled for this org, bounce to the dashboard. (Sidebar
  // already hides it; this stops direct-URL access.)
  useEffect(() => {
    if (status !== 'authenticated' || !pathname) return;
    const disabled = session?.organization?.disabledFeatures ?? [];
    if (isHrefDisabled(pathname, disabled)) router.replace('/dashboard');
  }, [status, pathname, session, router]);

  if (status !== 'authenticated') {
    return (
      <div className="grid min-h-dvh place-items-center text-sm text-foreground-muted">
        Loading…
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}
