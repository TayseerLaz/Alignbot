'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Briefcase,
  Building2,
  CheckCircle2,
  HelpCircle,
  KeyRound,
  Package,
  Plug,
  RefreshCw,
  Sparkles,
  Webhook,
} from 'lucide-react';
import Link from 'next/link';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { fullName } from '@/lib/utils';

interface DashboardSummary {
  counts: {
    products: number;
    services: number;
    faqs: number;
    connectors: number;
    apiKeys: number;
    webhookEndpoints: number;
  };
  lastSyncAt: string | null;
  connectorStatus: {
    id: string;
    name: string;
    status: 'active' | 'disabled' | 'failing' | string;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    consecutiveFailures: number;
  }[];
  recentAudits: {
    id: string;
    action: string;
    entityType: string | null;
    entityId: string | null;
    actorName: string | null;
    actorEmail: string | null;
    createdAt: string;
  }[];
}

const humanAction = (action: string) =>
  action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function MetricCard({
  title,
  value,
  hint,
  href,
  icon: Icon,
}: {
  title: string;
  value: string | number;
  href: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm font-medium text-foreground-muted">{title}</CardTitle>
        <Icon className="size-4 text-foreground-subtle" />
      </CardHeader>
      <CardContent className="flex items-end justify-between">
        <div>
          <div className="text-3xl font-semibold tracking-tight">{value}</div>
          {hint ? <p className="mt-1 text-xs text-foreground-subtle">{hint}</p> : null}
        </div>
        <Link href={href} className="flex items-center gap-1 text-xs text-brand-500 hover:underline">
          Open <ArrowUpRight className="size-3" />
        </Link>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const greeting = session ? fullName(session.user.firstName, session.user.lastName, '').split(' ')[0] : '';

  const summary = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: () => api.get<{ data: DashboardSummary }>('/api/v1/dashboard/summary'),
    // Backend caches 30s — match on the client to avoid noisy refetches.
    staleTime: 30_000,
  });

  const data = summary.data?.data;
  const c = data?.counts;

  return (
    <>
      <PageHeader
        title={greeting ? `Welcome back, ${greeting}` : 'Welcome back'}
        description="Here's a snapshot of your organization's data health."
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={summary.isFetching}
            onClick={() => queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })}
          >
            <RefreshCw className="size-4" /> Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard title="Products" value={c?.products ?? '—'} href="/products" icon={Package} />
        <MetricCard title="Services" value={c?.services ?? '—'} href="/services" icon={Briefcase} />
        <MetricCard title="FAQs" value={c?.faqs ?? '—'} href="/business-info" icon={HelpCircle} />
        <MetricCard title="API keys" value={c?.apiKeys ?? '—'} href="/api-keys" icon={KeyRound} />
      </div>

      <AiUsageCard />


      <section className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Last sync */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-foreground-muted">Last sync</CardTitle>
            <Plug className="size-4 text-foreground-subtle" />
          </CardHeader>
          <CardContent>
            {data?.lastSyncAt ? (
              <>
                <p className="text-lg font-semibold">{formatRelative(data.lastSyncAt)}</p>
                <p className="mt-1 text-xs text-foreground-subtle">
                  Most recent connector run across all sources.
                </p>
              </>
            ) : (
              <>
                <p className="text-lg font-semibold text-foreground-subtle">Never</p>
                <p className="mt-1 text-xs text-foreground-subtle">
                  No connectors have synced yet.
                </p>
              </>
            )}
            <Link
              href="/connectors"
              className="mt-3 inline-flex items-center gap-1 text-xs text-brand-500 hover:underline"
            >
              View connectors <ArrowUpRight className="size-3" />
            </Link>
          </CardContent>
        </Card>

        {/* API connection status */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-foreground-muted">
              API connection status
            </CardTitle>
            <Webhook className="size-4 text-foreground-subtle" />
          </CardHeader>
          <CardContent>
            {data && data.connectorStatus.length === 0 ? (
              <p className="text-sm text-foreground-subtle">No connectors configured yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data?.connectorStatus.slice(0, 5).map((conn) => (
                  <li key={conn.id} className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{conn.name}</span>
                    <ConnectorStatusBadge status={conn.status} failures={conn.consecutiveFailures} />
                  </li>
                ))}
                {data && data.connectorStatus.length > 5 ? (
                  <li className="pt-1 text-xs text-foreground-subtle">
                    + {data.connectorStatus.length - 5} more
                  </li>
                ) : null}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent activity */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-foreground-muted">Recent activity</CardTitle>
            <Activity className="size-4 text-foreground-subtle" />
          </CardHeader>
          <CardContent>
            {data && data.recentAudits.length === 0 ? (
              <p className="text-sm text-foreground-subtle">
                No activity yet — changes will show up here.
              </p>
            ) : (
              <ul className="space-y-2 text-xs">
                {data?.recentAudits.slice(0, 6).map((a) => (
                  <li key={a.id} className="flex items-start gap-2">
                    <span className="mt-1 size-1.5 shrink-0 rounded-full bg-brand-400" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-foreground">{humanAction(a.action)}</p>
                      <p className="truncate text-foreground-subtle">
                        {a.actorName ?? a.actorEmail ?? 'system'} · {formatRelative(a.createdAt)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href="/audit-log"
              className="mt-3 inline-flex items-center gap-1 text-xs text-brand-500 hover:underline"
            >
              Open activity log <ArrowUpRight className="size-3" />
            </Link>
          </CardContent>
        </Card>
      </section>

      {c && c.products === 0 && c.services === 0 ? (
        <section className="mt-8">
          <Card>
            <CardHeader>
              <CardTitle>Get started</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <GettingStartedItem
                title="Add your first products and services"
                body="Manually create entries or bulk import from a spreadsheet."
                ctaLabel="Open catalog"
                ctaHref="/products"
              />
              <GettingStartedItem
                title="Invite your team"
                body="Add admins, editors, or viewers to collaborate on your data."
                ctaLabel="Manage members"
                ctaHref="/members"
              />
              <GettingStartedItem
                title="Connect your WhatsApp chatbot"
                body="Issue an API key so the chatbot can read your live catalog."
                ctaLabel="Create API key"
                ctaHref="/api-keys"
              />
            </CardContent>
          </Card>
        </section>
      ) : null}
    </>
  );
}

function ConnectorStatusBadge({ status, failures }: { status: string; failures: number }) {
  if (status === 'failing' || failures > 0) {
    return (
      <Badge variant="danger" className="gap-1">
        <AlertTriangle className="size-3" /> Failing
      </Badge>
    );
  }
  if (status === 'disabled') {
    return <Badge variant="muted">Disabled</Badge>;
  }
  return (
    <Badge variant="success" className="gap-1">
      <CheckCircle2 className="size-3" /> OK
    </Badge>
  );
}

function GettingStartedItem({
  title,
  body,
  ctaLabel,
  ctaHref,
}: {
  title: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-dashed border-border p-4">
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-xs text-foreground-muted">{body}</p>
      </div>
      <Button asChild size="sm" variant="secondary">
        <Link href={ctaHref}>{ctaLabel}</Link>
      </Button>
    </div>
  );
}

// AI budget meter — shows today's token spend, the remaining %, and an
// estimated USD cost. ALIGNED-admin-operated orgs read as "Unlimited"
// since their cap is bypassed server-side.
interface AiUsage {
  used: number;
  limit: number;
  unlimited: boolean;
  percentUsed: number;
  estCostUsd: number;
}

function AiUsageCard() {
  const usage = useQuery({
    queryKey: ['dashboard-ai-usage'],
    queryFn: () => api.get<{ data: AiUsage }>('/api/v1/dashboard/ai-usage'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const d = usage.data?.data;
  const used = d?.used ?? 0;
  const limit = d?.limit ?? 200_000;
  const unlimited = d?.unlimited ?? false;
  const percentUsed = d?.percentUsed ?? 0;
  const percentLeft = unlimited ? 100 : Math.max(0, 100 - percentUsed);
  const cost = d?.estCostUsd ?? 0;

  // Bar color shifts amber > red as the cap closes.
  const barColor =
    unlimited || percentUsed < 60
      ? 'bg-brand-500'
      : percentUsed < 85
        ? 'bg-amber-500'
        : 'bg-red-500';

  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-brand-500" />
          <CardTitle className="text-sm font-medium text-foreground-muted">
            AI chatbot budget · today
          </CardTitle>
        </div>
        <span className="text-xs text-foreground-subtle">Resets at 00:00 UTC</span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-2xl font-semibold">
              {unlimited ? 'Unlimited' : `${percentLeft}% left`}
            </p>
            <p className="mt-0.5 text-xs text-foreground-muted">
              {unlimited
                ? `${used.toLocaleString()} tokens used today · cost ${cost < 0.01 ? '<$0.01' : `$${cost.toFixed(3)}`}`
                : `${used.toLocaleString()} of ${limit.toLocaleString()} tokens used · cost ${cost < 0.01 ? '<$0.01' : `$${cost.toFixed(3)}`}`}
            </p>
          </div>
          {!unlimited && percentUsed >= 85 ? (
            <Badge variant="warning" className="gap-1">
              <AlertTriangle className="size-3" />
              Low budget
            </Badge>
          ) : null}
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
          <div
            className={`h-full ${barColor} transition-all`}
            style={{ width: `${unlimited ? 100 : percentUsed}%`, opacity: unlimited ? 0.4 : 1 }}
          />
        </div>
        <p className="text-xs text-foreground-subtle">
          Each customer message uses ≈ 1k–3k tokens of GPT-4o-mini. The free
          tier resets daily; contact us to lift the cap.
        </p>
      </CardContent>
    </Card>
  );
}
