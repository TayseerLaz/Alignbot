'use client';

import { formatMicrosUsd, MICROS_PER_USD, ORG_FEATURES } from '@aligned/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightToLine,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  Lock,
  MessageCircle,
  Pause,
  Play,
  ShieldCheck,
  Trash2,
  Wallet,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, setAccessToken } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';

type AiPlan = 'basic' | 'middle' | 'max' | 'ultra';
const AI_PLANS: AiPlan[] = ['basic', 'middle', 'max', 'ultra'];
const AI_PLAN_LABEL: Record<AiPlan, string> = { basic: 'Basic', middle: 'Middle', max: 'Max', ultra: 'Ultra' };

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
  aiPlan: AiPlan;
  disabledFeatures: string[];
  memberCount: number;
  lastActivityAt: string | null;
}

interface OrgDetails {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  members: Array<{
    userId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
    isActive: boolean;
    emailVerified: boolean;
    totpEnabled: boolean;
    lastLoginAt: string | null;
  }>;
  whatsappChannel: { displayPhoneNumber: string | null; isActive: boolean; isPrimary: boolean } | null;
  counts: { products: number; services: number; faqs: number; apiKeys: number; webhooks: number };
  recentAuditLog: Array<{ action: string; actorEmail: string | null; createdAt: string }>;
}

interface AiUsage {
  aiPlan: AiPlan;
  aiMessages: { used: number; cap: number | null; unlimited: boolean; percentUsed: number };
  today: { tokens: number; usd: number; replies: number };
  thisMonth: { tokens: number; usd: number; replies: number };
}

interface OrgBroadcasts {
  totals: { broadcasts: number; recipients: number; sent: number };
  broadcasts: {
    id: string;
    name: string;
    status: string;
    totalRecipients: number;
    sentCount: number;
    deliveredCount: number;
    readCount: number;
    createdAt: string;
  }[];
}

