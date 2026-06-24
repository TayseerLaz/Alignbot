'use client';

import { ORG_FEATURES } from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightToLine,
  Cpu,
  Download,
  Lock,
  MessageCircle,
  Pause,
  Play,
  ShieldCheck,
  Trash2,
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
  today: { tokens: number; usd: number; replies: number };
  thisMonth: { tokens: number; usd: number; replies: number };
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
  const d = detailsQ.data?.data;
  const usage = usageQ.data?.data;
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
            <div className="grid grid-cols-3 gap-2 pt-2">
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
            <div className="grid grid-cols-2 gap-2 pt-1">
              <Metric label="Tokens today" value={usage?.today.tokens} mono />
              <Metric label="USD today" value={usage ? `$${usage.today.usd.toFixed(2)}` : undefined} mono />
              <Metric label="Tokens / month" value={usage?.thisMonth.tokens} mono />
              <Metric label="USD / month" value={usage ? `$${usage.thisMonth.usd.toFixed(2)}` : undefined} mono />
            </div>
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
                      <th className="px-4 py-2">2FA</th>
                      <th className="px-4 py-2">Last login</th>
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
                        <td className="px-4 py-2">{m.totpEnabled ? 'On' : '—'}</td>
                        <td className="px-4 py-2 text-foreground-muted">
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
