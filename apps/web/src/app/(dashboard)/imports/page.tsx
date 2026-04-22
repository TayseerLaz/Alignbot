'use client';

import {
  IMPORT_ENTITY_KINDS,
  IMPORT_ENTITY_LABELS,
  type ImportEntityKind,
  type ImportJobDto,
} from '@aligned/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
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
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUS_BADGE: Record<
  ImportJobDto['status'],
  { label: string; variant: 'default' | 'muted' | 'success' | 'warning' | 'danger' }
> = {
  pending: { label: 'Pending', variant: 'muted' },
  validating: { label: 'Validating', variant: 'default' },
  processing: { label: 'Processing', variant: 'default' },
  succeeded: { label: 'Succeeded', variant: 'success' },
  partial: { label: 'Partial', variant: 'warning' },
  failed: { label: 'Failed', variant: 'danger' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
};

export default function ImportsPage() {
  const [wizardOpen, setWizardOpen] = useState(false);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ['imports'],
    queryFn: () => api.get<{ data: ImportJobDto[] }>('/api/v1/imports?limit=50'),
    refetchInterval: (q) => {
      const data = q.state.data?.data ?? [];
      return data.some((j) => j.status === 'processing' || j.status === 'pending' || j.status === 'validating')
        ? 2000
        : false;
    },
  });

  const deleteOne = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/imports/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['imports'] });
      toast.success('Import removed');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  const clearAll = useMutation({
    mutationFn: (statuses?: ImportJobDto['status'][]) =>
      api.post<{ data: { removed: number } }>('/api/v1/imports/clear', statuses ? { statuses } : {}),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['imports'] });
      toast.success(`Cleared ${res.data.removed} import${res.data.removed === 1 ? '' : 's'}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Clear failed'),
  });

  const jobs = list.data?.data ?? [];
  const clearableCount = jobs.filter((j) =>
    ['succeeded', 'partial', 'failed', 'cancelled'].includes(j.status),
  ).length;
  const failedCount = jobs.filter((j) => j.status === 'failed').length;

  return (
    <>
      <PageHeader
        title="Imports"
        description="Upload spreadsheets to bulk-create or update products, services, and FAQs."
        actions={
          <Button onClick={() => setWizardOpen(true)}>
            <Upload className="size-4" /> New import
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Templates</CardTitle>
          <CardDescription>Download the pre-formatted XLSX for the entity you want to import.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {IMPORT_ENTITY_KINDS.map((kind) => (
            <a
              key={kind}
              href={`${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/v1/imports/templates/${kind}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                // The download endpoint is JWT-authed, so we POST a one-time download link instead.
                // Simpler: open with the access token in a query param? We pass it via Authorization
                // by triggering an XHR fetch + Blob download.
                e.preventDefault();
                downloadTemplate(kind).catch((err) =>
                  toast.error(err instanceof ApiError ? err.payload.message : 'Download failed'),
                );
              }}
              className="flex items-center justify-between rounded-md border border-border bg-white px-4 py-3 text-sm transition-colors hover:bg-surface-muted"
            >
              <div className="flex items-center gap-3">
                <FileSpreadsheet className="size-5 text-brand-500" />
                <span className="font-medium">{IMPORT_ENTITY_LABELS[kind]}</span>
              </div>
              <Download className="size-4 text-foreground-subtle" />
            </a>
          ))}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Recent imports</CardTitle>
            <CardDescription>
              Delete any import to clear history. Imported catalog data is NOT reverted.
            </CardDescription>
          </div>
          {clearableCount > 0 ? (
            <div className="flex items-center gap-2">
              {failedCount > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={clearAll.isPending && clearAll.variables?.length === 1}
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: `Delete ${failedCount} failed import${failedCount === 1 ? '' : 's'}?`,
                        body: 'Only jobs with status "failed" are removed. In-progress and successful jobs are kept.',
                        confirmLabel: 'Delete failed',
                        destructive: true,
                      })
                    ) {
                      clearAll.mutate(['failed']);
                    }
                  }}
                >
                  <Trash2 className="size-3.5" /> Clear failed ({failedCount})
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                loading={clearAll.isPending && !clearAll.variables?.length}
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: `Delete all ${clearableCount} finished import${clearableCount === 1 ? '' : 's'}?`,
                      body: 'Removes every succeeded, partial, failed, and cancelled job. In-progress jobs are kept. Cannot be undone.',
                      confirmLabel: 'Delete all',
                      destructive: true,
                    })
                  ) {
                    clearAll.mutate(undefined);
                  }
                }}
              >
                <Trash2 className="size-3.5" /> Clear all ({clearableCount})
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <div className="px-6 py-12 text-center text-sm text-foreground-muted">Loading…</div>
          ) : (list.data?.data ?? []).length === 0 ? (
            <EmptyState
              icon={Upload}
              title="No imports yet"
              description="Upload a spreadsheet to populate your catalog in seconds."
              action={
                <Button onClick={() => setWizardOpen(true)}>
                  <Upload className="size-4" /> Start an import
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {list.data?.data.map((job) => {
                const badge = STATUS_BADGE[job.status];
                const inProgress = ['pending', 'validating', 'processing'].includes(job.status);
                const pct =
                  job.totalRows > 0
                    ? Math.round((job.processedRows / job.totalRows) * 100)
                    : inProgress
                      ? null
                      : 100;
                return (
                  <li key={job.id} className="flex items-center justify-between gap-4 px-6 py-4">
                    <Link
                      href={`/imports/${job.id}`}
                      className="flex min-w-0 flex-1 items-center justify-between gap-4"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{IMPORT_ENTITY_LABELS[job.entityKind]}</span>
                          <Badge variant={badge.variant}>
                            {inProgress ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                            {badge.label}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate text-xs text-foreground-subtle">
                          {job.sourceFilename ?? '—'} · {formatRelative(job.createdAt)}
                        </p>
                        {inProgress && pct !== null ? (
                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                            <div
                              className="h-full bg-brand-500 transition-[width] duration-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-6">
                        <CountStat label="Rows" value={job.totalRows} />
                        <CountStat label="Succeeded" value={job.succeededRows} ok={job.succeededRows > 0} />
                        <CountStat label="Failed" value={job.failedRows} bad={job.failedRows > 0} />
                        <ChevronRight className="size-4 text-foreground-subtle" />
                      </div>
                    </Link>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Delete import"
                      loading={deleteOne.isPending && deleteOne.variables === job.id}
                      onClick={async () => {
                        if (
                          await confirmDialog({
                            title: `Delete this ${IMPORT_ENTITY_LABELS[job.entityKind]} import?`,
                            body: inProgress
                              ? 'This job is still running — it will be cancelled and removed. Imported data so far is NOT reverted.'
                              : 'The job row and its per-row results will be removed. Imported catalog data is NOT reverted.',
                            confirmLabel: 'Delete import',
                            destructive: true,
                          })
                        ) {
                          deleteOne.mutate(job.id);
                        }
                      }}
                    >
                      <Trash2 className="size-4 text-red-600" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ImportWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['imports'] });
          setWizardOpen(false);
        }}
      />
    </>
  );
}

function CountStat({
  label,
  value,
  ok,
  bad,
}: {
  label: string;
  value: number;
  ok?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="text-right">
      <p
        className={cn(
          'text-sm font-semibold tabular-nums',
          bad && 'text-red-600',
          ok && !bad && 'text-emerald-700',
        )}
      >
        {value}
      </p>
      <p className="text-[10px] uppercase tracking-wide text-foreground-subtle">{label}</p>
    </div>
  );
}

async function downloadTemplate(kind: ImportEntityKind) {
  const url = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/imports/templates/${kind}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aligned-${kind}-template.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

// ---------- wizard ---------------------------------------------------------
function ImportWizard({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [entityKind, setEntityKind] = useState<ImportEntityKind>('product');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setEntityKind('product');
    if (fileInput.current) fileInput.current.value = '';
  };

  const start = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const uploadRes = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/assets/upload-csv`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
          body: fd,
          credentials: 'include',
        },
      );
      if (!uploadRes.ok) {
        const text = await uploadRes.text();
        throw new Error(`Upload failed: ${text || uploadRes.statusText}`);
      }
      const upload = (await uploadRes.json()) as { data: { assetId: string } };
      await api.post(`/api/v1/imports`, {
        entityKind,
        sourceAssetId: upload.data.assetId,
      });
      toast.success('Import started');
      onCreated();
      reset();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start an import</DialogTitle>
          <DialogDescription>
            We accept CSV and XLSX files up to 50 MB. Use the matching template for cleanest results.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="entityKind">What are you importing?</Label>
            <Select value={entityKind} onValueChange={(v) => setEntityKind(v as ImportEntityKind)}>
              <SelectTrigger id="entityKind">
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
          <div className="space-y-1.5">
            <Label>File</Label>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-border px-6 py-10 text-center text-sm text-foreground-muted transition-colors hover:border-brand-400 hover:bg-brand-50/30"
            >
              {file ? (
                <>
                  <CheckCircle2 className="mb-2 size-7 text-emerald-600" />
                  <span className="font-medium text-foreground">{file.name}</span>
                  <span className="mt-1 text-xs text-foreground-subtle">
                    {(file.size / 1024).toFixed(1)} KB
                  </span>
                </>
              ) : (
                <>
                  <Upload className="mb-2 size-7 text-foreground-subtle" />
                  <span>Click to choose a CSV or XLSX</span>
                </>
              )}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>
              Existing rows are matched by SKU (products), slug (services), or upserted by org
              (business info). FAQs always create a new row — review your file before re-importing.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={start} loading={busy} disabled={!file}>
            Start import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
