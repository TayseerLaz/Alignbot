'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Bot,
  Briefcase,
  Building2,
  CalendarCheck,
  Contact as ContactIcon,
  ExternalLink,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  Megaphone,
  Package,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Tags,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { isHrefDisabled } from '@aligned/shared';

import { AlignedLogo } from '@/components/brand/logo';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  badgeKey?: BadgeKey;
  newTab?: boolean;
}

type BadgeKey = 'inboxEscalated' | 'leadsNew';

interface NavGroup {
  label: string;
  items: NavItem[];
}

// Clearer information architecture: five plain-language groups that map a
// tenant's mental model (what I do daily · what I sell · transactions · setup).
// Advanced integrations (connectors/webhooks/API keys) are SURFACED under
// Configure instead of hidden — discoverable, just out of the daily path.
const groups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, exact: true },
      { href: '/analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    label: 'Operate',
    items: [
      { href: '/inbox-full', label: 'Inbox', icon: Inbox, badgeKey: 'inboxEscalated', newTab: true },
      { href: '/contacts', label: 'Contacts', icon: ContactIcon },
      { href: '/broadcasts', label: 'Broadcasts', icon: Megaphone },
      // Canned replies moved INTO the inbox (a dialog from the inbox header),
      // so it's no longer a separate nav item. The /inbox/canned route still
      // resolves for deep links + the command palette.
    ],
  },
  {
    label: 'Business',
    items: [
      { href: '/products', label: 'Products', icon: Package },
      { href: '/services', label: 'Services', icon: Briefcase },
      { href: '/categories', label: 'Categories', icon: Tags },
      { href: '/business-info', label: 'Business info', icon: Building2 },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { href: '/cart', label: 'Orders', icon: ShoppingCart },
      { href: '/bookings', label: 'Bookings', icon: CalendarCheck },
    ],
  },
  {
    label: 'Configure',
    items: [
      { href: '/bot', label: 'AI bot builder', icon: Bot },
      // Bulk import lives contextually on Products / Services / Business info now
      // (a "Bulk import" button per page). /imports route + ⌘K still work.
      { href: '/members', label: 'Members', icon: Users },
      { href: '/audit-log', label: 'Activity log', icon: Activity },
      // Developer integrations (Connectors / Webhooks / API keys) live under
      // Settings now, not the nav. Routes still resolve + the command palette
      // (⌘K) still reaches them.
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

const alignedAdminItems: NavItem[] = [
  { href: '/aligned-admin', label: 'Tenants', icon: ShieldCheck },
  { href: '/aligned-admin/leads', label: 'Leads', icon: UserPlus, badgeKey: 'leadsNew' },
  { href: '/aligned-admin/system', label: 'System health', icon: Activity },
];

export function Sidebar({
  onNavigate,
  collapsed = false,
}: { onNavigate?: () => void; collapsed?: boolean; onToggleCollapsed?: () => void } = {}) {
  const pathname = usePathname();
  const { session } = useSession();

  const counts = useQuery({
    enabled: !!session,
    queryKey: ['sidebar-inbox-counts'],
    queryFn: () =>
      api.get<{ data: { escalated: number; pending: number; open: number } }>('/api/v1/inbox/counts'),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const leadsCount = useQuery({
    enabled: !!session?.user.isAlignedAdmin,
    queryKey: ['sidebar-leads-count'],
    queryFn: () =>
      api.get<{ data: { new: number; total: number } }>('/api/v1/aligned-admin/leads/count'),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const badges: Record<BadgeKey, number> = {
    inboxEscalated: counts.data?.data.escalated ?? 0,
    leadsNew: leadsCount.data?.data.new ?? 0,
  };

  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const visibleGroups = groups
    .map((g) => ({ ...g, items: g.items.filter((it) => !isHrefDisabled(it.href, disabledFeatures)) }))
    .filter((g) => g.items.length > 0);

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = !item.newTab && isActive(item);
    const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0;
    const showBadge = badgeCount > 0;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        target={item.newTab ? 'aligned-inbox' : undefined}
        rel={item.newTab ? 'noopener noreferrer' : undefined}
        prefetch={item.newTab ? false : undefined}
        title={
          collapsed
            ? `${item.label}${item.newTab ? ' (new tab)' : ''}${showBadge ? ` (${badgeCount})` : ''}`
            : item.newTab
              ? 'Opens the full-screen inbox in its own tab'
              : undefined
        }
        aria-label={item.newTab ? `${item.label} (opens in a new tab)` : item.label}
        className={cn(
          'relative flex items-center rounded-md text-[13px] font-medium transition-colors duration-[var(--dur-fast)]',
          collapsed ? 'justify-center px-2 py-2' : 'gap-2.5 px-2.5 py-1.5',
          active
            ? 'bg-surface-elevated text-foreground'
            : 'text-foreground-muted hover:bg-surface-muted hover:text-foreground',
        )}
      >
        <Icon className={cn('size-4 shrink-0', active ? 'text-brand-500' : 'text-foreground-subtle')} />
        {collapsed ? null : <span className="truncate">{item.label}</span>}
        {!collapsed && item.newTab ? (
          <ExternalLink className="ml-auto size-3 shrink-0 opacity-40" aria-hidden />
        ) : null}
        {showBadge ? (
          collapsed ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-coral-500 px-1 text-[10px] font-semibold text-white">
              {badgeCount > 9 ? '9+' : badgeCount}
            </span>
          ) : (
            <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded bg-coral-500 px-1 text-[11px] font-semibold text-white">
              {badgeCount > 99 ? '99+' : badgeCount}
            </span>
          )
        ) : null}
      </Link>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          'flex h-14 items-center border-b border-border',
          collapsed ? 'justify-center px-2' : 'px-4',
        )}
      >
        <AlignedLogo iconOnly={collapsed} />
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto p-2.5">
        {visibleGroups.map((group) => (
          <div key={group.label} className="space-y-0.5">
            {!collapsed ? (
              <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground-subtle">
                {group.label}
              </p>
            ) : null}
            {group.items.map(renderItem)}
          </div>
        ))}

        {session?.user.isAlignedAdmin ? (
          <div className="space-y-0.5 border-t border-border pt-4">
            {!collapsed ? (
              <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-500">
                ALIGNED HQ
              </p>
            ) : null}
            {alignedAdminItems.map(renderItem)}
          </div>
        ) : null}
      </nav>
    </div>
  );
}
