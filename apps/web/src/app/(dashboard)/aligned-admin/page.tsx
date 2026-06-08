'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowRightToLine,
  Building2,
  Check,
  Copy,
  Cpu,
  Eye,
  KeyRound,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Users,
  X,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, ApiError, setAccessToken } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';

export type AiPlan = 'basic' | 'middle' | 'max' | 'ultra';

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
  aiPlan: AiPlan;
}

export const AI_PLAN_LABEL: Record<AiPlan, string> = {
  basic: 'Basic',
  middle: 'Middle',
  max: 'Max',
  ultra: 'Ultra',
};

export const AI_PLAN_DESCRIPTION: Record<AiPlan, string> = {
  basic: 'Groq Llama 3.3 70B + GPT-4o-mini fallback. Cheap and fast.',
  middle: 'OpenAI GPT-4o. Premium quality at moderate cost.',
  max: 'Anthropic Claude Sonnet 4.6. Top-tier reasoning, highest cost.',
  ultra:
    'Flagship: Claude Haiku 4.5 for intent + per-customer persona memory, Claude Sonnet 4.6 for the grounded reply. Fast, best reasoning, lowest hallucination.',
};

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

  // Org details dialog state. Null = closed. We track the row that
  // opened it so the dialog can show the org name in its header.
  const [detailsOpenFor, setDetailsOpenFor] = useState<OrgRow | null>(null);
  const [aiOpenFor, setAiOpenFor] = useState<OrgRow | null>(null);

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
          <div className="flex items-center gap-2">
            <Button asChild variant="secondary">
              <Link href="/aligned-admin/leads">
                <Users className="size-4" /> Leads
              </Link>
            </Button>
            <Button asChild>
              <Link href="/aligned-admin/new-tenant">
                <Plus className="size-4" /> New tenant
              </Link>
            </Button>
          </div>
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
                    <th className="px-4 py-3">AI plan</th>
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
                      <td className="px-4 py-3">
                        <Badge
                          variant={o.aiPlan === 'max' ? 'coral' : o.aiPlan === 'middle' ? 'info' : 'muted'}
                          title={AI_PLAN_DESCRIPTION[o.aiPlan]}
                        >
                          {AI_PLAN_LABEL[o.aiPlan]}
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
                          onClick={() => setDetailsOpenFor(o)}
                          title="See members, emails, last logins, audit log."
                        >
                          <Eye className="size-4" /> Details
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAiOpenFor(o)}
                          title="See AI token + USD usage and change the plan."
                        >
                          <Cpu className="size-4" /> AI
                        </Button>
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
      <OrgDetailsDialog
        org={detailsOpenFor}
        onClose={() => setDetailsOpenFor(null)}
      />
      <AiUsageDialog
        org={aiOpenFor}
        onClose={() => setAiOpenFor(null)}
        onPlanChanged={() => {
          // Re-fetch the orgs list so the row's plan badge reflects
          // the change immediately (in addition to the dialog's own
          // optimistic update).
          queryClient.invalidateQueries({ queryKey: ['admin-orgs'] });
        }}
      />
    </>
  );
}

// ---------- Org details dialog --------------------------------------------
// Lazy-fetches /aligned-admin/orgs/:id/details only when opened. Shows
// the admin email, full member list with last-login + 2FA + lock status,
// WhatsApp channel health, recent audit log. Per-member "Send reset
// link" generates a one-hour reset URL the operator can DM to the
// customer — the platform never stores or shows plaintext passwords.
interface OrgDetailsResponse {
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
    status: string;
    emailVerified: boolean;
    totpEnabled: boolean;
    lastLoginAt: string | null;
    failedLoginAttempts: number;
    lockedUntil: string | null;
    joinedAt: string;
  }>;
  whatsappChannel: {
    displayPhoneNumber: string | null;
    phoneNumberId: string | null;
    isActive: boolean;
    isPrimary: boolean;
  } | null;
  counts: {
    products: number;
    services: number;
    faqs: number;
    apiKeys: number;
    webhooks: number;
  };
  recentAuditLog: Array<{
    action: string;
    actorEmail: string | null;
    ipAddress: string | null;
    createdAt: string;
  }>;
}

