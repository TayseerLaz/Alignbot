'use client';

import {
  BROADCAST_STATUS_LABELS,
  type BroadcastDto,
  type BroadcastEventDto,
  type RecipientDto,
  RECIPIENT_STATUS_LABELS,
  type RecipientStatus,
} from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  Download,
  Pause,
  Play,
  RefreshCw,
  Send,
  StopCircle,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError, getAccessToken } from '@/lib/api';

const STATUS_CLASS: Record<RecipientStatus, string> = {
  pending: 'bg-slate-100 text-slate-600',
  queued: 'bg-blue-50 text-blue-700',
  sent: 'bg-cyan-50 text-cyan-700',
  delivered: 'bg-emerald-50 text-emerald-700',
  read: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-50 text-red-700',
  skipped: 'bg-slate-100 text-slate-500',
};

export default function BroadcastDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'recipients' | 'timeline'>('overview');
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | ''>('');

  const broadcastQuery = useQuery({
    queryKey: ['broadcast', id],
    queryFn: () => api.get<{ data: BroadcastDto }>(`/api/v1/broadcasts/${id}`),
    // SSE drives invalidation; this is a slow-poll backstop.
    refetchInterval: 15_000,
  });

  // SSE: tick every 2s → invalidate counters/recipients/timeline.
  useEffect(() => {
    const url =
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}` +
      `/api/v1/broadcasts/${id}/sse?token=${encodeURIComponent(getAccessToken() ?? '')}`;
    // EventSource doesn't allow custom headers, so we pass the token in the
    // query string. The api accepts both — see plugins/auth.ts.
    let es: EventSource | null = null;
    try {
      es = new EventSource(url, { withCredentials: true });
      es.addEventListener('tick', () => {
        qc.invalidateQueries({ queryKey: ['broadcast', id] });
        qc.invalidateQueries({ queryKey: ['broadcast-recipients', id] });
        qc.invalidateQueries({ queryKey: ['broadcast-timeline', id] });
      });
      es.addEventListener('error', () => {
        // Browser auto-reconnects with backoff; nothing to do.
      });
    } catch {
      // SSE unsupported / blocked — slow-poll keeps it usable.
    }
    return () => {
      es?.close();
    };
  }, [id, qc]);

  const recipientsQuery = useQuery({
    queryKey: ['broadcast-recipients', id, statusFilter],
    queryFn: () =>
      api.get<{ data: RecipientDto[]; nextCursor: string | null }>(
        `/api/v1/broadcasts/${id}/recipients?` +
          new URLSearchParams({
            ...(statusFilter ? { status: statusFilter } : {}),
            limit: '100',
          }).toString(),
      ),
    enabled: tab === 'recipients',
    refetchInterval: tab === 'recipients' ? 4000 : false,
  });

  const timelineQuery = useQuery({
    queryKey: ['broadcast-timeline', id],
    queryFn: () =>
      api.get<{ data: BroadcastEventDto[] }>(`/api/v1/broadcasts/${id}/timeline`),
    enabled: tab === 'timeline',
    refetchInterval: tab === 'timeline' ? 5000 : false,
  });

  const lifecycle = (action: 'pause' | 'resume' | 'cancel') =>
    api.post<{ data: BroadcastDto }>(`/api/v1/broadcasts/${id}/${action}`).then((res) => {
      qc.invalidateQueries({ queryKey: ['broadcast', id] });
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      return res;
    });

  const pauseMutation = useMutation({
    mutationFn: () => lifecycle('pause'),
    onSuccess: () => toast.success('Paused'),
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Pause failed'),
  });
  const resumeMutation = useMutation({
    mutationFn: () => lifecycle('resume'),
    onSuccess: () => toast.success('Resumed'),
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Resume failed'),
  });
  const cancelMutation = useMutation({
    mutationFn: () => lifecycle('cancel'),
    onSuccess: () => toast.success('Cancelled'),
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Cancel failed'),
  });
  const rerunMutation = useMutation({
    mutationFn: () =>
      api.post<{ data: { requeued: number } }>(`/api/v1/broadcasts/${id}/rerun-failed`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['broadcast', id] });
      qc.invalidateQueries({ queryKey: ['broadcast-recipients', id] });
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      toast.success(`Re-queued ${res.data.requeued} recipient${res.data.requeued === 1 ? '' : 's'}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Re-run failed'),
  });
  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/api/v1/broadcasts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      toast.success('Broadcast deleted');
      window.location.href = '/broadcasts';
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });
  const resendMutation = useMutation({
    mutationFn: () =>
      api.post<{ data: { id: string; name: string } }>(`/api/v1/broadcasts/${id}/resend`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      toast.success(`Resending as "${res.data.name}"`);
      // Hop straight to the new broadcast so the operator can watch
      // counters tick on the fresh campaign.
      window.location.href = `/broadcasts/${res.data.id}`;
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Resend failed'),
  });

  const exportCsv = () => {
    const url = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/broadcasts/${id}/recipients.csv`;
    fetch(url, {
      headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const a = document.createElement('a');
        const objUrl = URL.createObjectURL(blob);
        a.href = objUrl;
        a.download = `broadcast-${id.slice(0, 8)}-recipients.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objUrl);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Export failed'));
  };

  const b = broadcastQuery.data?.data;

  return (
    <>
      <PageHeader
        title={b?.name ?? 'Broadcast'}
        description={
          b
            ? `${BROADCAST_STATUS_LABELS[b.status]} · ${b.totalRecipients} recipient${b.totalRecipients === 1 ? '' : 's'}`
            : 'Loading…'
        }
        actions={
          <div className="flex gap-2">
            <Link href="/broadcasts">
              <Button variant="ghost">
                <ChevronLeft className="size-4" /> Back
              </Button>
            </Link>
            {b?.status === 'sending' || b?.status === 'scheduled' ? (
              <Button variant="secondary" onClick={() => pauseMutation.mutate()}>
                <Pause className="size-4" /> Pause
              </Button>
            ) : null}
            {b?.status === 'paused' ? (
              <Button onClick={() => resumeMutation.mutate()}>
                <Play className="size-4" /> Resume
              </Button>
            ) : null}
            {b?.status &&
            !['completed', 'cancelled', 'failed'].includes(b.status) ? (
              <Button
                variant="danger"
                onClick={() => {
                  if (window.confirm('Cancel this broadcast? Pending recipients will be skipped.'))
                    cancelMutation.mutate();
                }}
              >
                <StopCircle className="size-4" /> Cancel
              </Button>
            ) : null}
            {b && b.failedCount > 0 ? (
              <Button
                variant="secondary"
                onClick={() => {
                  if (
                    window.confirm(
                      `Re-queue ${b.failedCount} failed recipient${b.failedCount === 1 ? '' : 's'}?`,
                    )
                  )
                    rerunMutation.mutate();
                }}
                disabled={rerunMutation.isPending}
              >
                <RefreshCw className="size-4" /> Re-run failed
              </Button>
            ) : null}
            {b && b.totalRecipients > 0 ? (
              <Button variant="ghost" onClick={exportCsv}>
                <Download className="size-4" /> Export CSV
              </Button>
            ) : null}
            {/* Resend only makes sense once the original is in a terminal
                state — for an active campaign the operator can pause +
                cancel + re-run instead. */}
            {b &&
            ['completed', 'cancelled', 'failed'].includes(b.status) &&
            b.totalRecipients > 0 ? (
              <Button
                onClick={() => {
                  if (
                    window.confirm(
                      `Resend "${b.name}" to the same ${b.totalRecipients} recipient${
                        b.totalRecipients === 1 ? '' : 's'
                      }? Creates a new broadcast and fires it immediately.`,
                    )
                  )
                    resendMutation.mutate();
                }}
                disabled={resendMutation.isPending}
              >
                <Send className="size-4" />{' '}
                {resendMutation.isPending ? 'Resending…' : 'Resend'}
              </Button>
            ) : null}
            {b ? (
              <Button
                variant="danger"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete broadcast "${b.name}"? This permanently removes the campaign + all recipient rows + timeline. Can't be undone.`,
                    )
                  )
                    deleteMutation.mutate();
                }}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="size-4" /> Delete
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Counter cards */}
      {b ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <CounterCard label="Queued" value={b.queuedCount} />
          <CounterCard label="Sent" value={b.sentCount} />
          <CounterCard label="Delivered" value={b.deliveredCount} />
          <CounterCard label="Read" value={b.readCount} />
          <CounterCard label="Failed" value={b.failedCount} accent="text-red-600" />
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(['overview', 'recipients', 'timeline'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 px-4 py-2 text-sm font-medium capitalize ${
              tab === t
                ? 'border-primary text-foreground'
                : 'border-transparent text-foreground-muted hover:text-foreground'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'overview' && b ? (
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Audience" value={b.audienceKind} />
            <Field
              label="A/B test"
              value={b.abTest ? 'Yes' : 'No'}
            />
            <Field
              label="Template A"
              value={b.variantATemplateId.slice(0, 8)}
            />
            {b.variantBTemplateId ? (
              <Field label="Template B" value={b.variantBTemplateId.slice(0, 8)} />
            ) : null}
            <Field
              label="Scheduled for"
              value={b.scheduledFor ? new Date(b.scheduledFor).toLocaleString() : '—'}
            />
            <Field
              label="Started at"
              value={b.startedAt ? new Date(b.startedAt).toLocaleString() : '—'}
            />
            <Field
              label="Completed at"
              value={b.completedAt ? new Date(b.completedAt).toLocaleString() : '—'}
            />
            <Field label="Total recipients" value={String(b.totalRecipients)} />
          </CardContent>
        </Card>
      ) : null}

      {tab === 'recipients' ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Recipients</CardTitle>
            <select
              className="rounded border border-border px-2 py-1 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as RecipientStatus | '')}
            >
              <option value="">All</option>
              {Object.entries(RECIPIENT_STATUS_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-foreground-subtle">
                  <tr>
                    <th className="px-6 py-3">Phone</th>
                    <th className="px-6 py-3">Variant</th>
                    <th className="px-6 py-3">Status</th>
                    <th className="px-6 py-3">Sent</th>
                    <th className="px-6 py-3">Delivered</th>
                    <th className="px-6 py-3">Read</th>
                    <th className="px-6 py-3">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {recipientsQuery.isLoading ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-8 text-center text-foreground-muted">
                        Loading…
                      </td>
                    </tr>
                  ) : null}
                  {recipientsQuery.data?.data.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="px-6 py-3 font-mono text-xs">{r.phoneE164}</td>
                      <td className="px-6 py-3 text-foreground-muted">{r.variant}</td>
                      <td className="px-6 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[r.status]}`}
                        >
                          {RECIPIENT_STATUS_LABELS[r.status]}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-foreground-muted">
                        {r.sentAt ? new Date(r.sentAt).toLocaleTimeString() : '—'}
                      </td>
                      <td className="px-6 py-3 text-foreground-muted">
                        {r.deliveredAt ? new Date(r.deliveredAt).toLocaleTimeString() : '—'}
                      </td>
                      <td className="px-6 py-3 text-foreground-muted">
                        {r.readAt ? new Date(r.readAt).toLocaleTimeString() : '—'}
                      </td>
                      <td className="px-6 py-3 text-xs text-red-600">
                        {r.metaErrorCode ? `${r.metaErrorCode}: ${r.metaErrorMessage ?? ''}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {tab === 'timeline' ? (
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(timelineQuery.data?.data ?? []).map((e) => (
              <div key={e.id} className="flex items-start gap-3 text-sm">
                <span className="font-mono text-xs text-foreground-subtle">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
                <span className="font-medium">{e.kind.replace(/_/g, ' ')}</span>
                {e.detail ? (
                  <code className="text-xs text-foreground-muted">{JSON.stringify(e.detail)}</code>
                ) : null}
              </div>
            ))}
            {timelineQuery.data?.data.length === 0 ? (
              <p className="text-sm text-foreground-muted">No events yet.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function CounterCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-foreground-subtle">{label}</div>
        <div className={`mt-1 font-mono text-2xl font-semibold ${accent ?? ''}`}>
          {value.toLocaleString()}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-foreground-subtle">{label}</div>
      <div className="mt-1">{value}</div>
    </div>
  );
}
