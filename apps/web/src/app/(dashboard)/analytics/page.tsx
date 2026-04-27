'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, BarChart3, Clock, MessageCircle, TrendingUp, Users } from 'lucide-react';
import { useState } from 'react';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
}

export default function AnalyticsPage() {
  const [win, setWin] = useState<Window>('7d');
  const q = useQuery({
    queryKey: ['analytics', win],
    queryFn: () => api.get<{ data: Analytics }>(`/api/v1/analytics?window=${win}`),
    refetchInterval: 60_000,
  });
  const a = q.data?.data;

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

      {!a ? (
        <p className="text-sm text-foreground-muted">Loading…</p>
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
                  <Activity className="size-4" /> Top queries
                </CardTitle>
                <CardDescription>Naive word frequency in inbound bodies.</CardDescription>
              </CardHeader>
              <CardContent>
                {a.topQueries.length === 0 ? (
                  <p className="text-sm text-foreground-muted">Not enough inbound text yet.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {a.topQueries.map((q) => (
                      <li key={q.word} className="flex items-center justify-between">
                        <span className="font-mono">{q.word}</span>
                        <Badge variant="muted">{q.count}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
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