interface ExportRow {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  fileSizeBytes: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface WalletDto {
  organizationId: string;
  meteringEnabled: boolean;
  availableMicros: number;
  heldMicros: number;
  pricePerMessageMicros: number;
  metaCostMicros: number;
  lowBalanceThresholdMicros: number;
  lifetimeToppedUpMicros: number;
  lifetimeSpentMicros: number;
  lifetimeMessages: number;
  marginPerMessageMicros: number;
  marginPct: number;
  lifetimeMarginMicros: number;
}

type WalletLedgerKind = 'topup' | 'adjust' | 'settle' | 'release' | 'hold';

interface WalletLedgerRow {
  id: string;
  kind: WalletLedgerKind;
  amountMicros: number;
  availableAfterMicros: number;
  heldAfterMicros: number;
  broadcastId: string | null;
  note: string | null;
  actorName: string | null;
  createdAt: string;
}

interface WalletLedgerPage {
  data: WalletLedgerRow[];
  nextCursor: string | null;
}

const WALLET_KIND_LABEL: Record<WalletLedgerKind, string> = {
  topup: 'Top-up',
  settle: 'Message charge',
  adjust: 'Adjustment',
  release: 'Refund',
  hold: 'Hold',
};

export default function OrgDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, refresh } = useSession();
  const isOwnOrg =
    !!session && [session.organization?.id, ...(session.availableOrganizations?.map((o) => o.id) ?? [])].includes(id);

  // Base row (for plan + disabledFeatures) — shares the list cache.
  const orgsQ = useQuery({
    queryKey: ['admin-orgs', ''],
    queryFn: () => api.get<{ data: OrgRow[] }>('/api/v1/aligned-admin/orgs'),
  });
  const org = orgsQ.data?.data.find((o) => o.id === id) ?? null;

  const detailsQ = useQuery({
    queryKey: ['admin-org-details', id],
    queryFn: () => api.get<{ data: OrgDetails }>(`/api/v1/aligned-admin/orgs/${id}/details`),
  });
  const usageQ = useQuery({
    queryKey: ['admin-org-usage', id],
    queryFn: () => api.get<{ data: AiUsage }>(`/api/v1/aligned-admin/orgs/${id}/ai-usage`),
    refetchInterval: 30_000,
  });
  const broadcastsQ = useQuery({
    queryKey: ['admin-org-broadcasts', id],
    queryFn: () => api.get<{ data: OrgBroadcasts }>(`/api/v1/aligned-admin/orgs/${id}/broadcasts`),
  });
  const d = detailsQ.data?.data;
  const usage = usageQ.data?.data;
  const broadcasts = broadcastsQ.data?.data;
  const currentPlan = usage?.aiPlan ?? org?.aiPlan ?? 'basic';
  const status = d?.status ?? org?.status ?? 'active';

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-orgs'] });
    queryClient.invalidateQueries({ queryKey: ['admin-org-details', id] });
  };

  const setStatus = useMutation({
    mutationFn: (s: 'active' | 'suspended') => api.patch(`/api/v1/aligned-admin/orgs/${id}`, { status: s }),
    onSuccess: () => {
      toast.success('Status updated');
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/v1/aligned-admin/orgs/${id}`),
    onSuccess: () => {
      toast.success('Organisation deleted');
      router.push('/aligned-admin');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });

  const setPlan = useMutation({
    mutationFn: (next: AiPlan) =>
      api.put<{ data: { aiPlan: AiPlan } }>(`/api/v1/aligned-admin/orgs/${id}/ai-plan`, { aiPlan: next }),
    onSuccess: (res) => {
      toast.success(`Plan changed to ${AI_PLAN_LABEL[res.data.aiPlan]}`);
      queryClient.invalidateQueries({ queryKey: ['admin-org-usage', id] });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Plan change failed'),
  });

  const setAiMessageCap = useMutation({
    mutationFn: (cap: number | null) =>
      api.put<{ data: { monthlyAiMessageCap: number | null } }>(
        `/api/v1/aligned-admin/orgs/${id}/ai-message-cap`,
        { cap },
      ),
    onSuccess: () => {
      toast.success('Monthly AI messages updated');
      queryClient.invalidateQueries({ queryKey: ['admin-org-usage', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const control = useMutation({
    mutationFn: () =>
      api.post<{ data: { accessToken: string; expiresAt: string } }>(
        `/api/v1/aligned-admin/orgs/${id}/impersonate`,
        {},
      ),
    onSuccess: async (res) => {
      setAccessToken(res.data.accessToken, res.data.expiresAt);
      queryClient.clear();
      // Refresh the in-memory session so org name, role, and (critically)
      // disabledFeatures reflect the controlled workspace — otherwise feature
      // gating (e.g. hidden booking/shop tabs) would keep using the admin's
      // own org features.
      await refresh();
      toast.success('Now controlling this workspace.');
      router.push('/dashboard');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Could not control workspace'),
  });

  // Access (disabled features) — local edit state, saved on demand.
  const [disabled, setDisabled] = useState<string[]>([]);
  useEffect(() => {
    if (org) setDisabled(org.disabledFeatures ?? []);
  }, [org]);
  const saveAccess = useMutation({
    mutationFn: () => api.put(`/api/v1/aligned-admin/orgs/${id}/features`, { disabledFeatures: disabled }),
    onSuccess: () => {
      toast.success('Access updated');
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  // Data export (ALIGNED-admin can export any org, even if the tenant's own
  // self-service export feature is turned off). Poll while one is in flight.
  const exportsQ = useQuery({
    queryKey: ['admin-org-exports', id],
    queryFn: () => api.get<{ data: ExportRow[] }>(`/api/v1/aligned-admin/orgs/${id}/exports`),
    refetchInterval: (q) => {
      const rows = q.state.data?.data ?? [];
      return rows.some((e) => e.status === 'pending' || e.status === 'running') ? 3000 : false;
    },
  });
  const exports = exportsQ.data?.data ?? [];
  const exportInflight = exports.some((e) => e.status === 'pending' || e.status === 'running');

  const triggerExport = useMutation({
    mutationFn: () => api.post(`/api/v1/aligned-admin/orgs/${id}/export`, {}),
    onSuccess: () => {
      toast.success('Export started — it will appear below when ready.');
      queryClient.invalidateQueries({ queryKey: ['admin-org-exports', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Could not start export'),
  });

  // ---- WhatsApp wallet & metered billing (ALIGNED-admin only) ----
  const walletQ = useQuery({
    queryKey: ['admin-org-wallet', id],
    queryFn: () => api.get<{ data: WalletDto }>(`/api/v1/aligned-admin/orgs/${id}/wallet`),
    refetchInterval: 30_000,
  });
  const wallet = walletQ.data?.data;
  const invalidateWallet = () =>
    queryClient.invalidateQueries({ queryKey: ['admin-org-wallet', id] });

  const setMetering = useMutation({
    mutationFn: (enabled: boolean) =>
      api.put<{ data: WalletDto }>(`/api/v1/aligned-admin/orgs/${id}/wallet/metering`, { enabled }),
    onSuccess: (res) => {
      toast.success(res.data.meteringEnabled ? 'Metering enabled' : 'Metering disabled');
      invalidateWallet();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const setPrice = useMutation({
    mutationFn: (priceUsd: number) =>
      api.put<{ data: WalletDto }>(`/api/v1/aligned-admin/orgs/${id}/wallet/price`, { priceUsd }),
    onSuccess: () => {
      toast.success('Per-message price updated');
      invalidateWallet();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const topUp = useMutation({
    mutationFn: (body: { amountUsd: number; note?: string }) =>
      api.post<{ data: WalletDto }>(`/api/v1/aligned-admin/orgs/${id}/wallet/topup`, body),
    onSuccess: () => {
      toast.success('Balance topped up');
      invalidateWallet();
      queryClient.invalidateQueries({ queryKey: ['admin-org-wallet-ledger', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Top-up failed'),
  });

  const adjust = useMutation({
    mutationFn: (body: { amountUsd: number; note?: string }) =>
      api.post<{ data: WalletDto }>(`/api/v1/aligned-admin/orgs/${id}/wallet/adjust`, body),
    onSuccess: () => {
      toast.success('Balance adjusted');
      invalidateWallet();
      queryClient.invalidateQueries({ queryKey: ['admin-org-wallet-ledger', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Adjustment failed'),
  });

  const setThreshold = useMutation({
    mutationFn: (lowBalanceUsd: number) =>
      api.put<{ data: WalletDto }>(`/api/v1/aligned-admin/orgs/${id}/wallet/threshold`, {
        lowBalanceUsd,
      }),
    onSuccess: () => {
      toast.success('Low-balance threshold updated');
      invalidateWallet();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const downloadExport = async (exportId: string) => {
    try {
      const res = await api.get<{ data: { url: string } }>(
        `/api/v1/aligned-admin/orgs/${id}/exports/${exportId}/download`,
      );
      window.open(res.data.url, '_blank', 'noopener');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.payload.message : 'Download failed');
    }
  };

  const name = d?.name ?? org?.name ?? 'Organisation';

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Tenants', href: '/aligned-admin' }, { label: name }]}
        title={name}
        description={org ? <span className="font-mono text-xs">{org.slug}</span> : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              loading={control.isPending}
              disabled={status !== 'active'}
              onClick={() => control.mutate()}
            >
              <ArrowRightToLine className="size-4" /> Control workspace
            </Button>
            {status === 'active' ? (
              <Button
                variant="secondary"
                disabled={isOwnOrg}
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: `Suspend "${name}"?`,
                      body: "Members can't sign in until reactivated. Data is kept.",
                      confirmLabel: 'Suspend',
                      destructive: true,
                    })
                  )
                    setStatus.mutate('suspended');
                }}
              >
                <Pause className="size-4" /> Suspend
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setStatus.mutate('active')}>
                <Play className="size-4" /> Reactivate
              </Button>
            )}
            <Button
              variant="danger"
              disabled={isOwnOrg}
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: `Permanently delete "${name}"?`,
                    body: 'Everything for this organisation will be removed. This cannot be undone.',
                    confirmLabel: 'Delete everything',
                    destructive: true,
                  })
                )
                  remove.mutate();
              }}
            >
              <Trash2 className="size-4" /> Delete
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Overview */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-brand-500" /> Overview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Status">
              <Badge variant={status === 'active' ? 'success' : status === 'suspended' ? 'warning' : 'muted'}>
                {status}
              </Badge>
            </Row>
            <Row label="Created">
              {d ? formatRelative(d.createdAt) : <Skeleton className="h-4 w-20" />}
            </Row>
            <Row label="Last activity">
              {org?.lastActivityAt ? formatRelative(org.lastActivityAt) : '—'}
            </Row>
            <div className="grid grid-cols-1 min-[400px]:grid-cols-3 gap-2 pt-2">
              <Metric label="Products" value={d?.counts.products} />
              <Metric label="Services" value={d?.counts.services} />
              <Metric label="FAQs" value={d?.counts.faqs} />
              <Metric label="Members" value={d?.members.length ?? org?.memberCount} />
              <Metric label="API keys" value={d?.counts.apiKeys} />
              <Metric label="Webhooks" value={d?.counts.webhooks} />
            </div>
          </CardContent>
        </Card>

        {/* AI plan + usage */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="size-4 text-brand-500" /> AI plan &amp; usage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Plan">
              <Select value={currentPlan} onValueChange={(v) => setPlan.mutate(v as AiPlan)}>
                <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AI_PLANS.map((p) => (
                    <SelectItem key={p} value={p}>{AI_PLAN_LABEL[p]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <div className="space-y-1.5 border-t border-border pt-3">
              <p className="text-xs font-medium text-foreground">Monthly AI messages (allowance)</p>
              {usage?.aiMessages ? (
                <AiMessageCapEditor
                  key={`${usage.aiMessages.cap}-${usage.aiMessages.unlimited}`}
                  used={usage.aiMessages.used}
                  cap={usage.aiMessages.cap}
                  unlimited={usage.aiMessages.unlimited}
                  saving={setAiMessageCap.isPending}
                  onSave={(c) => setAiMessageCap.mutate(c)}
                />
              ) : (
                <span className="text-xs text-foreground-muted">—</span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
              <p className="col-span-2 -mb-1 text-[10px] uppercase tracking-wider text-foreground-subtle">
                Cost (admin-only)
              </p>
              <Metric label="Tokens today" value={usage?.today.tokens} mono />
              <Metric label="USD today" value={usage ? `$${usage.today.usd.toFixed(2)}` : undefined} mono />
              <Metric label="Tokens / month" value={usage?.thisMonth.tokens} mono />
              <Metric label="USD / month" value={usage ? `$${usage.thisMonth.usd.toFixed(2)}` : undefined} mono />
            </div>
          </CardContent>
        </Card>

        {/* WhatsApp wallet & metered billing */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="size-4 text-brand-500" /> WhatsApp wallet &amp; billing
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {walletQ.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-40" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : !wallet ? (
              <p className="text-foreground-muted">No wallet for this organisation.</p>
            ) : (
              <WalletBilling
                wallet={wallet}
                orgId={id}
                onSetMetering={(enabled) => setMetering.mutate(enabled)}
                meteringSaving={setMetering.isPending}
                onSetPrice={(usd) => setPrice.mutate(usd)}
                priceSaving={setPrice.isPending}
                onTopUp={(body) => topUp.mutate(body)}
                topUpSaving={topUp.isPending}
                onAdjust={(body) => adjust.mutate(body)}
                adjustSaving={adjust.isPending}
                onSetThreshold={(usd) => setThreshold.mutate(usd)}
                thresholdSaving={setThreshold.isPending}
              />
            )}
          </CardContent>
        </Card>

        {/* WhatsApp */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="size-4 text-brand-500" /> WhatsApp
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {detailsQ.isLoading ? (
              <Skeleton className="h-4 w-40" />
            ) : d?.whatsappChannel ? (
              <div className="space-y-2">
                <Row label="Number">
                  <span className="font-mono">{d.whatsappChannel.displayPhoneNumber ?? '—'}</span>
                </Row>
                <Row label="Status">
                  <Badge variant={d.whatsappChannel.isActive ? 'success' : 'muted'}>
                    {d.whatsappChannel.isActive ? 'active' : 'inactive'}
                  </Badge>
                </Row>
              </div>
            ) : (
              <p className="text-foreground-muted">No WhatsApp channel connected.</p>
            )}
          </CardContent>
        </Card>

        {/* Access & features */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Lock className="size-4 text-brand-500" /> Access &amp; features
            </CardTitle>
            <Button
              size="sm"
              loading={saveAccess.isPending}
              disabled={isOwnOrg}
              onClick={() => saveAccess.mutate()}
            >
              Save access
            </Button>
          </CardHeader>
          <CardContent>
            {isOwnOrg ? (
              <p className="text-sm text-foreground-muted">
                This is your own admin account — its access is locked.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {ORG_FEATURES.map((f) => {
                  const enabled = !disabled.includes(f.key);
                  return (
                    <label
                      key={f.key}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4"
                        checked={enabled}
                        onChange={(e) =>
                          setDisabled((prev) =>
                            e.target.checked ? prev.filter((k) => k !== f.key) : [...new Set([...prev, f.key])],
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{f.label}</span>
                        <span className="mt-0.5 block text-xs text-foreground-muted">{f.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Data export (ALIGNED-admin — always available) */}
        <Card className="lg:col-span-1">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Download className="size-4 text-brand-500" /> Data export
            </CardTitle>
            <Button
              size="sm"
              loading={triggerExport.isPending}
              disabled={exportInflight}
              onClick={() => triggerExport.mutate()}
            >
              {exportInflight ? 'Exporting…' : 'Export data'}
            </Button>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-xs text-foreground-muted">
              Full data bundle (catalog, conversations, bot config, audit log) as a .zip of CSVs.
              Available even if the tenant&apos;s own export feature is off.
            </p>
            {exportsQ.isLoading ? (
              <Skeleton className="h-8 w-full" />
            ) : exports.length === 0 ? (
              <p className="text-foreground-muted">No exports yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {exports.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="block">{formatRelative(e.createdAt)}</span>
                      <span className="text-xs text-foreground-muted">
                        {e.status}
                        {e.fileSizeBytes != null
                          ? ` · ${(e.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB`
                          : ''}
                        {e.errorMessage ? ` · ${e.errorMessage}` : ''}
                      </span>
                    </span>
                    {e.status === 'succeeded' ? (
                      <Button size="sm" variant="secondary" onClick={() => downloadExport(e.id)}>
                        <Download className="size-3.5" /> Download
                      </Button>
                    ) : (
                      <Badge
                        variant={e.status === 'failed' ? 'muted' : 'warning'}
                      >
                        {e.status}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Members */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Members</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {detailsQ.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : (d?.members.length ?? 0) === 0 ? (
              <p className="px-6 py-6 text-center text-sm text-foreground-muted">No members.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-surface-muted/60 text-[11px] uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-4 py-2">Email</th>
                      <th className="px-4 py-2">Role</th>
                      <th className="hidden px-4 py-2 sm:table-cell">2FA</th>
                      <th className="hidden px-4 py-2 md:table-cell">Last login</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {d?.members.map((m) => (
                      <tr key={m.userId}>
                        <td className="px-4 py-2">
                          <span className="font-medium">{[m.firstName, m.lastName].filter(Boolean).join(' ') || '—'}</span>
                          <span className="ml-2 text-foreground-subtle">{m.email}</span>
                          {!m.emailVerified ? <Badge variant="warning" className="ml-2">unverified</Badge> : null}
                          {!m.isActive ? <Badge variant="muted" className="ml-2">inactive</Badge> : null}
                        </td>
                        <td className="px-4 py-2"><Badge variant="muted">{m.role}</Badge></td>
                        <td className="hidden px-4 py-2 sm:table-cell">{m.totpEnabled ? 'On' : '—'}</td>
                        <td className="hidden px-4 py-2 text-foreground-muted md:table-cell">
                          {m.lastLoginAt ? formatRelative(m.lastLoginAt) : 'never'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Broadcasts — messages sent + recipients per campaign for this tenant */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Broadcasts</span>
              {broadcasts ? (
                <span className="text-xs font-normal text-foreground-muted">
                  {broadcasts.totals.broadcasts} campaigns · {broadcasts.totals.sent.toLocaleString()} sent ·{' '}
                  {broadcasts.totals.recipients.toLocaleString()} recipients
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!broadcasts || broadcasts.broadcasts.length === 0 ? (
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
                      <th className="hidden px-4 py-2 md:table-cell">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {broadcasts.broadcasts.map((b) => (
                      <tr key={b.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2 font-medium text-foreground">{b.name}</td>
                        <td className="hidden px-4 py-2 text-foreground-muted sm:table-cell">{b.status}</td>
                        <td className="hidden px-4 py-2 text-right tabular-nums md:table-cell">{b.totalRecipients.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{b.sentCount.toLocaleString()}</td>
                        <td className="hidden px-4 py-2 text-right tabular-nums lg:table-cell">{b.deliveredCount.toLocaleString()}</td>
                        <td className="hidden px-4 py-2 text-right tabular-nums lg:table-cell">{b.readCount.toLocaleString()}</td>
                        <td className="hidden px-4 py-2 text-foreground-muted md:table-cell">
                          {new Date(b.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent activity */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {detailsQ.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            ) : (d?.recentAuditLog.length ?? 0) === 0 ? (
              <p className="px-6 py-6 text-center text-sm text-foreground-muted">No recent activity.</p>
            ) : (
              <ul className="divide-y divide-border">
                {d?.recentAuditLog.map((a, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="font-mono text-xs">{a.action}</span>
                    <span className="text-foreground-subtle">
                      {a.actorEmail ?? 'system'} · {formatRelative(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-foreground-muted">{label}</span>
      <span className="text-right font-medium text-foreground">{children}</span>
    </div>
  );
}

function Metric({ label, value, mono }: { label: string; value?: number | string | null; mono?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted/40 p-2.5">
      <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">{label}</p>
      <p className={mono ? 'mt-0.5 font-mono tabular-nums text-sm' : 'mt-0.5 text-sm font-semibold'}>
        {value ?? '—'}
      </p>
    </div>
  );
}

// Per-tenant monthly AI-message allowance editor (admin). Self-seeds from props;
// remounted via `key` when the server value changes after a save.
function AiMessageCapEditor({
  used,
  cap,
  unlimited,
  saving,
  onSave,
}: {
  used: number;
  cap: number | null;
  unlimited: boolean;
  saving: boolean;
  onSave: (cap: number | null) => void;
}) {
  const [val, setVal] = useState(cap != null ? String(cap) : '');
  const [unl, setUnl] = useState(unlimited);
  const pct = unlimited || !cap ? 0 : Math.min(100, Math.round((used / cap) * 100));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <input type="checkbox" checked={unl} onChange={(e) => setUnl(e.target.checked)} />
          Unlimited
        </label>
        {!unl && (
          <input
            type="number"
            min={0}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            className="h-8 w-32 rounded-md border border-border bg-surface px-2 text-sm tabular-nums"
            placeholder="messages / mo"
          />
        )}
        <Button
          size="sm"
          loading={saving}
          onClick={() => onSave(unl ? null : Math.max(0, Math.floor(Number(val) || 0)))}
        >
          Save
        </Button>
      </div>
      <p className="text-xs text-foreground-muted">
        {unlimited
          ? 'Unlimited — no metering this month.'
          : `${used.toLocaleString()} / ${(cap ?? 0).toLocaleString()} used this month (${pct}%).`}
      </p>
    </div>
  );
}

// Full admin wallet control: balance, metering toggle, per-message price +
// margin, top-up, adjust, low-balance threshold, lifetime figures, and a
// collapsible ledger. Amounts are entered in dollars; the API converts.
function WalletBilling({
  wallet,
  orgId,
  onSetMetering,
  meteringSaving,
  onSetPrice,
  priceSaving,
  onTopUp,
  topUpSaving,
  onAdjust,
  adjustSaving,
  onSetThreshold,
  thresholdSaving,
}: {
  wallet: WalletDto;
  orgId: string;
  onSetMetering: (enabled: boolean) => void;
  meteringSaving: boolean;
  onSetPrice: (priceUsd: number) => void;
  priceSaving: boolean;
  onTopUp: (body: { amountUsd: number; note?: string }) => void;
  topUpSaving: boolean;
  onAdjust: (body: { amountUsd: number; note?: string }) => void;
  adjustSaving: boolean;
  onSetThreshold: (lowBalanceUsd: number) => void;
  thresholdSaving: boolean;
}) {
  const [priceStr, setPriceStr] = useState(
    (wallet.pricePerMessageMicros / MICROS_PER_USD).toString(),
  );
  const [topUpStr, setTopUpStr] = useState('');
  const [topUpNote, setTopUpNote] = useState('');
  const [adjustStr, setAdjustStr] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [thresholdStr, setThresholdStr] = useState(
    (wallet.lowBalanceThresholdMicros / MICROS_PER_USD).toString(),
  );

  return (
    <div className="space-y-5">
      {/* Balance + metering */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">Balance</p>
          <p className="mt-0.5 text-3xl font-semibold tabular-nums">
            ${formatMicrosUsd(wallet.availableMicros)}
          </p>
          {wallet.heldMicros > 0 ? (
            <p className="mt-0.5 text-xs text-foreground-muted">
              ${formatMicrosUsd(wallet.heldMicros)} held (in-flight sends)
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={wallet.meteringEnabled ? 'success' : 'muted'}>
            Metering {wallet.meteringEnabled ? 'ON' : 'OFF'}
          </Badge>
          <Button
            size="sm"
            variant="secondary"
            loading={meteringSaving}
            onClick={() => onSetMetering(!wallet.meteringEnabled)}
          >
            {wallet.meteringEnabled ? 'Turn off' : 'Turn on'}
          </Button>
        </div>
      </div>

      {/* Price + margin */}
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-xs font-medium text-foreground">Per-message price</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <span className="text-sm text-foreground-muted">$</span>
            <input
              type="number"
              min={0.0375}
              step={0.0001}
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
              className="h-8 w-28 rounded-md border border-border bg-surface px-2 text-sm tabular-nums"
            />
          </div>
          <Button
            size="sm"
            loading={priceSaving}
            onClick={() => {
              const v = Number(priceStr);
              if (!Number.isFinite(v) || v < 0.0375) {
                toast.error('Price must be at least $0.0375');
                return;
              }
              onSetPrice(v);
            }}
          >
            Save price
          </Button>
        </div>
        <p className="text-xs text-foreground-muted">
          Meta cost ${formatMicrosUsd(wallet.metaCostMicros)}, your price $
          {formatMicrosUsd(wallet.pricePerMessageMicros)} → margin $
          {formatMicrosUsd(wallet.marginPerMessageMicros)} ({wallet.marginPct.toFixed(1)}%)
        </p>
      </div>

      {/* Top-up + adjust */}
      <div className="grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">Top up</p>
          <div className="flex items-center gap-1">
            <span className="text-sm text-foreground-muted">$</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={topUpStr}
              onChange={(e) => setTopUpStr(e.target.value)}
              placeholder="0.00"
              className="h-8 w-28 rounded-md border border-border bg-surface px-2 text-sm tabular-nums"
            />
          </div>
          <input
            type="text"
            value={topUpNote}
            onChange={(e) => setTopUpNote(e.target.value)}
            placeholder="Note (optional)"
            className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm"
          />
          <Button
            size="sm"
            loading={topUpSaving}
            onClick={() => {
              const v = Number(topUpStr);
              if (!Number.isFinite(v) || v <= 0) {
                toast.error('Enter an amount greater than $0');
                return;
              }
              onTopUp({ amountUsd: v, note: topUpNote.trim() || undefined });
              setTopUpStr('');
              setTopUpNote('');
            }}
          >
            Add balance
          </Button>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">Manual adjustment</p>
          <div className="flex items-center gap-1">
            <span className="text-sm text-foreground-muted">$</span>
            <input
              type="number"
              step={0.01}
              value={adjustStr}
              onChange={(e) => setAdjustStr(e.target.value)}
              placeholder="e.g. -5.00"
              className="h-8 w-28 rounded-md border border-border bg-surface px-2 text-sm tabular-nums"
            />
          </div>
          <input
            type="text"
            value={adjustNote}
            onChange={(e) => setAdjustNote(e.target.value)}
            placeholder="Reason (optional)"
            className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm"
          />
          <Button
            size="sm"
            variant="secondary"
            loading={adjustSaving}
            onClick={() => {
              const v = Number(adjustStr);
              if (!Number.isFinite(v) || v === 0) {
                toast.error('Enter a non-zero amount (negative to debit)');
                return;
              }
              onAdjust({ amountUsd: v, note: adjustNote.trim() || undefined });
              setAdjustStr('');
              setAdjustNote('');
            }}
          >
            Apply adjustment
          </Button>
        </div>
      </div>

      {/* Threshold */}
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-xs font-medium text-foreground">Low-balance alert threshold</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <span className="text-sm text-foreground-muted">$</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={thresholdStr}
              onChange={(e) => setThresholdStr(e.target.value)}
              className="h-8 w-28 rounded-md border border-border bg-surface px-2 text-sm tabular-nums"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            loading={thresholdSaving}
            onClick={() => {
              const v = Number(thresholdStr);
              if (!Number.isFinite(v) || v < 0) {
                toast.error('Threshold must be $0 or more');
                return;
              }
              onSetThreshold(v);
            }}
          >
            Save threshold
          </Button>
        </div>
        <p className="text-xs text-foreground-muted">
          The tenant sees a &ldquo;running low&rdquo; warning when the balance drops to this amount.
        </p>
      </div>

      {/* Lifetime */}
      <div className="grid grid-cols-2 gap-2 border-t border-border pt-4 min-[520px]:grid-cols-4">
        <Metric label="Messages" value={wallet.lifetimeMessages.toLocaleString()} mono />
        <Metric label="Spent" value={`$${formatMicrosUsd(wallet.lifetimeSpentMicros)}`} mono />
        <Metric label="Topped up" value={`$${formatMicrosUsd(wallet.lifetimeToppedUpMicros)}`} mono />
        <Metric label="Our margin" value={`$${formatMicrosUsd(wallet.lifetimeMarginMicros)}`} mono />
      </div>

      {/* Ledger */}
      <WalletLedger orgId={orgId} />
    </div>
  );
}

// Collapsible admin wallet ledger with cursor pagination.
function WalletLedger({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const ledgerQ = useInfiniteQuery({
    queryKey: ['admin-org-wallet-ledger', orgId],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      api.get<WalletLedgerPage>(
        `/api/v1/aligned-admin/orgs/${orgId}/wallet/ledger?limit=50${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open,
  });
  const rows = ledgerQ.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-brand-600"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        Ledger
      </button>
      {open ? (
        <div className="mt-3">
          {ledgerQ.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-foreground-muted">No wallet activity yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-surface-muted/60 text-[11px] uppercase tracking-wide text-foreground-subtle">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="hidden px-3 py-2 text-right sm:table-cell">Available</th>
                    <th className="hidden px-3 py-2 md:table-cell">Actor</th>
                    <th className="hidden px-3 py-2 lg:table-cell">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => {
                    const positive = r.amountMicros >= 0;
                    return (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap px-3 py-2 text-foreground-muted">
                          {formatRelative(r.createdAt)}
                        </td>
                        <td className="px-3 py-2">{WALLET_KIND_LABEL[r.kind] ?? r.kind}</td>
                        <td
                          className={
                            'px-3 py-2 text-right font-medium tabular-nums ' +
                            (positive ? 'text-emerald-700' : 'text-red-700')
                          }
                        >
                          {positive ? '+' : '−'}${formatMicrosUsd(Math.abs(r.amountMicros))}
                        </td>
                        <td className="hidden px-3 py-2 text-right tabular-nums text-foreground-muted sm:table-cell">
                          ${formatMicrosUsd(r.availableAfterMicros)}
                        </td>
                        <td className="hidden px-3 py-2 text-foreground-muted md:table-cell">
                          {r.actorName ?? 'system'}
                        </td>
                        <td className="hidden px-3 py-2 text-foreground-muted lg:table-cell">
                          {r.note ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {ledgerQ.hasNextPage ? (
            <div className="mt-3 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                loading={ledgerQ.isFetchingNextPage}
                onClick={() => ledgerQ.fetchNextPage()}
              >
                Load older
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
