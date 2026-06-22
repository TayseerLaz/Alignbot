'use client';

import { isHrefDisabled } from '@aligned/shared';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { AppShell } from '@/components/shell/app-shell';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/lib/session';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, session } = useSession();

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  // ALIGNED-admin per-tenant access control: if the current page belongs to a
  // feature the admin disabled for this org, bounce away. (Sidebar already
  // hides it; this stops direct-URL access.) Manual-inbox tenants (AI off, not
  // a platform admin) land on the inbox instead of the empty dashboard.
  useEffect(() => {
    if (status !== 'authenticated' || !pathname) return;
    const disabled = session?.organization?.disabledFeatures ?? [];
    const isAdmin = session?.user.isAlignedAdmin === true;
    const manualInbox = !isAdmin && disabled.includes('ai');
    if (manualInbox && (pathname === '/dashboard' || pathname === '/')) {
      router.replace('/inbox');
      return;
    }
    if (isHrefDisabled(pathname, disabled)) {
      router.replace(manualInbox ? '/inbox' : '/dashboard');
    }
  }, [status, pathname, session, router]);

  if (status !== 'authenticated') {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="w-48 space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}
