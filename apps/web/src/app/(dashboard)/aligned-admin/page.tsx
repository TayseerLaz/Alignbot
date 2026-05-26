'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowRightToLine,
  Building2,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiError, setAccessToken } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  productCount: number;
  serviceCount: number;
  lastActivityAt: string | null;
}

interface SystemHealth {
  orgs: { active: number; suspended: number; deleted: number };
  users: { total: number; pending: number; disabled: number };
  queues: {
    import: { waiting: number; active: number; failed: number };
    sync: { waiting: number; active: number; failed: number };
    webhook: { waiting: number; active: number; failed: number };
  };
  redis: { connected: boolean; opsPerSec: number | null };
}

export default function AlignedAdminPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const orgs = useQuery({
    queryKey: ['admin-orgs', debouncedSearch],
    queryFn: () =>
      api.get<{ data: OrgRow[] }>(
        `/api/v1/aligned-admin/orgs${debouncedSearch ? `?q=${encodeURIComponent(debouncedSearch)}` : ''}`,
      ),
  });

  const system = useQuery({
    queryKey: ['admin-system'],
    queryFn: () => api.get<{ data: SystemHealth }>('/api/v1/aligned-admin/system'),
    refetchInterval: 10_000,
  });

  const update = useMutation({
    mutationFn: (vars: { id: string; status: 'active' | 'suspended' }) =>
      api.patch(`/api/v1/aligned-admin/orgs/${vars.id}`, { status: vars.status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-orgs'] });
      toast.success('Updated');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Update failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/aligned-admin/orgs/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-orgs'] });
      toast.success('Organisation deleted');
    },
  });

  // Control: mint a session for the target org and land in their
  // dashboard. The session switch is silent (no nav until tokens are
  // in place) so the next request carries the new org-id JWT.
  const router = useRouter();
  const { refresh } = useSession();
  const controlOrg = useMutation({
    mutationFn: (o: OrgRow) =>
      api.post<{
        data: {
          accessToken: string;
          expiresAt: string;
          organizationId: string;
          organizationSlug: string;
          organizationName: string;
        };
      }>(`/api/v1/aligned-admin/orgs/${o.id}/impersonate`, {}),
    onSuccess: async (res, vars) => {
      setAccessToken(res.data.accessToken, res.data.expiresAt);
      await refresh();
      // Drop every cached query so we don't show admin-org data
      // inside the impersonated org's dashboard.
      queryClient.clear();
      toast.success(`Controlling ${vars.name} — you're now in their workspace.`);
      router.push('/dashboard');
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not open this org.'),
  });

  if (!session?.user.isAlignedAdmin) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-foreground-muted">ALIGNED admin role required.</p>
        </CardContent>
      </Card>
    );
  }

  const sys = system.data?.data;
  const orgRows = orgs.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="ALIGNED admin"
        description="Cross-tenant operations and system health."
        actions={
          <Button asChild>
            <Link href="/aligned-admin/new-tenant">
              <Plus className="size-4" /> New tenant
            </Link>
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Building2}
          label="Organisations"
          value={sys ? sys.orgs.active + sys.orgs.suspended : '—'}
          hint={sys ? `${sys.orgs.suspended} suspended` : undefined}
        />
        <StatCard
          icon={Users}
          label="Users"
          value={sys?.users.total ?? '—'}
          hint={sys ? `${sys.users.pending} pending verify` : undefined}
        />
        <StatCard
          icon={Activity}
          label="Redis ops/s"
          value={sys?.redis.opsPerSec ?? '—'}
          hint={sys?.redis.connected ? 'connected' : 'disconnected'}
        />
        <StatCard
          icon={Activity}
          label="Queue depth"
          value={
            sys
              ? sys.queues.import.waiting + sys.queues.sync.waiting + sys.queues.webhook.waiting
              : '—'
          }
          hint={
            sys
              ? `${sys.queues.import.failed + sys.queues.sync.failed + sys.queues.webhook.failed} failed`
              : undefined
          }
        />
      </div>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Queues</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {(['import', 'sync', 'webhook'] as const).map((k) => (
              <div key={k} className="rounded-md border border-border p-3 text-sm">
                <p className="text-xs uppercase tracking-wide text-foreground-subtle">{k}</p>
                {sys ? (
                  <div className="mt-1 grid grid-cols-3 gap-2">
                    <Stat label="Waiting" value={sys.queues[k].waiting} />
                    <Stat label="Active" value={sys.queues[k].active} />
                    <Stat label="Failed" value={sys.queues[k].failed} accent="red" />
                  </div>
                ) : (
                  <p className="mt-1 text-foreground-muted">—</p>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Organisations</CardTitle>
          <div className="relative w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
            <Input
              className="pl-9"
              placeholder="Search by name or slug…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {orgs.isLoading ? (
            <p className="px-6 py-8 text-center text-sm text-foreground-muted">Loading…</p>
          ) : orgRows.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-foreground-muted">No organisations.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                  <tr>
                    <th className="px-4 py-3">Org</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Members</th>
                    <th className="px-4 py-3 text-right">Products</th>
                    <th className="px-4 py-3 text-right">Services</th>
                    <th className="px-4 py-3">Last activity</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orgRows.map((o) => (
                    <tr key={o.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3">
                        <p className="font-medium">{o.name}</p>
                        <p className="font-mono text-xs text-foreground-subtle">{o.slug}</p>
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            o.status === 'active' ? 'success' : o.status === 'suspended' ? 'warning' : 'muted'
                          }
                        >
                          {o.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{o.memberCount}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{o.productCount}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{o.serviceCount}</td>
                      <td className="px-4 py-3 text-foreground-muted">
                        {o.lastActivityAt ? formatRelative(o.lastActivityAt) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {o.status === 'active' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              if (
                                await confirmDialog({
                                  title: `Suspend "${o.name}"?`,
                                  body: "Members won't be able to sign in until you reactivate the organisation. Their data stays intact.",
                                  confirmLabel: 'Suspend',
                                  destructive: true,
                                })
                              ) {
                                update.mutate({ id: o.id, status: 'suspended' });
                              }
                            }}
                          >
                            <Pause className="size-4" /> Suspend
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => update.mutate({ id: o.id, status: 'active' })}
                          >
                            <Play className="size-4" /> Reactivate
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => controlOrg.mutate(o)}
                          disabled={controlOrg.isPending || o.status !== 'active'}
                          title={
                            o.status === 'active'
                              ? `Open ${o.name} as an admin so you can edit their data.`
                              : 'Reactivate this organisation first to control it.'
                          }
                        >
                          <ArrowRightToLine className="size-4" /> Control
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Delete"
                          onClick={async () => {
                            if (
                              await confirmDialog({
                                title: `Permanently delete "${o.name}"?`,
                                body: 'Members, products, services, FAQs, API keys and webhooks for this organisation will all be removed. This cannot be undone.',
                                confirmLabel: 'Delete everything',
                                destructive: true,
                              })
                            ) {
                              remove.mutate(o.id);
                            }
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-foreground-subtle">{label}</p>
          <Icon className="size-4 text-foreground-subtle" />
        </div>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {hint ? <p className="mt-0.5 text-xs text-foreground-subtle">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: 'red' }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-foreground-subtle">{label}</p>
      <p className={accent === 'red' ? 'font-semibold tabular-nums text-red-600' : 'font-semibold tabular-nums'}>
        {value}
      </p>
    </div>
  );
}