function OrgDetailsDialog({ org, onClose }: { org: OrgRow | null; onClose: () => void }) {
  const enabled = !!org;
  const details = useQuery({
    queryKey: ['admin-org-details', org?.id],
    queryFn: () =>
      api.get<{ data: OrgDetailsResponse }>(`/api/v1/aligned-admin/orgs/${org!.id}/details`),
    enabled,
    staleTime: 15_000,
  });

  const [resetLink, setResetLink] = useState<{
    email: string;
    url: string;
    expiresAt: string;
  } | null>(null);

  const sendReset = useMutation({
    mutationFn: (userId: string) =>
      api.post<{ data: { userEmail: string; resetUrl: string; expiresAt: string } }>(
        `/api/v1/aligned-admin/users/${userId}/reset-link`,
        {},
      ),
    onSuccess: (res) =>
      setResetLink({ email: res.data.userEmail, url: res.data.resetUrl, expiresAt: res.data.expiresAt }),
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not issue reset link.'),
  });

  const d = details.data?.data;

  return (
    <Dialog open={enabled} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{org?.name ?? 'Organisation details'}</DialogTitle>
          <DialogDescription>
            Slug: <code>{org?.slug}</code> · Status: {org?.status}
          </DialogDescription>
        </DialogHeader>
        {details.isLoading ? (
          <p className="text-sm text-foreground-muted">Loading…</p>
        ) : details.isError || !d ? (
          <p className="text-sm text-amber-700">Could not load details.</p>
        ) : (
          <div className="space-y-5 text-sm">
            {/* ---------- Counts strip ------------------------------- */}
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge>{d.counts.products} products</Badge>
              <Badge>{d.counts.services} services</Badge>
              <Badge>{d.counts.faqs} FAQs</Badge>
              <Badge>{d.counts.apiKeys} API keys</Badge>
              <Badge>{d.counts.webhooks} webhooks</Badge>
              {d.whatsappChannel ? (
                <Badge
                  className={
                    d.whatsappChannel.isActive
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-rose-100 text-rose-800'
                  }
                >
                  WhatsApp: {d.whatsappChannel.displayPhoneNumber ?? '—'}{' '}
                  {d.whatsappChannel.isActive ? '✓' : '✗'}
                </Badge>
              ) : (
                <Badge className="bg-amber-100 text-amber-800">No WhatsApp channel</Badge>
              )}
            </div>

            {/* ---------- Members table ------------------------------ */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
                Members ({d.members.length})
              </h3>
              <div className="overflow-hidden rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface-muted text-foreground-subtle">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">Email</th>
                      <th className="px-2 py-1 text-left font-medium">Role</th>
                      <th className="px-2 py-1 text-left font-medium">Status</th>
                      <th className="px-2 py-1 text-left font-medium">Last login</th>
                      <th className="px-2 py-1 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.members.map((m) => (
                      <tr key={m.userId} className="border-t border-border">
                        <td className="px-2 py-1.5">
                          <EditableEmail
                            userId={m.userId}
                            email={m.email}
                            orgId={org!.id}
                          />
                          {(m.firstName || m.lastName) ? (
                            <div className="text-[11px] text-foreground-muted">
                              {[m.firstName, m.lastName].filter(Boolean).join(' ')}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5 capitalize">{m.role}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-wrap gap-1">
                            {m.isActive ? (
                              <span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-800">
                                active
                              </span>
                            ) : (
                              <span className="rounded bg-zinc-200 px-1 text-[10px] text-zinc-700">
                                inactive
                              </span>
                            )}
                            {m.emailVerified ? (
                              <span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-800">
                                verified
                              </span>
                            ) : (
                              <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800">
                                unverified
                              </span>
                            )}
                            {m.totpEnabled ? (
                              <span className="rounded bg-sky-100 px-1 text-[10px] text-sky-800">
                                2FA
                              </span>
                            ) : null}
                            {m.lockedUntil ? (
                              <span className="rounded bg-rose-100 px-1 text-[10px] text-rose-800">
                                locked
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-foreground-muted">
                          {m.lastLoginAt ? formatRelative(m.lastLoginAt) : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => sendReset.mutate(m.userId)}
                            disabled={sendReset.isPending}
                            title="Generate a 10-minute password reset URL for this user. DM it right away."
                            className="h-7 px-2 text-[11px]"
                          >
                            <KeyRound className="size-3" /> Reset link
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ---------- Reset link surfaced inline ----------------- */}
            {resetLink ? (
              <div className="rounded border border-amber-300 bg-amber-50 p-3">
                <p className="mb-2 text-xs font-medium text-amber-900">
                  10-minute reset link for <strong>{resetLink.email}</strong> — copy + DM to the
                  customer immediately. The link is single-use and expires{' '}
                  {formatRelative(resetLink.expiresAt)}.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-[11px]">
                    {resetLink.url}
                  </code>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      await navigator.clipboard.writeText(resetLink.url);
                      toast.success('Copied');
                    }}
                  >
                    <Copy className="size-3" /> Copy
                  </Button>
                </div>
              </div>
            ) : null}

            {/* ---------- Recent audit log --------------------------- */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
                Recent activity ({d.recentAuditLog.length})
              </h3>
              <div className="max-h-48 overflow-auto rounded border border-border bg-surface-muted/30 p-2 text-[11px]">
                {d.recentAuditLog.length === 0 ? (
                  <p className="text-foreground-muted">No audit entries.</p>
                ) : (
                  <ul className="space-y-1">
                    {d.recentAuditLog.map((a, i) => (
                      <li key={i} className="flex items-baseline gap-2">
                        <span className="text-foreground-muted">{formatRelative(a.createdAt)}</span>
                        <span className="font-mono">{a.action}</span>
                        {a.actorEmail ? (
                          <span className="text-foreground-muted">by {a.actorEmail}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* ---------- Reminder about passwords ------------------- */}
            <p className="rounded border border-border bg-surface-muted/40 p-2 text-[11px] text-foreground-muted">
              Plaintext passwords are never stored or shown — they're bcrypt-hashed at signup. For
              a locked-out customer, click "Reset link" on their row to issue a one-hour
              single-use reset URL.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- EditableEmail ---------------------------------------------------
// Inline-edit a tenant member's email. Click pencil → input + save/cancel.
// Save fires PATCH /aligned-admin/users/:id, on success invalidates the
// org-details query so the row re-fetches the verified-state flags
// (the change forces re-verification + revokes all sessions, so the
// member is bounced to /login + verify-email on next attempt).
function EditableEmail({ userId, email, orgId }: { userId: string; email: string; orgId: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(email);

  const save = useMutation({
    mutationFn: () =>
      api.patch<{
        data: { userId: string; email: string; emailVerifiedAt: string | null; sessionsRevoked: number };
      }>(`/api/v1/aligned-admin/users/${userId}`, { email: draft.trim() }),
    onSuccess: async (res) => {
      toast.success(
        `Email updated to ${res.data.email}. ${res.data.sessionsRevoked} session(s) revoked; the user must re-verify the new mailbox.`,
      );
      setEditing(false);
      // Refresh the details dialog so verified/unverified chips update.
      await qc.invalidateQueries({ queryKey: ['admin-org-details', orgId] });
      // Refresh the outer org list too in case email is shown anywhere there.
      await qc.invalidateQueries({ queryKey: ['admin-orgs'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Email change failed.'),
  });

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="font-medium">{email}</span>
        <Button
          size="icon"
          variant="ghost"
          className="size-5"
          aria-label="Edit email"
          onClick={() => {
            setDraft(email);
            setEditing(true);
          }}
        >
          <Pencil className="size-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        type="email"
        placeholder="new@example.com"
        className="h-6 text-xs"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim() && draft.trim() !== email) save.mutate();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <Button
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label="Save"
        onClick={() => save.mutate()}
        disabled={save.isPending || !draft.trim() || draft.trim() === email}
      >
        <Check className="size-3" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label="Cancel"
        onClick={() => setEditing(false)}
      >
        <X className="size-3" />
      </Button>
    </div>
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

// ---------- AI usage + plan dialog ----------------------------------------
// Per-tenant detail view used by the ALIGNED super-admin only. Shows:
//   - current plan + provider chain that runs under it
//   - tokens used today / this week / this month, broken into input vs
//     output so spikes can be diagnosed (most spend is input — long
//     catalog prompt)
//   - USD cost over the same windows (rates from CHAT_PRICING)
//   - per-model breakdown over the last 30 days (catches "we're on
//     basic but 60% of replies hit the gpt-4o-mini fallback")
//   - 30-day daily series so the operator can spot trends at a glance
//   - inline plan selector — flipping it PUT-saves and invalidates
//     the parent list so the row badge stays in sync
//
// Security: page-level access is gated by useSession().isAlignedAdmin
// (the route /aligned-admin/* would redirect non-admins). All API
// calls go through the same gating (requireAlignedAdmin preHandler).
// The dialog never paints or echoes prompt text, customer messages,
// or KB content — only aggregate numbers per tenant. No cross-tenant
// data ever leaves the API: every query filters on { organizationId }.
interface AiUsageBucket {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  replies: number;
}

interface AiUsageResponse {
  aiPlan: AiPlan;
  today: AiUsageBucket;
  thisWeek: AiUsageBucket;
  thisMonth: AiUsageBucket;
  dailySeries: { date: string; tokens: number; usd: number; replies: number }[];
  byModel: { model: string; tokens: number; usd: number; replies: number }[];
}

function AiUsageDialog({
  org,
  onClose,
  onPlanChanged,
}: {
  org: OrgRow | null;
  onClose: () => void;
  onPlanChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const qKey = ['admin-ai-usage', org?.id];
  const usage = useQuery({
    enabled: !!org,
    queryKey: qKey,
    queryFn: () =>
      api.get<{ data: AiUsageResponse }>(`/api/v1/aligned-admin/orgs/${org!.id}/ai-usage`),
    // The data refreshes naturally every reply (each one writes a
    // MessageProvenance row); a 30-second refetch is the right cadence
    // for a dialog the admin keeps open while watching activity.
    refetchInterval: 30_000,
  });

  const setPlan = useMutation({
    mutationFn: (next: AiPlan) =>
      api.put<{ data: { id: string; aiPlan: AiPlan } }>(
        `/api/v1/aligned-admin/orgs/${org!.id}/ai-plan`,
        { aiPlan: next },
      ),
    onSuccess: (res) => {
      toast.success(`Plan changed to ${AI_PLAN_LABEL[res.data.aiPlan]}`);
      // Optimistic — show the new plan in this dialog immediately.
      queryClient.setQueryData(qKey, (prev: { data: AiUsageResponse } | undefined) =>
        prev ? { ...prev, data: { ...prev.data, aiPlan: res.data.aiPlan } } : prev,
      );
      onPlanChanged();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Plan change failed'),
  });

  if (!org) return null;
  const data = usage.data?.data;
  const currentPlan = data?.aiPlan ?? org.aiPlan;

  // Token-budget context: the daily per-org limit lives in
  // openai.ts (DAILY_TOKEN_LIMIT_PER_ORG = 200_000). We show it
  // alongside the today bucket so the admin can see "60% of cap used"
  // at a glance.
  const DAILY_CAP = 200_000;

  return (
    <Dialog open={!!org} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>AI usage · {org.name}</DialogTitle>
          <DialogDescription>
            Plan, tokens, and cost for this tenant. Data refreshes every 30 seconds.
          </DialogDescription>
        </DialogHeader>

        {usage.isLoading ? (
          <div className="h-32 animate-pulse rounded-md bg-surface-muted" />
        ) : !data ? (
          <p className="text-sm text-foreground-muted">No usage data yet.</p>
        ) : (
          <div className="space-y-5">
            {/* Plan selector */}
            <div className="rounded-lg border border-border p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-foreground-subtle">
                    Current plan
                  </p>
                  <p className="mt-1 text-lg font-semibold">{AI_PLAN_LABEL[currentPlan]}</p>
                  <p className="text-xs text-foreground-muted">{AI_PLAN_DESCRIPTION[currentPlan]}</p>
                </div>
                <Badge variant={currentPlan === 'max' ? 'coral' : currentPlan === 'middle' ? 'info' : 'muted'}>
                  {AI_PLAN_LABEL[currentPlan]}
                </Badge>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(['basic', 'middle', 'max', 'ultra'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPlan.mutate(p)}
                    disabled={setPlan.isPending || p === currentPlan}
                    className={`rounded-md border p-3 text-left transition ${
                      p === currentPlan
                        ? 'border-brand-500 bg-brand-50/60'
                        : 'border-border bg-surface hover:border-brand-300 hover:bg-brand-50/40'
                    } disabled:opacity-60`}
                  >
                    <p className="text-sm font-semibold">{AI_PLAN_LABEL[p]}</p>
                    <p className="mt-0.5 text-[11px] leading-tight text-foreground-muted">
                      {AI_PLAN_DESCRIPTION[p]}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            {/* Usage buckets */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <UsageCard label="Today" bucket={data.today} dailyCap={DAILY_CAP} />
              <UsageCard label="This week" bucket={data.thisWeek} />
              <UsageCard label="This month" bucket={data.thisMonth} />
            </div>

            {/* Per-model breakdown */}
            <div className="rounded-lg border border-border">
              <div className="border-b border-border bg-surface-muted/40 px-4 py-2 text-xs font-medium uppercase tracking-wider text-foreground-subtle">
                Last 30 days · per model
              </div>
              {data.byModel.length === 0 ? (
                <p className="px-4 py-3 text-sm text-foreground-muted">No replies recorded yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase tracking-wide text-foreground-subtle">
                    <tr className="border-b border-border">
                      <th className="px-4 py-2 text-left font-medium">Model</th>
                      <th className="px-4 py-2 text-right font-medium">Replies</th>
                      <th className="px-4 py-2 text-right font-medium">Tokens</th>
                      <th className="px-4 py-2 text-right font-medium">USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.map((m) => (
                      <tr key={m.model} className="border-b border-border last:border-0">
                        <td className="px-4 py-2 font-mono text-xs">{m.model}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {m.replies.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {m.tokens.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">${m.usd.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* 30-day sparkline */}
            <div className="rounded-lg border border-border p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <p className="text-xs font-medium uppercase tracking-wider text-foreground-subtle">
                  30-day usage
                </p>
                <p className="text-xs text-foreground-muted">
                  Total ${data.dailySeries.reduce((s, d) => s + d.usd, 0).toFixed(2)} ·{' '}
                  {data.dailySeries.reduce((s, d) => s + d.tokens, 0).toLocaleString()} tokens
                </p>
              </div>
              <DailyBars series={data.dailySeries} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UsageCard({
  label,
  bucket,
  dailyCap,
}: {
  label: string;
  bucket: AiUsageBucket;
  dailyCap?: number;
}) {
  const percentOfCap = dailyCap ? Math.min(100, Math.round((bucket.tokens / dailyCap) * 100)) : null;
  const barColor =
    percentOfCap === null
      ? 'bg-brand-500'
      : percentOfCap >= 95
        ? 'bg-red-500'
        : percentOfCap >= 80
          ? 'bg-amber-500'
          : 'bg-emerald-500';
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-[10px] uppercase tracking-wide text-foreground-subtle">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">${bucket.usd.toFixed(3)}</p>
      <p className="text-xs text-foreground-muted">
        {bucket.tokens.toLocaleString()} tokens · {bucket.replies.toLocaleString()} replies
      </p>
      <p className="text-[11px] text-foreground-subtle">
        in {bucket.inputTokens.toLocaleString()} · out {bucket.outputTokens.toLocaleString()}
      </p>
      {percentOfCap !== null ? (
        <>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
            <div
              className={`h-full ${barColor}`}
              style={{ width: `${percentOfCap}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] text-foreground-subtle">
            {percentOfCap}% of daily cap ({dailyCap!.toLocaleString()} tokens)
          </p>
        </>
      ) : null}
    </div>
  );
}

function DailyBars({ series }: { series: { date: string; tokens: number; usd: number }[] }) {
  const max = Math.max(1, ...series.map((d) => d.tokens));
  return (
    <div className="flex h-24 items-end gap-0.5">
      {series.map((d) => {
        const h = Math.round((d.tokens / max) * 100);
        return (
          <div
            key={d.date}
            title={`${d.date}: ${d.tokens.toLocaleString()} tokens · $${d.usd.toFixed(3)}`}
            className="flex-1 rounded-sm bg-brand-300 transition hover:bg-brand-500"
            style={{ height: `${h}%`, minHeight: d.tokens > 0 ? '2px' : '0px' }}
          />
        );
      })}
    </div>
  );
}
