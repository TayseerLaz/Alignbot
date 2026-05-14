'use client';

import {
  Activity,
  BarChart3,
  Bot,
  Briefcase,
  Building2,
  Code2,
  Contact as ContactIcon,
  CreditCard,
  Inbox,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  MessageCircle,
  Megaphone,
  Package,
  PlugZap,
  Settings,
  ShieldCheck,
  TrendingUp,
  Upload,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { AlignedLogo } from '@/components/brand/logo';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, exact: true }],
  },
  {
    label: 'Catalog',
    items: [
      { href: '/products', label: 'Products', icon: Package },
      { href: '/services', label: 'Services', icon: Briefcase },
      { href: '/categories', label: 'Categories', icon: Building2 },
      { href: '/business-info', label: 'Business info', icon: Building2 },
    ],
  },
  {
    label: 'Data',
    items: [
      { href: '/imports', label: 'Imports', icon: Upload },
      { href: '/connectors', label: 'API connectors', icon: PlugZap },
    ],
  },
  {
    label: 'Chatbot',
    items: [
      { href: '/api-keys', label: 'API keys', icon: KeyRound },
      { href: '/webhooks', label: 'Webhooks', icon: BarChart3 },
      { href: '/whatsapp', label: 'WhatsApp', icon: MessageCircle },
      { href: '/whatsapp/templates', label: 'Templates', icon: BarChart3 },
      { href: '/whatsapp/onboarding', label: 'Meta verification', icon: ShieldCheck },
      { href: '/inbox', label: 'Inbox', icon: Inbox },
      { href: '/inbox/canned', label: 'Canned replies', icon: Inbox },
      { href: '/bot', label: 'AI bot builder', icon: Bot },
      { href: '/analytics', label: 'Analytics', icon: TrendingUp },
    ],
  },
  {
    label: 'Outreach',
    items: [
      { href: '/contacts', label: 'Contacts', icon: ContactIcon },
      { href: '/segments', label: 'Segments', icon: Users },
      { href: '/broadcasts', label: 'Broadcasts', icon: Megaphone },
      { href: '/sequences', label: 'Sequences', icon: Activity },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/members', label: 'Members', icon: Users },
      { href: '/audit-log', label: 'Activity log', icon: Activity },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

const alignedAdminItems: NavItem[] = [
  { href: '/aligned-admin', label: 'Tenants', icon: ShieldCheck },
  { href: '/aligned-admin/system', label: 'System health', icon: Code2 },
  { href: '/aligned-admin/audit', label: 'Cross-tenant audit', icon: Activity },
  { href: '/aligned-admin/revenue', label: 'Revenue', icon: CreditCard },
];

export function Sidebar({
  onNavigate,
  collapsed = false,
}: { onNavigate?: () => void; collapsed?: boolean; onToggleCollapsed?: () => void } = {}) {
  const pathname = usePathname();
  const { session } = useSession();

  const isActive = (item: NavItem) => (item.exact ? pathname === item.href : pathname.startsWith(item.href));

  // When collapsed: the row strips down to a centred icon with the
  // label rendered as a native tooltip via `title=` so the operator
  // can still identify each link without giving up screen real estate.
  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = isActive(item);
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        title={collapsed ? item.label : undefined}
        aria-label={item.label}
        className={cn(
          'flex items-center rounded-md text-sm font-medium transition-colors',
          collapsed ? 'justify-center px-2 py-2' : 'gap-2.5 px-3 py-2',
          active
            ? 'bg-brand-50 text-brand-700'
            : 'text-foreground-muted hover:bg-surface-muted hover:text-foreground',
        )}
      >
        <Icon className="size-4 shrink-0" />
        {collapsed ? null : <span className="truncate">{item.label}</span>}
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
              <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">
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
                ALIGNED admin
              </p>
            ) : null}
            {alignedAdminItems.map(renderItem)}
          </div>
        ) : null}
      </nav>
    </div>
  );
}
