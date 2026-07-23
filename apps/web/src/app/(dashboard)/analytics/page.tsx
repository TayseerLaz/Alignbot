'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Clock,
  Inbox,
  Send,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { UsageLimitsWidget } from '@/components/dashboard/widgets/usage-limits';
import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
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

interface Broadcast {
  id: string;
  name: string;
  status: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------- helpers ---

function Reveal({ delay = 0, className, children }: { delay?: number; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn('animate-in fade-in-0 slide-in-from-bottom-3', className)}
      style={{ animationDuration: '520ms', animationDelay: `${delay}ms`, animationFillMode: 'both' }}
    >
      {children}
    </div>
  );
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}
function fmtReply(s: number | null): string {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function fmtDay(date: string): string {
  return date.slice(5); // MM-DD
}
// Simple trend from the first vs last third of a series.
function trend(vals: number[]): { dir: 'up' | 'down' | 'flat'; text: string } {
  if (vals.length < 2) return { dir: 'flat', text: 'not enough data' };
  const k = Math.max(1, Math.floor(vals.length / 3));
  const first = vals.slice(0, k).reduce((s, v) => s + v, 0) / k;
  const last = vals.slice(-k).reduce((s, v) => s + v, 0) / k;
  if (last > first * 1.1) return { dir: 'up', text: 'trending up' };
  if (last < first * 0.9) return { dir: 'down', text: 'easing off' };
  return { dir: 'flat', text: 'holding steady' };
}

// ------------------------------------------------------------------ KPIs ----

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  highlight,
}: {
  icon: typeof Inbox;
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <Card
      className={cn(
        'rounded-2xl p-5 shadow-[0_1px_2px_rgba(54,5,22,0.04)] transition-shadow duration-200 hover:shadow-[0_10px_28px_-14px_rgba(54,5,22,0.18)]',
        highlight
          ? 'border-transparent bg-gradient-to-br from-brand-500 to-brand-700 text-[#f2e7d5]'
          : 'border-border/80',
      )}
    >
      <div className="flex items-center justify-between">
        <p
          className={cn(
            'flex items-center gap-2 text-[0.8125rem] font-medium',
            highlight ? 'text-[#f2e7d5]/80' : 'text-foreground-muted',
          )}
        >
          <Icon className={cn('size-[1.05rem] shrink-0', highlight ? 'text-[#f2e7d5]/70' : 'text-foreground-subtle')} />
          {label}
        </p>
        <ArrowUpRight className={cn('size-4', highlight ? 'text-[#f2e7d5]/60' : 'text-foreground-subtle')} />
      </div>
      <p className="mt-3 font-mono text-[1.9rem] font-semibold leading-none tracking-[-0.02em] tabular-nums">
        {value}
      </p>
      <p className={cn('mt-1.5 text-xs font-medium', highlight ? 'text-[#f2e7d5]/70' : 'text-foreground-subtle')}>
        {sub ?? ' '}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------- gauge -----

function Gauge({ percent, label, sub }: { percent: number; label: string; sub: string }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), 120);
    return () => clearTimeout(t);
  }, []);
  const r = 56;
  const C = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const offset = drawn ? C * (1 - pct / 100) : C;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-2">
      <div className="relative grid place-items-center">
        <svg viewBox="0 0 140 140" className="size-40 -rotate-90">
          <circle cx="70" cy="70" r={r} fill="none" strokeWidth="13" style={{ stroke: 'var(--color-surface-muted)' }} />
          <circle
            cx="70"
            cy="70"
            r={r}
            fill="none"
            strokeWidth="13"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={offset}
            style={{ stroke: 'var(--color-brand-500)', transition: 'stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1)' }}
          />
        </svg>
        <div className="absolute grid place-items-center text-center">
          <span className="font-mono text-3xl font-semibold tabular-nums">{pct}%</span>
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-semibold text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-foreground-muted">{sub}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- bar chart ----

