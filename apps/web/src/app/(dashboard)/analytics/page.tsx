'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, BarChart3, Clock, MessageCircle, TrendingUp, Users } from 'lucide-react';
import { useState } from 'react';

import { UsageLimitsWidget } from '@/components/dashboard/widgets/usage-limits';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type Window = '24h' | '7d' | '30d';

interface Analytics {
  window: Window;
  volume: { date: string; inbound: number; outbound: number }[];
  totals: { inbound: number; outbound: number; threads: number };
  botResolution: { resolutionRate: number; handoffs: number };
  avgResponseSeconds: number | null;
  topQueries: { word: string; count: number }[];
  topMessages: { message: string; count: number }[];
  topProducts: { id: string; name: string; sku: string; count: number }[];
  topServices: { id: string; name: string; count: number }[];
}

export default function AnalyticsPage() {
  const [win, setWin] = useState<Window>('7d');
  const q = useQuery({
    queryKey: ['analytics', win],
    queryFn: () => api.get<{ data: Analytics }>(`/api/v1/analytics?window=${win}`),
    refetchInterval: 60_000,
  });
  const a = q.data?.data;

  // Broadcasts the tenant has sent — messages sent + how many users reached.
  const broadcastsQ = useQuery({
    queryKey: ['analytics-broadcasts'],
    queryFn: () =>
      api.get<{
        data: {
          id: string;
          name: string;
          status: string;
          totalRecipients: number;
          sentCount: number;
          deliveredCount: number;
          readCount: number;
          createdAt: string;
        }[];
      }>('/api/v1/broadcasts?limit=50'),
    refetchInterval: 60_000,
  });
  const broadcasts = broadcastsQ.data?.data ?? [];
  const broadcastTotals = broadcasts.reduce(
    (acc, b) => ({ sent: acc.sent + b.sentCount, recipients: acc.recipients + b.totalRecipients }),
    { sent: 0, recipients: 0 },
  );

  const max = Math.max(1, ...(a?.volume.map((v) => v.inbound + v.outbound) ?? [0]));

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Message volume, bot resolution rate, response time, top customer queries."
        actions={
          <Select value={win} onValueChange={(v) => setWin(v as Window)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">Last 24 h</SelectItem>
              <SelectItem value="7d">Last 7 d</SelectItem>
              <SelectItem value="30d">Last 30 d</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      {/* Usage & limits — every cap the tenant can hit (AI messages + plan
          quotas), color-coded, so they see what's near/at a limit and why
          something may have stopped. */}
      <div className="mb-5 max-w-xl">
        <UsageLimitsWidget />
      </div>

      {!a ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat icon={MessageCircle} label="Inbound" value={a.totals.inbound} />
            <Stat icon={MessageCircle} label="Outbound" value={a.totals.outbound} />
            <Stat icon={Users} label="Threads" value={a.totals.threads} />
            <Stat
              icon={TrendingUp}
              label="Bot resolution"
              value={`${(a.botResolution.resolutionRate * 100).toFixed(0)}%`}
              sub={`${a.botResolution.handoffs} handoffs`}
              good={a.botResolution.resolutionRate >= 0.7}
            />
          </div>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="size-4" /> Daily volume
              </CardTitle>
              <CardDescription>Inbound + outbound stacked per day.</CardDescription>
            </CardHeader>
            <CardContent>
              {a.volume.length === 0 ? (
                <p className="text-sm text-foreground-muted">No messages in this window.</p>
              ) : (
                <ul className="space-y-1.5">
                  {a.volume.map((v) => {
                    const total = v.inbound + v.outbound;
                    const pct = (total / max) * 100;
                    return (
                      <li key={v.date} className="grid grid-cols-[80px_1fr_auto] items-center gap-3 text-xs">
                        <span className="text-foreground-muted">{v.date.slice(5)}</span>
                        <div className="h-3 overflow-hidden rounded-full bg-surface-muted">
                          <div
                            className="h-full bg-brand-500"
                            style={{ width: `${pct}%` }}
                            aria-label={`${total} messages on ${v.date}`}
                          />
                        </div>
                        <span className="font-mono tabular-nums">
                          {v.inbound} in · {v.outbound} out
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="size-4" /> Avg response time
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">
                  {a.avgResponseSeconds == null ? '—' : `${a.avgResponseSeconds}s`}
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Time between an inbound message and the next outbound reply on the same thread.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="size-4" /> Top sentences
                </CardTitle>
                <CardDescription>Most frequent full messages customers send.</CardDescription>
              </CardHeader>
              <CardContent>
                {a.topMessages.length === 0 ? (
                  <p className="text-sm text-foreground-muted">Not enough inbound messages yet.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {a.topMessages.map((q, i) => (
                      <li key={i} className="flex items-start justify-between gap-2">
                        <span className="line-clamp-2 break-words text-foreground">{q.message}</span>
                        <Badge variant="muted" className="shrink-0">{q.count}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Full-message clustering + product/service mentions — three
              cards stacked in a responsive grid so each gets enough
              horizontal space for long content. */}
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="size-4" /> Top products asked
                </CardTitle>
                <CardDescription>
                  Products that appear most often in customer messages (matched by name or SKU).
                </CardDescription>
              </CardHeader>
              <CardContent>
                {a.topProducts.length === 0 ? (
                  <p className="text-sm text-foreground-muted">
                    No product mentions in customer messages this window.
                  </p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {a.topProducts.map((p) => (
                      <li key={p.id} className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-foreground">{p.name}</p>
                          <p className="font-mono text-[10px] text-foreground-subtle">{p.sku}</p>
                        </div>
                        <Badge variant="muted" className="shrink-0">{p.count}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="size-4" /> Top services asked
                </CardTitle>
                <CardDescription>
                  Services mentioned most often in customer messages (matched by service name).
                </CardDescription>
              </CardHeader>
              <CardContent>
                {a.topServices.length === 0 ? (
                  <p className="text-sm text-foreground-muted">
                    No service mentions in customer messages this window.
                  </p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {a.topServices.map((s) => (
                      <li key={s.id} className="flex items-start justify-between gap-2">
                        <span className="truncate text-foreground">{s.name}</span>
                        <Badge variant="muted" className="shrink-0">{s.count}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Broadcasts — messages sent + recipients per campaign. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <MessageCircle className="size-4" /> Broadcasts
                </span>
                <span className="text-xs font-normal text-foreground-muted">
                  {broadcastTotals.sent.toLocaleString()} messages sent ·{' '}
                  {broadcastTotals.recipients.toLocaleString()} recipients
                </span>
              </CardTitle>
              <CardDescription>
                Each campaign you&apos;ve sent — how many messages went out and to how many users.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {broadcasts.length === 0 ? (
                <p className="px-6 py-6 text-center text-sm text-foreground-muted">
                  No broadcasts sent yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-foreground-subtle">
                      <tr>
                        <th className="px-4 py-2">Campaign</th>
                        <th className="hidden px-4 py-2 sm:table-cell">Status</th>
                        <th className="hidden px-4 py-2 text-right md:table-cell">Recipients</th>
                        <th className="px-4 py-2 text-right">Sent</th>
                        <th className="hidden px-4 py-2 text-right lg:table-cell">Delivered</th>
                        <th className="hidden px-4 py-2 text-right lg:table-cell">Read</th>
                      </tr>
                    </thead>
                    <tbody>
                      {broadcasts.map((b) => (
                        <tr key={b.id} className="border-b border-border last:border-0">
                          <td className="px-4 py-2 font-medium text-foreground">{b.name}</td>
                          <td className="hidden px-4 py-2 text-foreground-muted sm:table-cell">{b.status}</td>
                          <td className="hidden px-4 py-2 text-right tabular-nums md:table-cell">{b.totalRecipients.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{b.sentCount.toLocaleString()}</td>
                          <td className="hidden px-4 py-2 text-right tabular-nums lg:table-cell">{b.deliveredCount.toLocaleString()}</td>
                          <td className="hidden px-4 py-2 text-right tabular-nums lg:table-cell">{b.readCount.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  good,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  sub?: string;
  good?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between py-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">{label}</p>
          <p className={cn('mt-1 text-2xl font-semibold', good && 'text-emerald-600')}>{value}</p>
          {sub ? <p className="mt-0.5 text-xs text-foreground-muted">{sub}</p> : null}
        </div>
        <Icon className="size-5 text-foreground-subtle" />
      </CardContent>
    </Card>
  );
}
