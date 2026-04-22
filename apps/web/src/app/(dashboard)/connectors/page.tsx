'use client';

import {
  type ConnectorAuthKind,
  type ConnectorDto,
  IMPORT_ENTITY_KINDS,
  IMPORT_ENTITY_LABELS,
  type ImportEntityKind,
  type SyncRunDto,
} from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Check,
  Copy,
  PlayCircle,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';

const STATUS_VARIANT: Record<ConnectorDto['status'], 'success' | 'muted' | 'warning' | 'danger'> = {
  active: 'success',
  paused: 'muted',
  failing: 'warning',
  disabled: 'danger',
};

export default function ConnectorsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['connectors'],
    queryFn: () => api.get<{ data: ConnectorDto[] }>('/api/v1/connectors'),
  });

  const sync = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/connectors/${id}/sync`),
    onSuccess: () => {
      toast.success('Sync queued');
      if (activeId) queryClient.invalidateQueries({ queryKey: ['connector-runs', activeId] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Sync failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/connectors/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
      setActiveId(null);
      toast.success('Connector deleted');
    },
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { ok: boolean; status: number | null; error: string | null } }>(
        `/api/v1/connectors/${id}/test`,
      ),
    onSuccess: (res) => {
      if (res.data.ok) toast.success(`Reachable (HTTP ${res.data.status})`);
      else toast.error(res.data.error ?? 'Connection failed');
    },
  });

  return (
    <>
      <PageHeader
        title="API connectors"
        description="Pull data from your existing systems on a schedule, or accept push via inbound webhooks."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New connector
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Connectors</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <p className="px-6 py-8 text-center text-sm text-foreground-muted">Loading…</p>
          ) : (list.data?.data ?? []).length === 0 ? (
            <EmptyState
              icon={PlugZap}
              title="No connectors yet"
              description="Connect your existing system (Shopify, WooCommerce, custom REST) to keep data in sync."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" /> New connector
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {list.data?.data.map((c) => (
                <li key={c.id} className="px-6 py-4" data-testid={`connector-card-${c.id}`} data-connector-name={c.name}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{c.name}</p>
                        <Badge variant={STATUS_VARIANT[c.status]}>{c.status}</Badge>
                        <Badge variant="muted">{IMPORT_ENTITY_LABELS[c.entityKind]}</Badge>
                      </div>
                      <p className="mt-1 truncate text-xs text-foreground-subtle">
                        {c.endpointUrl ?? 'Webhook-only'}
                      </p>
                      <p className="mt-0.5 text-xs text-foreground-subtle">
                        {c.scheduleCron ? `Cron: ${c.scheduleCron}` : 'No schedule'} ·{' '}
                        {c.lastRunAt ? `last run ${formatRelative(c.lastRunAt)}` : 'never run'}
                      </p>
                      {c.webhookUrl ? (
                        <div className="mt-2 flex items-center gap-2">
                          <code className="truncate rounded bg-surface-muted px-2 py-0.5 font-mono text-xs">
                            {c.webhookUrl}
                          </code>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Copy webhook URL"
                            onClick={() => {
                              navigator.clipboard.writeText(c.webhookUrl!);
                              toast.success('Webhook URL copied');
                            }}
                          >
                            <Copy className="size-3.5" />
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <div className="flex items-center gap-1">
                        {c.endpointUrl ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => test.mutate(c.id)}
                            loading={test.isPending}
                            data-testid="connector-test-btn"
                          >
                            <Activity className="size-4" /> Test
                          </Button>
                        ) : null}
                        <Button size="sm" onClick={() => sync.mutate(c.id)} loading={sync.isPending}>
                          <PlayCircle className="size-4" /> Run now
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setActiveId(activeId === c.id ? null : c.id)}
                        >
                          <RefreshCw className="size-4" /> Runs
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Delete connector"
                          onClick={async () => {
                            if (
                              await confirmDialog({
                                title: `Delete "${c.name}"?`,
                                body: 'The connector and its sync history will be removed. This cannot be undone.',
                                confirmLabel: 'Delete',
                                destructive: true,
                              })
                            ) {
                              remove.mutate(c.id);
                            }
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                  {activeId === c.id ? <RunHistory connectorId={c.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateConnectorDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['connectors'] });
          setCreateOpen(false);
        }}
      />
    </>
  );
}

function RunHistory({ connectorId }: { connectorId: string }) {
  const runs = useQuery({
    queryKey: ['connector-runs', connectorId],
    queryFn: () => api.get<{ data: SyncRunDto[] }>(`/api/v1/connectors/${connectorId}/runs?limit=50`),
    refetchInterval: 15_000,
  });
  return (
    <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface-muted/30">
      {runs.isLoading ? (
        <p className="px-4 py-4 text-center text-xs text-foreground-muted">Loading runs…</p>
      ) : (runs.data?.data ?? []).length === 0 ? (
        <p className="px-4 py-4 text-center text-xs text-foreground-muted">No runs yet.</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-muted text-foreground-subtle">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Trigger</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Fetched</th>
              <th className="px-3 py-2 text-right">Upserted</th>
              <th className="px-3 py-2 text-right">Failed</th>
              <th className="px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {runs.data?.data.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2">{formatRelative(r.startedAt ?? r.createdAt)}</td>
                <td className="px-3 py-2 text-foreground-muted">{r.trigger}</td>
                <td className="px-3 py-2">
                  <Badge
                    variant={
                      r.status === 'succeeded'
                        ? 'success'
                        : r.status === 'failed'
                          ? 'danger'
                          : r.status === 'partial'
                            ? 'warning'
                            : 'muted'
                    }
                  >
                    {r.status}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.recordsFetched}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.recordsUpserted}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.recordsFailed}</td>
                <td className="truncate px-3 py-2 text-foreground-subtle">{r.errorMessage ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CreateConnectorDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState({
    name: '',
    entityKind: 'product' as ImportEntityKind,
    endpointUrl: '',
    authKind: 'none' as ConnectorAuthKind,
    bearerToken: '',
    apiKeyHeaderName: '',
    apiKeyValue: '',
    basicUser: '',
    basicPass: '',
    scheduleCron: '',
    enableInboundWebhook: false,
  });

  const create = useMutation({
    mutationFn: () => {
      const authConfig =
        draft.authKind === 'bearer'
          ? { kind: 'bearer' as const, token: draft.bearerToken }
          : draft.authKind === 'api_key'
            ? { kind: 'api_key' as const, headerName: draft.apiKeyHeaderName, value: draft.apiKeyValue }
            : draft.authKind === 'basic'
              ? { kind: 'basic' as const, username: draft.basicUser, password: draft.basicPass }
              : { kind: 'none' as const };
      return api.post('/api/v1/connectors', {
        name: draft.name,
        entityKind: draft.entityKind,
        endpointUrl: draft.endpointUrl || null,
        authKind: draft.authKind,
        authConfig: draft.authKind === 'none' ? undefined : authConfig,
        scheduleCron: draft.scheduleCron || null,
        enableInboundWebhook: draft.enableInboundWebhook,
      });
    },
    onSuccess: () => {
      toast.success('Connector created');
      onCreated();
      setDraft({
        name: '',
        entityKind: 'product',
        endpointUrl: '',
        authKind: 'none',
        bearerToken: '',
        apiKeyHeaderName: '',
        apiKeyValue: '',
        basicUser: '',
        basicPass: '',
        scheduleCron: '',
        enableInboundWebhook: false,
      });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Create failed'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New connector</DialogTitle>
          <DialogDescription>
            Pull from a REST endpoint, accept a push via inbound webhook, or both.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="conn-name">Name</Label>
              <Input id="conn-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-entity">Imports</Label>
              <Select
                value={draft.entityKind}
                onValueChange={(v) => setDraft({ ...draft, entityKind: v as ImportEntityKind })}
              >
                <SelectTrigger id="conn-entity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IMPORT_ENTITY_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {IMPORT_ENTITY_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="conn-endpoint">Endpoint URL (leave empty for webhook-only)</Label>
            <Input
              id="conn-endpoint"
              value={draft.endpointUrl}
              placeholder="https://your-system.example/api/products"
              onChange={(e) => setDraft({ ...draft, endpointUrl: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="conn-auth">Auth</Label>
              <Select
                value={draft.authKind}
                onValueChange={(v) => setDraft({ ...draft, authKind: v as ConnectorAuthKind })}
              >
                <SelectTrigger id="conn-auth">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="bearer">Bearer token</SelectItem>
                  <SelectItem value="api_key">API key header</SelectItem>
                  <SelectItem value="basic">Basic auth</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-schedule">Schedule (cron)</Label>
              <Input
                id="conn-schedule"
                value={draft.scheduleCron}
                placeholder="*/15 * * * *"
                onChange={(e) => setDraft({ ...draft, scheduleCron: e.target.value })}
              />
            </div>
          </div>

          {draft.authKind === 'bearer' ? (
            <div className="space-y-1.5">
              <Label htmlFor="conn-bearer">Bearer token</Label>
              <Input
                id="conn-bearer"
                type="password"
                value={draft.bearerToken}
                onChange={(e) => setDraft({ ...draft, bearerToken: e.target.value })}
              />
            </div>
          ) : null}
          {draft.authKind === 'api_key' ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="conn-api-header">Header name</Label>
                <Input
                  id="conn-api-header"
                  placeholder="X-API-Key"
                  value={draft.apiKeyHeaderName}
                  onChange={(e) => setDraft({ ...draft, apiKeyHeaderName: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conn-api-value">Header value</Label>
                <Input
                  id="conn-api-value"
                  type="password"
                  value={draft.apiKeyValue}
                  onChange={(e) => setDraft({ ...draft, apiKeyValue: e.target.value })}
                />
              </div>
            </div>
          ) : null}
          {draft.authKind === 'basic' ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="conn-basic-user">Username</Label>
                <Input
                  id="conn-basic-user"
                  value={draft.basicUser}
                  onChange={(e) => setDraft({ ...draft, basicUser: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conn-basic-pass">Password</Label>
                <Input
                  id="conn-basic-pass"
                  type="password"
                  value={draft.basicPass}
                  onChange={(e) => setDraft({ ...draft, basicPass: e.target.value })}
                />
              </div>
            </div>
          ) : null}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enableInboundWebhook}
              onChange={(e) => setDraft({ ...draft, enableInboundWebhook: e.target.checked })}
              className="size-4 rounded border-border accent-brand-500"
            />
            Generate inbound webhook URL (for push integrations)
          </label>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            <X className="size-4" /> Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!draft.name}>
            <Check className="size-4" /> Create connector
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