function VolumeBars({ volume }: { volume: Analytics['volume'] }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGrown(true), 80);
    return () => clearTimeout(t);
  }, []);
  const totals = volume.map((v) => v.inbound + v.outbound);
  const max = Math.max(1, ...totals);
  const peak = totals.indexOf(Math.max(...totals, 0));
  const labelEvery = volume.length > 14 ? Math.ceil(volume.length / 10) : 1;

  if (volume.length === 0 || max === 1) {
    return (
      <div className="flex h-[176px] flex-col items-center justify-center text-center">
        <p className="text-sm font-medium text-foreground">No messages in this window.</p>
        <p className="mt-1 text-xs text-foreground-subtle">Pick a longer range or check back later.</p>
      </div>
    );
  }
  return (
    <div>
      <div className="flex h-[150px] items-end gap-1.5">
        {volume.map((v, i) => (
          <div
            key={v.date}
            className={cn(
              'flex-1 rounded-t-md rounded-b-sm transition-[height] duration-700 ease-out',
              i === peak ? 'bg-gradient-to-b from-[#7d4152] to-[#360516]' : 'bg-surface-elevated',
            )}
            style={{ height: grown ? `${Math.max(3, Math.round((totals[i]! / max) * 100))}%` : '4px' }}
            title={`${v.date}: ${totals[i]} messages (${v.inbound} in · ${v.outbound} out)`}
          />
        ))}
      </div>
      <div className="mt-2 flex gap-1.5">
        {volume.map((v, i) => (
          <span key={v.date} className="flex-1 text-center font-mono text-[10px] text-foreground-subtle">
            {i % labelEvery === 0 ? fmtDay(v.date) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ line chart ----

function LineChart({ values, gradId }: { values: number[]; gradId: string }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), 90);
    return () => clearTimeout(t);
  }, []);
  const n = values.length;
  const max = Math.max(1, ...values);
  const x = (i: number) => (n <= 1 ? 50 : (i * 100) / (n - 1));
  const y = (v: number) => 38 - (v / max) * 34; // padded within 0..40
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const area = n > 0 ? `0,40 ${pts} 100,40` : '';
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full text-brand-500">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.2" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[10, 20, 30].map((gy) => (
        <line key={gy} x1="0" y1={gy} x2="100" y2={gy} style={{ stroke: 'var(--color-border)' }} strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
      ))}
      {n > 1 ? (
        <polygon points={area} fill={`url(#${gradId})`} style={{ opacity: drawn ? 1 : 0, transition: 'opacity .8s ease .3s' }} />
      ) : null}
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        pathLength={1}
        style={{ strokeDasharray: 1, strokeDashoffset: drawn ? 0 : 1, transition: 'stroke-dashoffset 1.1s ease' }}
      />
    </svg>
  );
}

function LineCard({
  title,
  total,
  values,
  dates,
  gradId,
}: {
  title: string;
  total: number;
  values: number[];
  dates: string[];
  gradId: string;
}) {
  const t = trend(values);
  const max = Math.max(1, ...values);
  const yLabels = [max, Math.round(max * 0.66), Math.round(max * 0.33), 0];
  return (
    <Card className="rounded-2xl border-border/80 p-5 shadow-[0_1px_2px_rgba(54,5,22,0.04)] transition-shadow duration-200 hover:shadow-[0_10px_28px_-14px_rgba(54,5,22,0.14)]">
      <div className="flex items-start justify-between">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <ArrowUpRight className="size-4 text-foreground-subtle" />
      </div>
      <p className="mt-2 font-mono text-[1.9rem] font-semibold leading-none tracking-[-0.02em] tabular-nums">
        {fmtNum(total)}
      </p>
      <p
        className={cn(
          'mt-1.5 flex items-center gap-1 text-xs font-medium',
          t.dir === 'up' ? 'text-emerald-700' : t.dir === 'down' ? 'text-red-600' : 'text-foreground-subtle',
        )}
      >
        {t.dir === 'up' ? <TrendingUp className="size-3.5" /> : t.dir === 'down' ? <TrendingDown className="size-3.5" /> : null}
        {t.text}
      </p>
      <div className="mt-4 flex gap-2">
        <div className="flex h-[96px] flex-col justify-between py-0.5 text-right font-mono text-[10px] text-foreground-subtle">
          {yLabels.map((l, i) => (
            <span key={i}>{fmtNum(l)}</span>
          ))}
        </div>
        <div className="h-[96px] flex-1">
          <LineChart values={values} gradId={gradId} />
        </div>
      </div>
      <div className="mt-1.5 flex justify-between pl-8 font-mono text-[10px] text-foreground-subtle">
        <span>{dates[0] ? fmtDay(dates[0]) : ''}</span>
        <span>{dates.length ? fmtDay(dates[dates.length - 1]!) : ''}</span>
      </div>
    </Card>
  );
}

