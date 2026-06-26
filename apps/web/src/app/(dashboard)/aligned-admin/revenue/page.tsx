'use client';

import { useQuery } from '@tanstack/react-query';
import { TrendingDown, TrendingUp, Users } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

interface Revenue {
  tenantsTotal: number;
  mrrMinor: number;
  mrrCurrency: string;
  byStatus: Record<string, number>;
  byPlan: { planCode: string; tenantCount: number; mrrMinor: number; currency: string }[];
  churnLast30d: { cancelled: number; churnRate: number };
}

function money(minor: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

export default function RevenuePage() {
  const q = useQuery({
    queryKey: ['admin-revenue'],
    queryFn: () => api.get<{ data: Revenue }>('/api/v1/aligned-admin/revenue'),
    refetchInterval: 60_000,
  });
  const r = q.data?.data;

  return (
    <>
      <PageHeader
        backHref="/aligned-admin"
        backLabel="Tenants"
        title="Revenue"
        description="MRR, plan distribution, churn over the last 30 days. Reads live from Stripe-mirrored subscription state."
      />
      {!r ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="size-4" /> MRR
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{money(r.mrrMinor, r.mrrCurrency)}</p>
                <p className="mt-1 text-xs text-foreground-muted">Active subscriptions only.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="size-4" /> Tenants
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{r.tenantsTotal}</p>
                <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                  {Object.entries(r.byStatus).map(([s, c]) => (
                    <Badge key={s} variant="muted">
                      {s}: {c}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingDown className="size-4" /> Churn (30 d)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">
                  {(r.churnLast30d.churnRate * 100).toFixed(1)}%
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {r.churnLast30d.cancelled} cancelled in last 30 days.
                </p>
              </CardContent>
            </Card>
          </div>
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Plan distribution</CardTitle>
              <CardDescription>How tenants split across plans + MRR contribution.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-foreground-subtle">
                    <th className="py-2">Plan</th>
                    <th>Tenants</th>
                    <th>MRR</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {r.byPlan.map((p) => (
                    <tr key={p.planCode}>
                      <td className="py-2 capitalize">{p.planCode}</td>
                      <td>{p.tenantCount}</td>
                      <td className="font-mono">{money(p.mrrMinor, p.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
