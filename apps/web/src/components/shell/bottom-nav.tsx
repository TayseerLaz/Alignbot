'use client';

// Mobile bottom tab bar — the native-app navigation for phones + the installed
// PWA. Hidden on desktop (lg+), where the sidebar is the primary nav. Shows the
// top few tenant destinations (feature-gated) plus a "More" button that opens
// the full drawer. Respects the iOS home-indicator via safe-area padding.

import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  CalendarCheck,
  Contact as ContactIcon,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  Menu,
  Package,
  ShoppingCart,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { isHrefDisabled } from '@aligned/shared';

import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  badge?: boolean;
}

// Priority-ordered; the first 4 that aren't feature-disabled become tabs, then
// "More" opens the drawer with everything else.
const CANDIDATES: Tab[] = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard, exact: true },
  { href: '/inbox', label: 'Inbox', icon: Inbox, badge: true },
  { href: '/products', label: 'Products', icon: Package },
  { href: '/cart', label: 'Orders', icon: ShoppingCart },
  { href: '/contacts', label: 'Contacts', icon: ContactIcon },
  { href: '/bookings', label: 'Bookings', icon: CalendarCheck },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
];

export function BottomNav({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  const { session } = useSession();
  const disabled = session?.organization?.disabledFeatures ?? [];
  const tabs = CANDIDATES.filter((t) => !isHrefDisabled(t.href, disabled)).slice(0, 4);

  // Shares the sidebar's query key so react-query dedupes the request.
  const counts = useQuery({
    enabled: !!session,
    queryKey: ['sidebar-inbox-counts'],
    queryFn: () =>
      api.get<{ data: { escalated: number; pending: number; open: number } }>('/api/v1/inbox/counts'),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  const escalated = counts.data?.data.escalated ?? 0;

  const isActive = (t: Tab) => (t.exact ? pathname === t.href : pathname.startsWith(t.href));

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 backdrop-blur lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = isActive(t);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-label={t.label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
                active ? 'text-brand-500' : 'text-foreground-subtle hover:text-foreground-muted',
              )}
            >
              <Icon className="size-5" />
              <span className="truncate">{t.label}</span>
              {t.badge && escalated > 0 ? (
                <span className="absolute right-[24%] top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-coral-500 px-1 text-[9px] font-semibold text-white">
                  {escalated > 9 ? '9+' : escalated}
                </span>
              ) : null}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={onMore}
          aria-label="More"
          className="flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium text-foreground-subtle transition-colors hover:text-foreground-muted"
        >
          <Menu className="size-5" />
          <span>More</span>
        </button>
      </div>
    </nav>
  );
}
