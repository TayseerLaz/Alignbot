'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  Briefcase,
  Building2,
  CalendarCheck,
  Code2,
  Contact as ContactIcon,
  CreditCard,
  ExternalLink,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  Megaphone,
  Package,
  ScanSearch,
  Settings,
  ShieldCheck,
  ShieldOff,
  ShoppingCart,
  TrendingUp,
  Upload,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { AlignedLogo } from '@/components/brand/logo';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  // When set, the sidebar reads `badges[badgeKey]` and renders a red
  // pill next to the item label. Keeps badge wiring centralised so
  // adding new badges is just (a) plumb a number through useBadges
  // and (b) tag the matching nav item.
  badgeKey?: BadgeKey;
  // When set, the item opens in a dedicated, reused browser tab (named
  // target) instead of navigating in place — used for the chrome-less,
  // full-screen Inbox workspace. `rel="noopener"` is applied so the new
  // tab can't reach back into this one (anti tab-nabbing).
  newTab?: boolean;
}

type BadgeKey = 'inboxEscalated' | 'leadsNew';

interface NavGroup {
  label: string;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, exact: true }],
  },
  // Engagement promoted directly under the Dashboard so day-to-day
  // customer-facing work (inbox, broadcasts, contacts) is the first
  // thing in reach. Bookings + Orders moved out into Operations since
  // they live in their own queues. Templates + Broadcasts collapsed
  // into a single sidebar entry that opens a tabbed page (the /broadcasts
  // page now hosts both as tabs alongside Sequences).
  {
    label: 'Engagement',
    items: [
      { href: '/contacts', label: 'Contacts', icon: ContactIcon },
      // Opens the bigger, chrome-less inbox in its own (reused) tab.
      { href: '/inbox-full', label: 'Inbox', icon: Inbox, badgeKey: 'inboxEscalated', newTab: true },
      { href: '/inbox/canned', label: 'Canned replies', icon: Inbox },
      // Standalone /whatsapp/templates URL still resolves — operators
      // who deep-linked into it before still get there. Sidebar only
      // surfaces the unified entry.
      { href: '/broadcasts', label: 'Templates & broadcasts', icon: Megaphone },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { href: '/products', label: 'Products', icon: Package },
      { href: '/services', label: 'Services', icon: Briefcase },
      { href: '/categories', label: 'Categories', icon: Building2 },
    ],
  },
  // Operations — was "Intelligence". Renamed because the content is the
  // operational queues operators check throughout the day (bookings,
  // orders) plus the analytics that measure them, not "AI-flavoured"
  // tools. The AI bot builder moved to Workspace as a one-time setup
  // task; this group is for daily ops.
  {
    label: 'Operations',
    items: [
      { href: '/bookings', label: 'Bookings', icon: CalendarCheck },
      { href: '/cart', label: 'Orders', icon: ShoppingCart },
      { href: '/analytics', label: 'Analytics', icon: TrendingUp },
    ],
  },
  // Integrations section (API connectors / API keys / Webhooks) hidden
  // from the sidebar — those routes still exist for direct-URL access,
  // but normal operators don't need to see them. Re-add a group here
  // to surface them again.
  // WhatsApp section hidden from the sidebar — the channel connection
  // lives under /settings → Integrations now, and Templates moved into
  // the Engagement group above. Routes (/whatsapp, /whatsapp/templates,
  // /whatsapp/onboarding) still resolve by direct URL.
  {
    label: 'Workspace',
    items: [
      // Catalog metadata + the bot builder collapsed in here so the
      // Catalog/Operations groups stay focused on tenant content vs.
      // tenant configuration.
      { href: '/business-info', label: 'Business info', icon: Building2 },
      { href: '/imports', label: 'Imports', icon: Upload },
      { href: '/bot', label: 'AI bot builder', icon: Bot },
      { href: '/members', label: 'Members', icon: Users },
      { href: '/audit-log', label: 'Activity log', icon: Activity },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

const alignedAdminItems: NavItem[] = [
  { href: '/aligned-admin', label: 'Tenants', icon: ShieldCheck },
  { href: '/aligned-admin/leads', label: 'Leads', icon: UserPlus, badgeKey: 'leadsNew' },
  { href: '/aligned-admin/system', label: 'System health', icon: Code2 },
  { href: '/aligned-admin/audit', label: 'Cross-tenant audit', icon: Activity },
  { href: '/aligned-admin/provenance', label: 'AI provenance', icon: ScanSearch },
  { href: '/aligned-admin/provenance/suppressions', label: 'Suppression list', icon: ShieldOff },
  { href: '/aligned-admin/revenue', label: 'Revenue', icon: CreditCard },
];

export function Sidebar({
  onNavigate,
  collapsed = false,
}: { onNavigate?: () => void; collapsed?: boolean; onToggleCollapsed?: () => void } = {}) {
  const pathname = usePathname();
  const { session } = useSession();

  // Poll the lightweight counts endpoint every 30s so the Inbox badge
  // stays roughly fresh without thrashing the API. Skip when there's
  // no active session — useSession returns null while resolving and
  // the API would 401 anyway.
  const counts = useQuery({
    enabled: !!session,
    queryKey: ['sidebar-inbox-counts'],
    queryFn: () =>
      api.get<{ data: { escalated: number; pending: number; open: number } }>(
        '/api/v1/inbox/counts',
      ),
    // Refetch every 10s as a fallback so the operator sees new
    // escalations within that window even without an active SSE
    // connection. The inbox page additionally invalidates this query
    // on every SSE tick for instant updates while they're on /inbox.
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  // ALIGNED admins only: poll the new-lead count for the Leads badge.
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

  const isActive = (item: NavItem) => (item.exact ? pathname === item.href : pathname.startsWith(item.href));

  // When collapsed: the row strips down to a centred icon with the
  // label rendered as a native tooltip via `title=` so the operator
  // can still identify each link without giving up screen real estate.
  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    // A new-tab item is never the "current" page in this tab, so it never
    // gets the active highlight.
    const active = !item.newTab && isActive(item);
    const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0;
    const showBadge = badgeCount > 0;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        // Named target → repeated clicks reuse the SAME tab instead of
        // spawning a new one each time. noopener/noreferrer hardens it.
        target={item.newTab ? 'aligned-inbox' : undefined}
        rel={item.newTab ? 'noopener noreferrer' : undefined}
        prefetch={item.newTab ? false : undefined}
        title={
          collapsed
            ? `${item.label}${item.newTab ? ' (opens in a new tab)' : ''}${showBadge ? ` (${badgeCount})` : ''}`
            : item.newTab
              ? 'Opens the full-screen inbox in its own tab'
              : undefined
        }
        aria-label={item.newTab ? `${item.label} (opens in a new tab)` : item.label}
        className={cn(
          'relative flex items-center rounded-full text-sm font-medium transition-all duration-150',
          collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-4 py-2.5',
          active
            ? 'bg-brand-500 text-on-brand shadow-brand'
            : 'text-foreground-muted hover:bg-surface-muted hover:text-foreground',
        )}
      >
        <Icon className="size-4 shrink-0" />
        {collapsed ? null : <span className="truncate">{item.label}</span>}
        {!collapsed && item.newTab ? (
          <ExternalLink className="ml-auto size-3.5 shrink-0 opacity-50" aria-hidden />
        ) : null}
        {showBadge ? (
          collapsed ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
              {badgeCount > 9 ? '9+' : badgeCount}
            </span>
          ) : (
            <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">
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
          collapsed ? 'justify-center px-2' : 'px-5',
        )}
      >
        <AlignedLogo iconOnly={collapsed} />
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto p-3">
        {groups.map((group) => (
          <div key={group.label} className="space-y-1">
            {/* Hide group headers when collapsed — the icons themselves
                are the only grouping the operator needs at that width. */}
            {!collapsed ? (
              <p className="px-4 pb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-foreground-subtle">
                {group.label}
              </p>
            ) : null}
            {group.items.map(renderItem)}
          </div>
        ))}

        {session?.user.isAlignedAdmin ? (
          <div className="space-y-1 border-t border-border pt-6">
            {!collapsed ? (
              <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-brand-500">
                Hader admin
              </p>
            ) : null}
            {alignedAdminItems.map(renderItem)}
          </div>
        ) : null}
      </nav>
    </div>
  );
}
