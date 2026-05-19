'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Sparkles,
  Receipt,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  highlights: string[];
  productCap: number | null;
  serviceCap: number | null;
  memberCap: number | null;
  monthlyMessageCap: number | null;
  monthlyBroadcastCap: number | null;
  monthlyImportCap: number | null;
  apiKeyCap: number | null;
  webhookCap: number | null;
  priceMonthlyMinor: number | null;
  priceYearlyMinor: number | null;
  currency: string;
  sortOrder: number;
  hasStripePrice: boolean;
}

interface Subscription {
  id: string;
  planCode: string;
  planName: string;
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'free' | 'paused' | string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  caps: {
    productCap: number | null;
    serviceCap: number | null;
    memberCap: number | null;
    monthlyMessageCap: number | null;
    monthlyBroadcastCap: number | null;
    monthlyImportCap: number | null;
    apiKeyCap: number | null;
    webhookCap: number | null;
  };
  usage: {
    products: number;
    services: number;
    members: number;
    apiKeys: number;
    webhooks: number;
    monthlyMessages: number;
    monthlyBroadcasts: number;
    monthlyImports: number;
  };
  yearMonth: string;
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'muted' | 'default'> = {
  active: 'success',
  trialing: 'default',
  past_due: 'warning',
  free: 'muted',
  cancelled: 'danger',
  paused: 'muted',
};

function money(minor: number | null, currency: string) {
  if (minor == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

export default function BillingPage() {
  const qc = useQueryClient();
  const [interval, setInterval] = useState<'monthly' | 'yearly'>('monthly');

  const subQ = useQuery({
    queryKey: ['billing-sub'],
    queryFn: () => api.get<{ data: Subscription }>('/api/v1/billing/subscription'),
  });
  const plansQ = useQuery({
    queryKey: ['billing-plans'],
    queryFn: () => api.get<{ data: Plan[] }>('/api/v1/billing/plans'),
  });

  const checkout = useMutation({
    mutationFn: (planCode: string) =>
      api.post<{ data: { url: string } }>('/api/v1/billing/checkout', { planCode, interval }),
    onSuccess: (res) => {
      if (res.data.url) window.location.href = res.data.url;
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Checkout failed'),
  });

  const portal = useMutation({
    mutationFn: () => api.post<{ data: { url: string } }>('/api/v1/billing/portal'),
    onSuccess: (res) => {
      if (res.data.url) window.location.href = res.data.url;
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Portal failed'),
  });

  const sub = subQ.data?.data;
  const plans = plansQ.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Billing"
        description="Subscription, plan, usage caps, and Stripe self-serve management."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/settings">
              <ArrowLeft className="size-4" /> Back to settings
            </Link>
          </Button>
        }
      />

      {sub ? <CurrentPlanCard sub={sub} onPortal={() => portal.mutate()} portalLoading={portal.isPending} /> : null}

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle>Plans</CardTitle>
            <CardDescription>Pick a plan to upgrade. Stripe handles payment.</CardDescription>
          </div>
          <div className="inline-flex rounded-md border border-border bg-surface p-0.5 text-xs">
            {(['monthly', 'yearly'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setInterval(v)}
                className={cn(
                  'rounded px-3 py-1 capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
                  interval === v ? 'bg-brand-50 text-brand-700 shadow-sm' : 'text-foreground-muted',
                )}
                aria-pressed={interval === v}
              >
                {v}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
            {plans.map((p) => (
              <div
                key={p.id}
                className={cn(
                  'flex flex-col rounded-lg border p-4',
                  sub?.planCode === p.code ? 'border-brand-500 bg-brand-50/40' : 'border-border bg-surface',
                )}
              >
                <p className="text-sm font-semibold">{p.name}</p>
                <p className="mt-0.5 text-2xl font-bold">
                  {interval === 'monthly'
                    ? money(p.priceMonthlyMinor, p.currency)
                    : money(p.priceYearlyMinor, p.currency)}
                  <span className="ml-1 text-xs font-normal text-foreground-muted">
                    /{interval === 'monthly' ? 'mo' : 'yr'}
                  </span>
                </p>
                {p.description ? <p className="mt-1 text-xs text-foreground-muted">{p.description}</p> : null}
                <ul className="mt-3 flex-1 space-y-1 text-xs">
                  {p.highlights.map((h) => (
                    <li key={h} className="flex items-start gap-1.5">
                      <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-emerald-500" />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3">
                  {sub?.planCode === p.code ? (
                    <Badge variant="success" className="w-full justify-center">
                      Current plan
                    </Badge>
                  ) : !p.hasStripePrice ? (
                    <Button variant="secondary" size="sm" className="w-full" disabled>
                      Contact us
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="w-full"
                      loading={checkout.isPending && checkout.variables === p.code}
                      onClick={() => checkout.mutate(p.code)}
                    >
                      <Sparkles className="size-4" /> Upgrade
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function CurrentPlanCard({
  sub,
  onPortal,
  portalLoading,
}: {
  sub: Subscription;
  onPortal: () => void;
  portalLoading: boolean;
}) {
  const trialActive = sub.status === 'trialing' && sub.trialEndsAt;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="size-4" /> Current plan: {sub.planName}
            </CardTitle>
            <CardDescription>
              <Badge variant={STATUS_VARIANT[sub.status] ?? 'default'} className="capitalize">
                {sub.status.replace('_', ' ')}
              </Badge>
              {sub.cancelAtPeriodEnd ? (
                <span className="ml-2 inline-flex items-center gap-1 text-xs text-amber-700">
                  <TriangleAlert className="size-3" /> cancels at period end
                </span>
              ) : null}
            </CardDescription>
          </div>
          <Button variant="secondary" size="sm" loading={portalLoading} onClick={onPortal}>
            <Receipt className="size-4" /> Stripe portal <ExternalLink className="size-3" />
          </Button>
        </CardHeader>
        <CardContent>
          {trialActive ? (
            <div className="mb-3 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-800">
              Your trial ends {formatRelative(sub.trialEndsAt!)}. Pick a plan below to keep going.
            </div>
          ) : null}
          {sub.currentPeriodEnd ? (
            <p className="text-sm text-foreground-muted">
              Next billing date: {new Date(sub.currentPeriodEnd).toLocaleDateString()}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage this month</CardTitle>
          <CardDescription>{sub.yearMonth} so far</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <UsageBar label="Products" used={sub.usage.products} cap={sub.caps.productCap} />
          <UsageBar label="Services" used={sub.usage.services} cap={sub.caps.serviceCap} />
          <UsageBar label="Members" used={sub.usage.members} cap={sub.caps.memberCap} />
          <UsageBar label="Messages (out)" used={sub.usage.monthlyMessages} cap={sub.caps.monthlyMessageCap} />
          <UsageBar
            label="Broadcasts (mo)"
            used={sub.usage.monthlyBroadcasts}
            cap={sub.caps.monthlyBroadcastCap}
          />
          <UsageBar label="Imports (mo)" used={sub.usage.monthlyImports} cap={sub.caps.monthlyImportCap} />
          <UsageBar label="API keys" used={sub.usage.apiKeys} cap={sub.caps.apiKeyCap} />
          <UsageBar label="Webhooks" used={sub.usage.webhooks} cap={sub.caps.webhookCap} />
        </CardContent>
      </Card>
    </div>
  );
}

function UsageBar({ label, used, cap }: { label: string; used: number; cap: number | null }) {
  const pct = cap == null || cap === 0 ? 0 : Math.min(100, (used / cap) * 100);
  const overdue = cap != null && used >= cap;
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-foreground-muted">{label}</span>
        <span className={cn('font-mono', overdue ? 'text-red-700' : 'text-foreground')}>
          {used} / {cap == null ? '∞' : cap}
        </span>
      </div>
      <div
        className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} usage`}
      >
        <div
          className={cn(
            'h-full transition-[width]',
            overdue ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-brand-500',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
