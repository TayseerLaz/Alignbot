'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, FlaskConical, XCircle } from 'lucide-react';
import { Fragment, useState } from 'react';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';

interface EvalTenant {
  org: string;
  total: number;
  retrievalScored: number;
  retrievalHits: number;
  deterministicPass: number;
  judgeScored: number;
  judgePass: number;
  overallPass: number;
}
interface EvalRunRow {
  id: string;
  trigger: string;
  mode: string;
  threshold: number;
  passed: boolean;
  tenantCount: number;
  passedCount: number;
  gitSha: string | null;
  note: string | null;
  durationMs: number | null;
  createdAt: string;
  tenants: EvalTenant[];
}
interface EvalScenario {
  key: string;
  dialect?: string | null;
  reply: string;
  candidateSkus: string[];
  retrieval: { hit: boolean; found: string[]; missing: string[]; expected: number };
  bestRank: number | null;
  deterministic: { passed: boolean; failures: string[] };
  judge?: { pass: boolean; critique: string } | null;
  model?: string | null;
}
interface EvalRunDetail extends Omit<EvalRunRow, 'tenants'> {
  summaries: (EvalTenant & { results: EvalScenario[] })[];
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${Math.round((100 * n) / d)}%`;
}

// Colour a rate: green ≥ threshold, amber within 10pts, red below.
function rateTone(n: number, d: number, threshold: number): string {
  if (d === 0) return 'text-foreground-subtle';
  const r = n / d;
  if (r + 1e-9 >= threshold) return 'text-success';
  if (r + 0.1 >= threshold) return 'text-warning';
  return 'text-danger';
}

export default function EvalDashboardPage() {
  const { session } = useSession();
  const [openId, setOpenId] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ['admin-eval-runs'],
    queryFn: () => api.get<{ data: EvalRunRow[] }>('/api/v1/aligned-admin/eval/runs?limit=25'),
    enabled: !!session?.user.isAlignedAdmin,
  });

  const detail = useQuery({
    queryKey: ['admin-eval-run', openId],
    queryFn: () => api.get<{ data: EvalRunDetail }>(`/api/v1/aligned-admin/eval/runs/${openId}`),
    enabled: !!openId,
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

  const rows = runs.data?.data ?? [];
  const latest = rows[0];

  return (
    <>
      <PageHeader
        title="Bot eval"
        description="WS3 regression gate — golden-set results per tenant. Newest run first."
      />

      {runs.isLoading ? (
        <SkeletonRows rows={4} cols={4} className="px-3 py-2" />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <FlaskConical className="mx-auto size-8 text-foreground-subtle" />
            <p className="text-sm font-medium text-foreground">No eval runs recorded yet.</p>
            <p className="mx-auto max-w-lg text-sm text-foreground-muted">
              Runs appear here once the eval harness is run with <code className="rounded bg-surface-muted px-1">--persist</code>.
              From <code className="rounded bg-surface-muted px-1">apps/api</code> against a real DB:
            </p>
            <pre className="mx-auto w-fit rounded-md bg-surface-muted px-4 py-3 text-left text-xs text-foreground-muted">
{`set -a; . ../../.env.production; set +a
pnpm eval:gate -- --persist --trigger pre-deploy`}
            </pre>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Latest-run headline */}
          {latest && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  {latest.passed ? (
                    <CheckCircle2 className="size-5 text-success" />
                  ) : (
                    <XCircle className="size-5 text-danger" />
                  )}
                  Latest run — {latest.passed ? 'all tenants passed' : `${latest.tenantCount - latest.passedCount} tenant(s) below threshold`}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant={latest.mode === 'retrieval' ? 'info' : 'coral'}>{latest.mode}</Badge>
                  <Badge variant="muted">{latest.trigger}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-foreground-subtle">
                  {formatRelative(latest.createdAt)} · threshold {Math.round(latest.threshold * 100)}%
                  {latest.durationMs != null ? ` · ${(latest.durationMs / 1000).toFixed(1)}s` : ''}
                  {latest.gitSha ? ` · ${latest.gitSha.slice(0, 7)}` : ''}
                  {latest.note ? ` · ${latest.note}` : ''}
                </p>
                <TenantTable tenants={latest.tenants} threshold={latest.threshold} mode={latest.mode} />
              </CardContent>
            </Card>
          )}

          {/* History */}
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-4 py-3">When</th>
                      <th className="px-4 py-3">Mode</th>
                      <th className="px-4 py-3">Trigger</th>
                      <th className="px-4 py-3 text-right">Tenants</th>
                      <th className="px-4 py-3">Verdict</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((run) => (
                      <Fragment key={run.id}>
                        <tr
                          className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-muted/50"
                          onClick={() => setOpenId(openId === run.id ? null : run.id)}
                        >
                          <td className="px-4 py-3 text-foreground-muted">{formatRelative(run.createdAt)}</td>
                          <td className="px-4 py-3">
                            <Badge variant={run.mode === 'retrieval' ? 'info' : 'coral'}>{run.mode}</Badge>
                          </td>
                          <td className="px-4 py-3 text-foreground-muted">{run.trigger}</td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {run.passedCount}/{run.tenantCount}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={run.passed ? 'success' : 'danger'}>
                              {run.passed ? 'pass' : 'fail'}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <ChevronRight
                              className={`size-4 text-foreground-subtle transition-transform ${
                                openId === run.id ? 'rotate-90' : ''
                              }`}
                            />
                          </td>
                        </tr>
                        {openId === run.id && (
                          <tr className="border-b border-border bg-surface-muted/30">
                            <td colSpan={6} className="px-4 py-4">
                              {detail.isLoading || detail.data?.data.id !== run.id ? (
                                <SkeletonRows rows={3} cols={3} className="px-2 py-1" />
                              ) : (
                                <RunDetail detail={detail.data.data} />
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}

function TenantTable({
  tenants,
  threshold,
  mode,
}: {
  tenants: EvalTenant[];
  threshold: number;
  mode: string;
}) {
  const full = mode !== 'retrieval';
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
          <tr>
            <th className="px-4 py-2">Tenant</th>
            <th className="px-4 py-2 text-right">Retrieval hit-rate</th>
            {full && <th className="px-4 py-2 text-right">Deterministic</th>}
            {full && <th className="px-4 py-2 text-right">Judge</th>}
            {full && <th className="px-4 py-2 text-right">Overall</th>}
          </tr>
        </thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.org} className="border-b border-border/50 last:border-0">
              <td className="px-4 py-2 font-medium">{t.org}</td>
              <td className={`px-4 py-2 text-right tabular-nums ${rateTone(t.retrievalHits, t.retrievalScored, threshold)}`}>
                {pct(t.retrievalHits, t.retrievalScored)}{' '}
                <span className="text-foreground-subtle">({t.retrievalHits}/{t.retrievalScored})</span>
              </td>
              {full && (
                <td className={`px-4 py-2 text-right tabular-nums ${rateTone(t.deterministicPass, t.total, threshold)}`}>
                  {pct(t.deterministicPass, t.total)}
                </td>
              )}
              {full && (
                <td className={`px-4 py-2 text-right tabular-nums ${rateTone(t.judgePass, t.judgeScored, threshold)}`}>
                  {pct(t.judgePass, t.judgeScored)}
                </td>
              )}
              {full && (
                <td className={`px-4 py-2 text-right font-medium tabular-nums ${rateTone(t.overallPass, t.total, threshold)}`}>
                  {pct(t.overallPass, t.total)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunDetail({ detail }: { detail: EvalRunDetail }) {
  return (
    <div className="space-y-5">
      {detail.summaries.map((s) => (
        <div key={s.org} className="space-y-2">
          <p className="text-sm font-semibold text-foreground">{s.org}</p>
          <div className="space-y-1">
            {s.results.map((res) => {
              const retOk = res.retrieval.expected === 0 || res.retrieval.hit;
              const ok = res.deterministic.passed && retOk && (!res.judge || res.judge.pass);
              return (
                <div key={res.key} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    {ok ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                    ) : (
                      <XCircle className="size-3.5 shrink-0 text-danger" />
                    )}
                    <span className="font-mono font-medium">{res.key}</span>
                    {res.dialect && <Badge variant="muted">{res.dialect}</Badge>}
                    <span className="text-foreground-subtle">
                      {res.retrieval.expected === 0
                        ? 'ret —'
                        : res.retrieval.hit
                          ? `ret ✓ @${res.bestRank ?? '?'}`
                          : `ret ✗ (${res.retrieval.missing.join(', ')})`}
                    </span>
                    <span className={res.deterministic.passed ? 'text-success' : 'text-danger'}>
                      det {res.deterministic.passed ? '✓' : `✗ (${res.deterministic.failures.join('; ')})`}
                    </span>
                    {res.judge && (
                      <span className={res.judge.pass ? 'text-success' : 'text-danger'}>
                        judge {res.judge.pass ? '✓' : `✗ (${res.judge.critique})`}
                      </span>
                    )}
                  </div>
                  {res.reply && (
                    <p className="mt-1.5 whitespace-pre-wrap text-foreground-muted">{res.reply}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