// --------------------------------------------------------------- section ----

function Panel({ title, right, children, bodyClassName }: { title: string; right?: ReactNode; children: ReactNode; bodyClassName?: string }) {
  return (
    <Card className="h-full rounded-2xl border-border/80 shadow-[0_1px_2px_rgba(54,5,22,0.04)]">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {right ? <div className="ml-auto">{right}</div> : null}
      </div>
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </Card>
  );
}

function ListCard({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { key: string; primary: string; secondary?: string; count: number }[];
  empty: string;
}) {
  return (
    <Panel title={title} bodyClassName="py-2">
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-foreground-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-foreground">{r.primary}</p>
                {r.secondary ? <p className="truncate font-mono text-[10px] text-foreground-subtle">{r.secondary}</p> : null}
              </div>
              <span className="shrink-0 rounded-full bg-surface-elevated px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-foreground-muted">
                {r.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function statusChip(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('complet') || s.includes('sent') || s.includes('done')) return 'bg-emerald-100 text-emerald-700';
  if (s.includes('send') || s.includes('progress')) return 'bg-brand-50 text-brand-600';
  if (s.includes('schedul') || s.includes('paus') || s.includes('draft')) return 'bg-amber-100 text-amber-800';
  if (s.includes('fail') || s.includes('cancel')) return 'bg-red-100 text-red-700';
  return 'bg-surface-elevated text-foreground-muted';
}

// ------------------------------------------------------------------ page ----

export default function AnalyticsPage() {
  const { session } = useSession();
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const hasCatalog = !disabledFeatures.includes('products') || !disabledFeatures.includes('services');
  const hasBroadcasts = !disabledFeatures.includes('broadcasts');
  const [win, setWin] = useState<Window>('7d');

  const q = useQuery({
    queryKey: ['analytics', win],
    queryFn: () => api.get<{ data: Analytics }>(`/api/v1/analytics?window=${win}`),
    refetchInterval: 60_000,
  });
  const a = q.data?.data;

  const broadcastsQ = useQuery({
    queryKey: ['analytics-broadcasts'],
    queryFn: () => api.get<{ data: Broadcast[] }>('/api/v1/broadcasts?limit=50'),
    refetchInterval: 60_000,
    enabled: hasBroadcasts,
  });
  const broadcasts = broadcastsQ.data?.data ?? [];

  const dates = a?.volume.map((v) => v.date) ?? [];
  const inbound = a?.volume.map((v) => v.inbound) ?? [];
  const outbound = a?.volume.map((v) => v.outbound) ?? [];
  const totalSeries = a?.volume.map((v) => v.inbound + v.outbound) ?? [];
  const resolutionPct = a ? Math.round(a.botResolution.resolutionRate * 100) : 0;

  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title="Performance"
        description="Message volume, AI resolution, response time, and what your customers ask about."
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
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[116px] rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {/* KPI row — the first tile is the highlighted brand card. */}
          <Reveal className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              icon={Users}
              label="Conversations"
              value={fmtNum(a.totals.threads)}
              sub={`${fmtNum(a.totals.inbound + a.totals.outbound)} messages`}
              highlight
            />
            <Kpi icon={Inbox} label="Messages in" value={fmtNum(a.totals.inbound)} sub="from customers" />
            <Kpi icon={Send} label="Messages out" value={fmtNum(a.totals.outbound)} sub="replies sent" />
            <Kpi icon={Clock} label="Avg response" value={fmtReply(a.avgResponseSeconds)} sub="first reply time" />
          </Reveal>

          {/* Volume bars + AI-resolution gauge. */}
          <Reveal delay={90} className="grid grid-cols-1 gap-6 lg:grid-cols-[1.7fr_1fr]">
            <Panel title="Message volume">
              <VolumeBars volume={a.volume} />
            </Panel>
            <Panel title="AI resolution">
              <Gauge
                percent={resolutionPct}
                label="Handled by the bot"
                sub={`${fmtNum(a.botResolution.handoffs)} handed to a human`}
              />
            </Panel>
          </Reveal>

          {/* Report review — animated line charts. */}
          <div>
            <h2 className="mb-3 text-lg font-semibold tracking-[-0.01em] text-foreground">Report review</h2>
            <Reveal delay={140} className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <LineCard title="Inbound messages" total={a.totals.inbound} values={inbound} dates={dates} gradId="lc-in" />
              <LineCard title="Outbound replies" total={a.totals.outbound} values={outbound} dates={dates} gradId="lc-out" />
              <LineCard
                title="Total volume"
                total={a.totals.inbound + a.totals.outbound}
                values={totalSeries}
                dates={dates}
                gradId="lc-tot"
              />
            </Reveal>
          </div>

          {/* Usage & limits. */}
          <Reveal delay={180} className="max-w-xl">
            <UsageLimitsWidget />
          </Reveal>

          {/* What customers ask about. */}
          {hasCatalog ? (
            <Reveal delay={200} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <ListCard
                title="Top products asked"
                empty="No product mentions yet."
                rows={a.topProducts.map((p) => ({ key: p.id, primary: p.name, secondary: p.sku, count: p.count }))}
              />
              <ListCard
                title="Top services asked"
                empty="No service mentions yet."
                rows={a.topServices.map((s) => ({ key: s.id, primary: s.name, count: s.count }))}
              />
              <ListCard
                title="Top sentences"
                empty="Not enough messages yet."
                rows={a.topMessages.map((m, i) => ({ key: String(i), primary: m.message, count: m.count }))}
              />
            </Reveal>
          ) : (
            <Reveal delay={200}>
              <ListCard
                title="Top sentences"
                empty="Not enough messages yet."
                rows={a.topMessages.map((m, i) => ({ key: String(i), primary: m.message, count: m.count }))}
              />
            </Reveal>
          )}

          {/* Broadcasts table. */}
          {hasBroadcasts ? (
            <Reveal delay={230}>
              <Panel
                title="Broadcasts"
                right={
                  <span className="text-xs text-foreground-subtle">
                    {fmtNum(broadcasts.reduce((s, b) => s + b.sentCount, 0))} sent ·{' '}
                    {fmtNum(broadcasts.reduce((s, b) => s + b.totalRecipients, 0))} recipients
                  </span>
                }
                bodyClassName="p-0"
              >
                {broadcasts.length === 0 ? (
                  <p className="px-6 py-8 text-center text-sm text-foreground-muted">No broadcasts sent yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-border bg-surface-muted/60 text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                          <th className="px-5 py-2.5">Campaign</th>
                          <th className="px-5 py-2.5">Status</th>
                          <th className="hidden px-5 py-2.5 text-right md:table-cell">Recipients</th>
                          <th className="px-5 py-2.5 text-right">Sent</th>
                          <th className="hidden px-5 py-2.5 text-right lg:table-cell">Delivered</th>
                          <th className="hidden px-5 py-2.5 text-right lg:table-cell">Read</th>
                        </tr>
                      </thead>
                      <tbody>
                        {broadcasts.map((b) => (
                          <tr key={b.id} className="border-b border-border last:border-0 hover:bg-surface-muted/40">
                            <td className="px-5 py-3 font-medium text-foreground">{b.name}</td>
                            <td className="px-5 py-3">
                              <span
                                className={cn(
                                  'inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize',
                                  statusChip(b.status),
                                )}
                              >
                                {b.status}
                              </span>
                            </td>
                            <td className="hidden px-5 py-3 text-right font-mono tabular-nums md:table-cell">
                              {fmtNum(b.totalRecipients)}
                            </td>
                            <td className="px-5 py-3 text-right font-mono tabular-nums">{fmtNum(b.sentCount)}</td>
                            <td className="hidden px-5 py-3 text-right font-mono tabular-nums lg:table-cell">
                              {fmtNum(b.deliveredCount)}
                            </td>
                            <td className="hidden px-5 py-3 text-right font-mono tabular-nums lg:table-cell">
                              {fmtNum(b.readCount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </Reveal>
          ) : null}
        </div>
      )}
    </>
  );
}
