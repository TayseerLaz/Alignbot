'use client';

import {
  IMPORT_ENTITY_LABELS,
  type ImportJobDto,
  type ImportJobRowDto,
} from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';

export default function ImportDetailPage() {
  const params = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [showFailedOnly, setShowFailedOnly] = useState(true);

  const job = useQuery({
    queryKey: ['import', params.id],
    queryFn: () => api.get<{ data: ImportJobDto }>(`/api/v1/imports/${params.id}`),
    refetchInterval: (q) => {
      const status = q.state.data?.data.status;
      return status === 'processing' || status === 'pending' || status === 'validating' ? 2000 : false;
    },
  });

  const rows = useQuery({
    queryKey: ['import-rows', params.id, showFailedOnly],
    queryFn: () =>
      api.get<{ data: ImportJobRowDto[] }>(
        `/api/v1/imports/${params.id}/rows?limit=200${showFailedOnly ? '&status=failed' : ''}`,
      ),
    refetchInterval: () => {
      const status = job.data?.data.status;
      return status === 'processing' || status === 'pending' || status === 'validating' ? 5000 : false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.post(`/api/v1/imports/${params.id}/cancel`),
    onSuccess: () => {
      toast.success('Cancellation requested');
      queryClient.invalidateQueries({ queryKey: ['import', params.id] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Cancel failed'),
  });

  if (job.isLoading || !job.data) {
    return <div className="text-sm text-foreground-muted">Loading…</div>;
  }
  const j = job.data.data;
  const inProgress = ['pending', 'validating', 'processing'].includes(j.status);
  const pct = j.totalRows > 0 ? Math.round((j.processedRows / j.totalRows) * 100) : inProgress ? null : 100;

  return (
    <>
      <PageHeader
        title={`${IMPORT_ENTITY_LABELS[j.entityKind]} import`}
        description={
          <span className="text-xs text-foreground-subtle">
            {j.sourceFilename ?? '—'} · started {formatRelative(j.startedAt ?? j.createdAt)}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link href="/imports">
                <ArrowLeft className="size-4" /> Back
              </Link>
            </Button>
            {inProgress ? (
              <Button variant="danger" onClick={() => cancelMutation.mutate()} loading={cancelMutation.isPending}>
                <Ban className="size-4" /> Cancel
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard label="Total rows" value={j.totalRows} />
        <StatCard label="Succeeded" value={j.succeededRows} accent="emerald" />
        <StatCard label="Failed" value={j.failedRows} accent={j.failedRows > 0 ? 'red' : undefined} />
        <StatCard label="Progress" value={pct === null ? '—' : `${pct}%`} />
      </div>

      {inProgress && pct !== null ? (
        <Card className="mt-6">
          <CardContent className="flex items-center gap-3 py-4">
            <Loader2 className="size-4 animate-spin text-brand-500" />
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted">
              <div className="h-full bg-brand-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-sm font-medium tabular-nums">{pct}%</span>
          </CardContent>
        </Card>
      ) : null}

      {j.errorMessage ? (
        <Card className="mt-6 border-red-200 bg-red-50/30">
          <CardHeader>
            <CardTitle className="text-red-700">Job error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap font-mono text-sm text-red-700">{j.errorMessage}</pre>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Rows</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setShowFailedOnly((v) => !v)}>
            {showFailedOnly ? 'Show all' : 'Show failed only'}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {rows.isLoading ? (
            <p className="px-6 py-8 text-center text-sm text-foreground-muted">Loading rows…</p>
          ) : (rows.data?.data ?? []).length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-foreground-muted">
              {showFailedOnly ? 'No failed rows. Nice!' : 'No rows recorded yet.'}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.data?.data.map((row) => (
                <RowItem key={row.id} row={row} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function RowItem({ row }: { row: ImportJobRowDto }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-6 py-3 text-left text-sm hover:bg-surface-muted/50"
      >
        <div className="flex items-center gap-3">
          {open ? (
            <ChevronDown className="size-4 text-foreground-subtle" />
          ) : (
            <ChevronRight className="size-4 text-foreground-subtle" />
          )}
          <span className="font-mono text-xs">Row {row.rowNumber}</span>
          <Badge
            variant={
              row.status === 'succeeded'
                ? 'success'
                : row.status === 'failed'
                  ? 'danger'
                  : 'muted'
            }
          >
            {row.status}
          </Badge>
        </div>
        {row.errors && row.errors.length > 0 ? (
          <span className="truncate text-xs text-red-600">{row.errors[0]?.message}</span>
        ) : null}
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border bg-surface-muted/40 px-6 py-4">
          {row.errors && row.errors.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {row.errors.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="font-mono text-foreground-subtle">{e.path || '_'}</span>
                  <span className="text-red-700">{e.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {row.rawData ? (
            <pre className="overflow-x-auto rounded bg-white p-3 text-xs">
              {JSON.stringify(row.rawData, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: 'emerald' | 'red';
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs uppercase tracking-wide text-foreground-subtle">{label}</p>
        <p
          className={
            accent === 'emerald'
              ? 'mt-1 text-2xl font-semibold text-emerald-700'
              : accent === 'red'
                ? 'mt-1 text-2xl font-semibold text-red-600'
                : 'mt-1 text-2xl font-semibold'
          }
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
