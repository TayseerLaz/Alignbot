'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Globe,
  Image as ImageIcon,
  Loader2,
  Play,
  PowerOff,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { FlowEditor } from '@/components/bot/flow-editor';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { uploadFile } from '@/lib/upload';
import { cn } from '@/lib/utils';

interface BotConfig {
  id: string;
  personality: string | null;
  customPersonality: string | null;
  detectedTone: string | null;
  greeting: string | null;
  greetByName: boolean;
  languages: string;
  escalationRules: Record<string, unknown> | null;
  conversationFlow: Record<string, unknown> | null;
  responseTemplates: Record<string, unknown> | null;
  deployedAt: string | null;
  replyMode: 'text' | 'voice' | 'match_customer';
  ttsProvider: 'google' | 'elevenlabs';
  ttsVoiceName: string | null;
  greetingImageStorageKey: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface CrawlJob {
  id: string;
  rootUrl: string;
  status: string;
  pagesCrawled: number;
  pagesFailed: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface QuestionnaireItem {
  key: string;
  question: string;
  suggested?: string;
}

interface ScenarioRun {
  // The scenario row id (BotTestScenario). Always present now that scenarios
  // are DB-backed.
  id: string;
  key: string;
  prompt: string;
  expectation: string;
  source: 'ai_generated' | 'manual' | string;
  // The latest run id (BotTestRun). Null when the scenario has never run yet.
  runId: string | null;
  reply: string | null;
  score: number | null;
  notes: string | null;
  overrideScore: number | null;
  overrideNotes: string | null;
  ranAt: string | null;
}

const PERSONALITIES = [
  { key: 'friendly', label: 'Friendly', desc: 'Warm and helpful, light emoji' },
  { key: 'casual', label: 'Casual', desc: 'Conversational, contractions OK' },
  { key: 'formal', label: 'Formal', desc: 'Professional, no contractions' },
  { key: 'clinical', label: 'Clinical', desc: 'Concise, factual, list-driven' },
  { key: 'professional', label: 'Professional', desc: 'Polite and direct' },
];

// Reply languages offered as toggleable chips. The underlying storage
// on BotConfig.languages is a comma-separated string of ISO 639-1
// codes (e.g. "en,fr,ar"), which the bot-engine passes into the LLM
// system prompt. The chip UI is just a friendlier presentation.
const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'Arabic' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'tr', label: 'Turkish' },
];

function parseLangCodes(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function LanguagePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const selected = new Set(parseLangCodes(value));
  const toggle = (code: string) => {
    const next = new Set(selected);
    if (next.has(code)) {
      next.delete(code);
    } else {
      next.add(code);
    }
    // Always keep at least one language — fall back to English if the
    // operator unselects everything (matches BotConfig.languages
    // default).
    if (next.size === 0) next.add('en');
    // Emit in the LANGUAGES order so the saved value is stable
    // regardless of the order the operator clicked the chips.
    const ordered = LANGUAGES.map((l) => l.code).filter((c) => next.has(c));
    onChange(ordered.join(','));
  };
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Reply languages">
      {LANGUAGES.map((lang) => {
        const on = selected.has(lang.code);
        return (
          <button
            key={lang.code}
            type="button"
            id={lang.code === 'en' ? 'bot-langs' : undefined}
            onClick={() => toggle(lang.code)}
            aria-pressed={on}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
              on
                ? 'border-brand-500 bg-brand-500 text-on-brand'
                : 'border-border bg-surface text-foreground hover:bg-surface-muted',
            )}
          >
            {lang.label}
          </button>
        );
      })}
    </div>
  );
}

export default function BotPage() {
  const qc = useQueryClient();

  const configQ = useQuery({
    queryKey: ['bot-config'],
    queryFn: () => api.get<{ data: BotConfig }>('/api/v1/bot/config'),
  });
  const config = configQ.data?.data ?? null;

  // Factory reset — wipes every data source the bot grounds replies on so
  // a polluted demo state (e.g. "yoga mats" leaking into a juice-bar
  // account) can be cleared in one click. Doesn't touch the catalog,
  // business info or templates — operator rebuilds those via the normal UI.
  const factoryReset = useMutation({
    mutationFn: () =>
      api.post<{
        data: {
          kbDeleted: number;
          flowsDeleted: number;
          scenariosDeleted: number;
          runsDeleted: number;
          configCleared: boolean;
        };
      }>('/api/v1/bot/factory-reset'),
    onSuccess: (res) => {
      const d = res.data;
      toast.success(
        `Bot brain reset. Cleared ${d.kbDeleted} KB entries, ${d.flowsDeleted} flow candidates, ${d.scenariosDeleted} scenarios.`,
      );
      qc.invalidateQueries({ queryKey: ['bot-config'] });
      qc.invalidateQueries({ queryKey: ['bot-kb'] });
      qc.invalidateQueries({ queryKey: ['bot-scenarios-last'] });
      qc.invalidateQueries({ queryKey: ['bot-flow-candidates'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Reset failed'),
  });

  return (
    <>
      <PageHeader
        title="AI bot builder"
        description="Crawl your site, review the auto-generated knowledge base, set personality + greeting, simulate, deploy."
        actions={
          <div className="flex items-center gap-2">
            {/* "Reset bot brain" hidden — operators were one click away from
                nuking every KB entry / flow / scenario / run. The factoryReset
                mutation + its server endpoint are intentionally left in place;
                re-add the <Button> here when we have a more nuanced
                "reset just X" affordance. */}
            {config ? (
              <DeployToggle
                config={config}
                onChanged={() => qc.invalidateQueries({ queryKey: ['bot-config'] })}
              />
            ) : null}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <AnalyzeCard />
          <PersonalityCard config={config} />
          <VoiceReplyCard config={config} />
          <ScenarioRunner />
        </div>
        <div className="space-y-6">
          <Questionnaire />
          <Simulator />
        </div>
      </div>

      {/* The recommender shows 3-5 candidate flows tailored to the
          business; selecting one mirrors its JSON onto BotConfig so
          the editor below opens with that flow already loaded. */}
      <div className="mt-6">
        <FlowRecommendationsCard />
      </div>

      {/* Conversation flow gets the full content width — the editor
          needs the room for readable nodes + a side panel. Pulled out
          of the 2-col grid above. */}
      <div className="mt-6">
        <FlowAndTemplatesCard config={config} />
      </div>
    </>
  );
}

function DeployToggle({ config, onChanged }: { config: BotConfig; onChanged: () => void }) {
  const deploy = useMutation({
    mutationFn: () => api.post('/api/v1/bot/deploy'),
    onSuccess: () => {
      toast.success('Bot deployed — auto-replies are LIVE on inbound WhatsApp.');
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Deploy failed'),
  });
  const undeploy = useMutation({
    mutationFn: () => api.post('/api/v1/bot/undeploy'),
    onSuccess: () => {
      toast.success('Bot rolled back — auto-replies stopped.');
      onChanged();
    },
  });

  if (config.deployedAt) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="success" className="gap-1">
          <CheckCircle2 className="size-3" /> Deployed · v{config.version}
        </Badge>
        <Button
          size="sm"
          variant="secondary"
          loading={undeploy.isPending}
          onClick={async () => {
            if (
              await confirmDialog({
                title: 'Roll back deployment?',
                body: 'The bot will stop auto-replying. Your config + KB stay intact — redeploy any time.',
                confirmLabel: 'Roll back',
                destructive: true,
              })
            ) {
              undeploy.mutate();
            }
          }}
        >
          <PowerOff className="size-4" /> Roll back
        </Button>
      </div>
    );
  }

  return (
    <Button onClick={() => deploy.mutate()} loading={deploy.isPending}>
      <Sparkles className="size-4" /> Deploy bot
    </Button>
  );
}

// ---------- Analyze --------------------------------------------------------
function AnalyzeCard() {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState(200);
  const [maxDepth, setMaxDepth] = useState(6);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  // On mount, fetch the most recent crawl job for this org. The crawl
  // runs in the worker process — it keeps running even when the
  // operator navigates away. Without this, the /bot page would forget
  // there's an active crawl every time the component unmounts. We
  // restore the activeJobId only for live (pending / running) jobs;
  // terminal jobs are shown via the explicit re-fetch below.
  useQuery({
    queryKey: ['bot-analyze-latest'],
    queryFn: async () => {
      try {
        const res = await api.get<{ data: CrawlJob }>('/api/v1/bot/analyze/latest');
        if (
          (res.data.status === 'pending' || res.data.status === 'running') &&
          !activeJobId
        ) {
          setActiveJobId(res.data.id);
        }
        return res.data;
      } catch {
        // 404 — no crawl jobs yet. Normal first-time state.
        return null;
      }
    },
    staleTime: 30_000,
  });

  const start = useMutation({
    mutationFn: () =>
      api.post<{ data: CrawlJob }>('/api/v1/bot/analyze', {
        rootUrl: url,
        maxPages,
        maxDepth,
      }),
    onSuccess: (res) => {
      toast.success('Crawl started — runs in the background. Safe to navigate away.');
      setActiveJobId(res.data.id);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Failed'),
  });

  const cancel = useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: CrawlJob }>(`/api/v1/bot/analyze/${id}/cancel`),
    onSuccess: () => {
      toast.success('Stop requested — the worker will exit at the next page boundary.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Cancel failed'),
  });

  const status = useQuery({
    queryKey: ['bot-analyze', activeJobId],
    queryFn: () => api.get<{ data: CrawlJob }>(`/api/v1/bot/analyze/${activeJobId}`),
    enabled: !!activeJobId,
    refetchInterval: (q) => {
      const s = q.state.data?.data.status;
      // Keep polling while the crawl is alive. 2s is responsive without
      // flooding the API; the worker page boundary is ~3s on average.
      return s === 'pending' || s === 'running' ? 2000 : false;
    },
  });

  const job = status.data?.data;
  const isLive = job && (job.status === 'pending' || job.status === 'running');
  const done =
    job &&
    (job.status === 'succeeded' ||
      job.status === 'failed' ||
      job.status === 'partial' ||
      job.status === 'cancelled');

  useEffect(() => {
    if (done) qc.invalidateQueries({ queryKey: ['bot-kb'] });
  }, [done, qc]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-4" /> Analyze your website
        </CardTitle>
        <CardDescription>
          The crawler walks your public site BFS-style, then an LLM turns the content into a
          knowledge base + suggests a tone preset. Defaults to 200 pages and 6 levels deep — bump
          them for very large sites. Big crawls can take 10–40 minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            placeholder="https://yourbusiness.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Website URL"
          />
          <Button
            onClick={() => start.mutate()}
            loading={start.isPending}
            disabled={!url.trim().startsWith('http')}
          >
            <Play className="size-4" /> Start
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="crawl-max-pages" className="text-xs">
              Max pages (1–500)
            </Label>
            <Input
              id="crawl-max-pages"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={maxPages}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setMaxPages(Math.max(1, Math.min(500, Math.round(n))));
              }}
              aria-label="Maximum pages to crawl"
              className="h-9 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="crawl-max-depth" className="text-xs">
              Max link depth (0–8)
            </Label>
            <Input
              id="crawl-max-depth"
              type="number"
              inputMode="numeric"
              min={0}
              max={8}
              value={maxDepth}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setMaxDepth(Math.max(0, Math.min(8, Math.round(n))));
              }}
              aria-label="Maximum link depth to follow"
              className="h-9 text-sm"
            />
          </div>
        </div>
        {job ? (
          <div className="rounded-md border border-border bg-surface-muted/40 p-3 text-sm">
            <div className="flex items-center gap-2">
              {job.status === 'running' || job.status === 'pending' ? (
                <Loader2 className="size-4 animate-spin text-brand-500" />
              ) : job.status === 'succeeded' ? (
                <CheckCircle2 className="size-4 text-emerald-600" />
              ) : (
                <AlertTriangle className="size-4 text-amber-600" />
              )}
              <span className="font-medium capitalize">{job.status}</span>
              <span className="text-xs text-foreground-subtle">
                · {job.pagesCrawled} crawled
                {job.pagesFailed > 0 ? <> · {job.pagesFailed} failed</> : null}
              </span>
              {isLive ? (
                <>
                  <span className="ml-auto text-[11px] text-foreground-subtle">
                    Safe to navigate away
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => cancel.mutate(job.id)}
                    loading={cancel.isPending}
                    className="h-7 px-2 text-xs"
                  >
                    Stop
                  </Button>
                </>
              ) : null}
            </div>
            {job.errorMessage ? (
              <p className="mt-1 text-xs text-amber-700">{job.errorMessage}</p>
            ) : null}
            {job.pagesCrawled > 0 ? (
              <CrawlListingsReview jobId={job.id} jobIsLive={!!isLive} />
            ) : null}
            {(job.status === 'succeeded' ||
              job.status === 'failed' ||
              job.status === 'cancelled' ||
              job.status === 'partial') &&
            job.pagesCrawled > 0 ? (
              <CrawlResultsViewer jobId={job.id} />
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------- Crawl results viewer ---------------------------------------------
// Shows the actual pages a crawl touched: URL, title, fetch status, the size
// of the extracted body text, plus a 500-char preview on demand. Heavy lift:
// flags pages whose body matches the first page's body verbatim — that's the
// "SPA gave us the same skeleton for every URL" signal that an operator can
// otherwise spend hours debugging. Lazy-loads the page list on first expand
// so a successful crawl with 200 rows doesn't fetch them eagerly.
type CrawlPageRow = {
  id: string;
  url: string;
  title: string | null;
  fetchStatus: number | null;
  chars: number;
  errorMessage: string | null;
  bodyPreview: string;
  identicalToFirst: boolean;
  createdAt: string;
};

function CrawlResultsViewer({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['crawl-pages', jobId],
    queryFn: async () =>
      api.get<{ data: CrawlPageRow[] }>(`/api/v1/bot/analyze/${jobId}/pages`),
    enabled: open,
    staleTime: 60_000,
  });

  const pages = query.data?.data ?? [];
  const identicalCount = pages.filter((p) => p.identicalToFirst).length;
  const spaWarning = pages.length >= 3 && identicalCount >= pages.length - 1;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs font-medium text-foreground-subtle hover:text-foreground"
      >
        {open ? '▾' : '▸'} {open ? 'Hide' : 'View'} crawled pages
      </button>

      {open ? (
        <div className="mt-2 space-y-2">
          {query.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-foreground-subtle">
              <Loader2 className="size-3 animate-spin" /> Loading pages…
            </div>
          ) : query.isError ? (
            <p className="text-xs text-amber-700">Could not load pages.</p>
          ) : pages.length === 0 ? (
            <p className="text-xs text-foreground-subtle">No pages recorded for this crawl.</p>
          ) : (
            <>
              {spaWarning ? (
                <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                  <strong>Heads up:</strong> {identicalCount} of {pages.length} pages returned
                  identical body text. The site is likely a single-page app (React / Vue /
                  similar) that renders content client-side via JavaScript. Our crawler reads
                  HTML only — for SPAs, the bot will see only the homepage skeleton.
                  Consider asking the site owner for a sitemap.xml, or feed the FAQs / business
                  info manually under <code className="rounded bg-amber-100 px-1">/faqs</code>.
                </div>
              ) : null}
              <div className="overflow-hidden rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface-muted text-foreground-subtle">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">URL</th>
                      <th className="px-2 py-1 text-left font-medium">Title</th>
                      <th className="px-2 py-1 text-right font-medium">Status</th>
                      <th className="px-2 py-1 text-right font-medium">Chars</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pages.map((p) => {
                      const isExpanded = expandedRowId === p.id;
                      const isFailed =
                        !!p.errorMessage ||
                        (p.fetchStatus !== null && (p.fetchStatus < 200 || p.fetchStatus >= 400));
                      return (
                        <Fragment key={p.id}>
                          <tr
                            className="cursor-pointer border-t border-border hover:bg-surface-muted/40"
                            onClick={() => setExpandedRowId(isExpanded ? null : p.id)}
                          >
                            <td className="max-w-[24rem] truncate px-2 py-1 font-mono text-[11px]">
                              {p.url}
                              {p.identicalToFirst && pages.indexOf(p) > 0 ? (
                                <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">
                                  same body as 1st
                                </span>
                              ) : null}
                            </td>
                            <td className="max-w-[16rem] truncate px-2 py-1">
                              {p.title ?? <span className="text-foreground-subtle">—</span>}
                            </td>
                            <td className="px-2 py-1 text-right">
                              <span
                                className={cn(
                                  'rounded px-1 text-[10px]',
                                  isFailed
                                    ? 'bg-rose-100 text-rose-800'
                                    : 'bg-emerald-100 text-emerald-800',
                                )}
                              >
                                {p.fetchStatus ?? 'err'}
                              </span>
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums">
                              {p.chars.toLocaleString()}
                            </td>
                          </tr>
                          {isExpanded ? (
                            <tr className="border-t border-border bg-surface-muted/30">
                              <td colSpan={4} className="px-2 py-2">
                                {p.errorMessage ? (
                                  <p className="text-rose-700">
                                    Error: {p.errorMessage}
                                  </p>
                                ) : p.bodyPreview ? (
                                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 text-[11px] text-foreground">
                                    {p.bodyPreview}
                                    {p.chars > p.bodyPreview.length ? '\n…' : ''}
                                  </pre>
                                ) : (
                                  <p className="text-foreground-subtle">No body text extracted.</p>
                                )}
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------- Crawl listings review -------------------------------------------
// Listings the LLM extraction has materialised as DRAFT products on this
// crawl job. Polls live every 2 s while the crawl is running so the operator
// sees rows show up the moment the worker writes them. Bulk approve / deny
// flip every remaining draft from this crawl; per-row approve / deny act on
// one product. Approve = isAvailable=true (listing goes live and the bot
// can quote it). Deny = soft-delete.
type CrawlListingRow = {
  id: string;
  name: string;
  sku: string;
  priceMinor: number | null;
  currency: string;
  shortDescription: string | null;
  description: string | null;
  isAvailable: boolean;
  sourceUrl: string | null;
  primaryImageUrl: string | null;
  createdAt: string;
};

function formatPrice(priceMinor: number | null, currency: string): string | null {
  if (priceMinor == null) return null;
  const divisor = ['KWD', 'BHD', 'OMR', 'JOD'].includes(currency.toUpperCase()) ? 1000 : 100;
  const major = priceMinor / divisor;
  // Match the divisor's fractional precision (3 for KWD-family, 2 otherwise).
  const fractionDigits = divisor === 1000 ? 3 : 2;
  return `${major.toFixed(fractionDigits)} ${currency.toUpperCase()}`;
}

function CrawlListingsReview({ jobId, jobIsLive }: { jobId: string; jobIsLive: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'approve-all' | 'deny-all' | null>(null);

  const listings = useQuery({
    queryKey: ['crawl-listings', jobId],
    queryFn: async () =>
      api.get<{ data: CrawlListingRow[] }>(`/api/v1/bot/analyze/${jobId}/listings`),
    // Live during crawl (2s); idle after it ends so the panel stops polling
    // once the listing set is stable.
    refetchInterval: jobIsLive ? 2000 : false,
    placeholderData: keepPreviousData,
  });

  const rows = listings.data?.data ?? [];
  const pendingCount = rows.filter((r) => !r.isAvailable).length;
  const liveCount = rows.filter((r) => r.isAvailable).length;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['crawl-listings', jobId] });
    // Catalog count on the dashboard depends on these — refresh it too.
    void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
  };

  const approveAll = async () => {
    setBusy('approve-all');
    try {
      const res = await api.post<{ data: { approved: number } }>(
        `/api/v1/bot/analyze/${jobId}/listings/approve-all`,
      );
      toast.success(`Published ${res.data.approved} listing${res.data.approved === 1 ? '' : 's'}`);
      invalidate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Approve all failed');
    } finally {
      setBusy(null);
    }
  };

  const denyAll = async () => {
    const ok = await confirmDialog({
      title: `Deny ${pendingCount} draft${pendingCount === 1 ? '' : 's'}?`,
      description: 'They will be soft-deleted and won’t appear in your catalog.',
      confirmText: 'Deny all',
      destructive: true,
    });
    if (!ok) return;
    setBusy('deny-all');
    try {
      const res = await api.post<{ data: { denied: number } }>(
        `/api/v1/bot/analyze/${jobId}/listings/deny-all`,
      );
      toast.success(`Denied ${res.data.denied} listing${res.data.denied === 1 ? '' : 's'}`);
      invalidate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Deny all failed');
    } finally {
      setBusy(null);
    }
  };

  const approveOne = async (id: string) => {
    try {
      await api.post(`/api/v1/bot/analyze/${jobId}/listings/${id}/approve`);
      invalidate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Approve failed');
    }
  };
  const denyOne = async (id: string) => {
    try {
      await api.post(`/api/v1/bot/analyze/${jobId}/listings/${id}/deny`);
      invalidate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Deny failed');
    }
  };

  if (!listings.isLoading && rows.length === 0) {
    // While the crawl is still running, suggest the operator wait. After it
    // ends, this is a real "no listings detected" signal (homepage-only
    // crawl, KB-only content, etc).
    return (
      <div className="mt-3 rounded border border-border bg-surface p-3 text-xs text-foreground-subtle">
        {jobIsLive
          ? 'Listings will appear here as the LLM extracts them from each page. Drafts can be approved one-by-one or all at once.'
          : 'No product listings detected on this site. The KB and tone were still extracted from the crawl.'}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
        <div>
          <p className="text-sm font-medium">Review crawled listings</p>
          <p className="text-xs text-foreground-subtle">
            {rows.length} extracted · {pendingCount} pending · {liveCount} published
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={denyAll}
            disabled={pendingCount === 0 || !!busy}
            loading={busy === 'deny-all'}
          >
            <XCircle className="size-4" /> Deny all
          </Button>
          <Button
            size="sm"
            onClick={approveAll}
            disabled={pendingCount === 0 || !!busy}
            loading={busy === 'approve-all'}
          >
            <CheckCircle2 className="size-4" /> Approve all ({pendingCount})
          </Button>
        </div>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const price = formatPrice(r.priceMinor, r.currency);
          return (
            <li key={r.id} className="flex items-start gap-3 p-3">
              <div className="size-14 flex-none overflow-hidden rounded border border-border bg-surface-muted">
                {r.primaryImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.primaryImageUrl}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <div className="flex size-full items-center justify-center text-foreground-subtle">
                    <ImageIcon className="size-5" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  {price ? (
                    <Badge variant="secondary" className="font-mono text-[11px]">
                      {price}
                    </Badge>
                  ) : null}
                  {r.isAvailable ? (
                    <Badge className="bg-emerald-100 text-emerald-800">Live</Badge>
                  ) : (
                    <Badge variant="outline">Draft</Badge>
                  )}
                </div>
                {r.shortDescription || r.description ? (
                  <p className="mt-1 line-clamp-2 text-xs text-foreground-subtle">
                    {r.shortDescription || r.description}
                  </p>
                ) : null}
                {r.sourceUrl ? (
                  <a
                    href={r.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-1 inline-block truncate text-[11px] text-foreground-subtle hover:text-foreground"
                  >
                    {r.sourceUrl}
                  </a>
                ) : null}
              </div>
              <div className="flex flex-none items-center gap-1.5">
                {!r.isAvailable ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => denyOne(r.id)}>
                      <XCircle className="size-4" />
                    </Button>
                    <Button size="sm" onClick={() => approveOne(r.id)}>
                      <CheckCircle2 className="size-4" /> Approve
                    </Button>
                  </>
                ) : (
                  <Link
                    href={`/products/${r.id}`}
                    className="text-xs text-foreground-subtle hover:text-foreground"
                  >
                    Open
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- Personality + greeting -----------------------------------------
function PersonalityCard({ config }: { config: BotConfig | null }) {
  const qc = useQueryClient();
  const [personality, setPersonality] = useState<string>(config?.personality ?? 'friendly');
  const [greeting, setGreeting] = useState<string>(config?.greeting ?? '');
  const [greetByName, setGreetByName] = useState<boolean>(config?.greetByName ?? false);
  const [languages, setLanguages] = useState<string>(config?.languages ?? 'en');
  const [fallback, setFallback] = useState<string>(
    (config?.escalationRules as Record<string, string> | null)?.fallback ?? '',
  );
  const [greetingImageKey, setGreetingImageKey] = useState<string | null>(
    config?.greetingImageStorageKey ?? null,
  );
  const [greetingImageUrl, setGreetingImageUrl] = useState<string | null>(null);
  const [uploadingGreeting, setUploadingGreeting] = useState(false);
  const greetingFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!config) return;
    setPersonality(config.personality ?? config.detectedTone ?? 'friendly');
    setGreeting(config.greeting ?? '');
    setGreetByName(config.greetByName ?? false);
    setLanguages(config.languages ?? 'en');
    setFallback((config.escalationRules as Record<string, string> | null)?.fallback ?? '');
    setGreetingImageKey(config.greetingImageStorageKey ?? null);
  }, [config]);

  // Fetch a presigned GET URL for the existing greeting image so the
  // operator can see what they uploaded last time. The endpoint is
  // /assets/preview-by-key (same one product images use for thumbs).
  useEffect(() => {
    let cancelled = false;
    if (!greetingImageKey) {
      setGreetingImageUrl(null);
      return;
    }
    api
      .get<{ data: { url: string } }>(
        `/api/v1/assets/preview-by-key?key=${encodeURIComponent(greetingImageKey)}`,
      )
      .then((r) => {
        if (!cancelled) setGreetingImageUrl(r.data.url);
      })
      .catch(() => {
        if (!cancelled) setGreetingImageUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [greetingImageKey]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/bot/config', {
        personality,
        greeting,
        greetByName,
        languages,
        escalationRules: fallback ? { fallback } : null,
        greetingImageStorageKey: greetingImageKey,
      }),
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['bot-config'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  const onPickGreetingImage = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0]!;
    if (!file.type.startsWith('image/')) {
      toast.warning('Please choose an image file');
      return;
    }
    setUploadingGreeting(true);
    try {
      const { storageKey } = await uploadFile(file, 'image');
      setGreetingImageKey(storageKey);
      toast.success('Greeting image uploaded — remember to save');
    } catch (err) {
      if (err instanceof ApiError && err.payload.code === 'SERVICE_UNAVAILABLE') {
        toast.error('Object storage not configured. Add Wasabi keys to .env.');
      } else {
        toast.error(err instanceof Error ? err.message : 'Upload failed');
      }
    } finally {
      setUploadingGreeting(false);
      if (greetingFileRef.current) greetingFileRef.current.value = '';
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Personality + greeting</CardTitle>
        <CardDescription>
          Pick a preset or write custom guidance below.{' '}
          {config?.detectedTone ? (
            <>
              Crawler suggested:{' '}
              <span className="font-mono text-brand-600">{config.detectedTone}</span>.
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {PERSONALITIES.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPersonality(p.key)}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
                personality === p.key ? 'border-brand-500 bg-brand-50/50' : 'border-border hover:bg-surface-muted',
              )}
              aria-pressed={personality === p.key}
            >
              <p className="font-medium">{p.label}</p>
              <p className="text-xs text-foreground-muted">{p.desc}</p>
            </button>
          ))}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-greeting">Greeting</Label>
          <Textarea
            id="bot-greeting"
            rows={2}
            placeholder="Hi! How can I help today?"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
          />
          {/* Toggle controls whether the bot's FIRST reply in a thread
              opens with the customer's WhatsApp profile name. Picks up
              from Meta's contacts[].profile.name automatically — the
              operator never types anyone's name. Subsequent replies
              are unaffected. */}
          <label className="flex items-start gap-2 pt-1 text-sm">
            <input
              type="checkbox"
              checked={greetByName}
              onChange={(e) => setGreetByName(e.target.checked)}
              className="mt-1 size-4 cursor-pointer accent-brand-600"
            />
            <span>
              <span className="font-medium">Greet customer by name when the bot says hello</span>
              <span className="block text-[11px] text-foreground-muted">
                Picks up the customer&apos;s WhatsApp profile name automatically. Whenever the
                bot opens with a greeting (hi / hello / welcome / مرحبا / bonjour…), it
                includes their first name (e.g. &quot;Hi Razan, welcome to …&quot;). Mid-conversation
                replies don&apos;t shoehorn the name in. If WhatsApp didn&apos;t share a name, the
                greeting is used unchanged — no awkward empty placeholder.
              </span>
            </span>
          </label>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Greeting image (optional)</Label>
            {greetingImageKey ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setGreetingImageKey(null)}
                className="text-foreground-muted hover:text-red-600"
              >
                <Trash2 className="size-3.5" /> Remove
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] text-foreground-muted">
            When set, the bot attaches this image alongside any reply that opens with a
            greeting (hi / hello / مرحبا / bonjour…). One send per customer per 24 hours
            so a chatty customer doesn&apos;t get the banner over and over.
          </p>
          {greetingImageKey && greetingImageUrl ? (
            <div className="flex items-start gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={greetingImageUrl}
                alt="Greeting image preview"
                className="h-24 w-24 rounded-md border border-border object-cover"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => greetingFileRef.current?.click()}
                loading={uploadingGreeting}
              >
                <Upload className="size-4" /> Replace
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => greetingFileRef.current?.click()}
              disabled={uploadingGreeting}
              className="flex w-full flex-col items-center justify-center rounded-md border-2 border-dashed border-border px-4 py-6 text-sm text-foreground-muted transition-colors hover:border-brand-400 hover:bg-brand-50/30 disabled:opacity-60"
            >
              {uploadingGreeting ? (
                <Loader2 className="mb-1 size-5 animate-spin" />
              ) : (
                <ImageIcon className="mb-1 size-5 text-foreground-subtle" />
              )}
              <span>{uploadingGreeting ? 'Uploading…' : 'Click to upload a greeting image'}</span>
              <span className="mt-0.5 text-[10px] text-foreground-subtle">
                JPG / PNG / WEBP up to 10 MB
              </span>
            </button>
          )}
          <input
            ref={greetingFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => onPickGreetingImage(e.target.files)}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="bot-langs">Languages</Label>
            <LanguagePicker
              value={languages}
              onChange={setLanguages}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bot-fallback">Handoff fallback</Label>
            <Input
              id="bot-fallback"
              placeholder="I'll connect you with a teammate."
              value={fallback}
              onChange={(e) => setFallback(e.target.value)}
            />
          </div>
        </div>
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------- Flow recommendations ------------------------------------------
// LLM proposes 3-5 different ways to converse with customers (Quick Order,
// Hospitality Concierge, Support-First, etc.) — operator picks one and the
// editor below opens with that flow.
interface FlowCandidate {
  id: string;
  name: string;
  description: string;
  isRecommended: boolean;
  recommendReason: string | null;
  isSelected: boolean;
  flow: { nodes?: { intent: string; label: string; response: string }[] };
}

function FlowRecommendationsCard() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['bot-flow-candidates'],
    queryFn: () => api.get<{ data: FlowCandidate[] }>('/api/v1/bot/conversation-flows'),
    placeholderData: keepPreviousData,
  });
  const recommend = useMutation({
    mutationFn: () => api.post('/api/v1/bot/conversation-flows/recommend'),
    onSuccess: () => {
      toast.success('Generated fresh flow candidates from your business profile.');
      qc.invalidateQueries({ queryKey: ['bot-flow-candidates'] });
      qc.invalidateQueries({ queryKey: ['bot-config'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not generate flows'),
  });
  const select = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/bot/conversation-flows/${id}/select`),
    onSuccess: () => {
      toast.success('Active flow updated. The editor below reflects the new selection.');
      qc.invalidateQueries({ queryKey: ['bot-flow-candidates'] });
      qc.invalidateQueries({ queryKey: ['bot-config'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Select failed'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/bot/conversation-flows/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-flow-candidates'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  const candidates = list.data?.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Conversation flow recommendations</CardTitle>
          <CardDescription>
            Different ways your bot can talk to customers — generated from your business profile.
            Pick the one that matches how you want to reach customers, then fine-tune in the editor
            below. Re-generate after major KB updates.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            if (
              await confirmDialog({
                title: 'Generate new flow candidates?',
                body:
                  'Drafts 3–5 fresh recommendations using your current knowledge base, products and services. Replaces any unselected candidates. Your currently-selected flow is preserved until you pick a different one.',
                confirmLabel: 'Generate',
              })
            ) {
              recommend.mutate();
            }
          }}
          loading={recommend.isPending}
        >
          <Sparkles className="size-4" /> {candidates.length > 0 ? 'Re-generate' : 'Generate candidates'}
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {candidates.length === 0 && list.isSuccess && !list.isFetching ? (
          <div className="px-6 py-10 text-center text-sm text-foreground-muted">
            No candidates yet. Press <span className="font-medium">Generate candidates</span> — we'll
            propose a few different ways your bot can engage customers, tailored to your business.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {candidates.map((c) => (
              <FlowCandidateRow
                key={c.id}
                candidate={c}
                onSelect={() => select.mutate(c.id)}
                onDelete={async () => {
                  if (
                    await confirmDialog({
                      title: 'Delete this candidate?',
                      body: `"${c.name}" will be removed. You can re-generate fresh candidates anytime.`,
                      confirmLabel: 'Delete',
                      destructive: true,
                    })
                  ) {
                    remove.mutate(c.id);
                  }
                }}
                selecting={select.isPending && select.variables === c.id}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function FlowCandidateRow({
  candidate,
  onSelect,
  onDelete,
  selecting,
}: {
  candidate: FlowCandidate;
  onSelect: () => void;
  onDelete: () => void;
  selecting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const nodes = candidate.flow.nodes ?? [];
  return (
    <li className={`px-6 py-4 ${candidate.isSelected ? 'bg-brand-50/40' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{candidate.name}</span>
            {candidate.isSelected ? (
              <Badge variant="success" className="text-[10px]">
                <CheckCircle2 className="mr-1 size-3" /> Active
              </Badge>
            ) : null}
            {candidate.isRecommended && !candidate.isSelected ? (
              <Badge variant="default" className="text-[10px]">
                <Sparkles className="mr-1 size-3" /> Recommended for you
              </Badge>
            ) : null}
            <span className="text-[10px] text-foreground-subtle">
              {nodes.length} intent{nodes.length === 1 ? '' : 's'}
            </span>
          </div>
          <p className="mt-1 text-xs text-foreground-muted">{candidate.description}</p>
          {candidate.isRecommended && candidate.recommendReason ? (
            <p className="mt-1 text-[11px] italic text-brand-700">
              Why this fits: {candidate.recommendReason}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide' : 'Preview'}
          </Button>
          {candidate.isSelected ? null : (
            <>
              <Button size="sm" onClick={onSelect} loading={selecting}>
                Use this flow
              </Button>
              <Button size="icon" variant="ghost" aria-label="Delete candidate" onClick={onDelete}>
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>
      {expanded ? (
        <div className="mt-3 rounded-md border border-border bg-surface-muted/40 px-3 py-2">
          {nodes.length === 0 ? (
            <p className="text-xs italic text-foreground-subtle">No intents in this candidate.</p>
          ) : (
            <ul className="space-y-1.5">
              {nodes.map((n, idx) => (
                <li key={idx} className="text-xs">
                  <span className="font-mono text-[10px] text-foreground-subtle">{n.intent}</span>{' '}
                  <span className="font-medium">{n.label}</span>
                  <p className="ml-3 mt-0.5 text-foreground-muted">{n.response}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] italic text-foreground-subtle">
            {candidate.isSelected
              ? 'Edit this flow node-by-node in the editor below.'
              : 'Select this flow to load it into the editor for fine-tuning.'}
          </p>
        </div>
      ) : null}
    </li>
  );
}

// ---------- Flow + templates -----------------------------------------------
function FlowAndTemplatesCard({ config }: { config: BotConfig | null }) {
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: (snapshot: {
      nodes: { id: string; intent: string; label: string; response: string; x: number; y: number }[];
      edges: { id: string; source: string; target: string }[];
    }) => {
      // Keep responseTemplates as a flat intent → response map so the bot
      // engine (which reads response templates) still works without a
      // graph-aware planner.
      const responseTemplates: Record<string, string> = {};
      for (const n of snapshot.nodes) {
        if (n.intent && n.response) responseTemplates[n.intent] = n.response;
      }
      return api.put('/api/v1/bot/config', {
        conversationFlow: snapshot,
        responseTemplates,
      });
    },
    onSuccess: () => {
      toast.success('Flow saved');
      qc.invalidateQueries({ queryKey: ['bot-config'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversation flow</CardTitle>
        <CardDescription>
          Drag intents around, connect them with fallthrough edges, and edit each node's response
          template in the side panel. Drag from a node's right handle to another node's left handle
          to add an edge.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FlowEditor
          initial={{ conversationFlow: config?.conversationFlow ?? null }}
          onSave={(snapshot) => save.mutate(snapshot)}
          saving={save.isPending}
        />
      </CardContent>
    </Card>
  );
}

// ---------- Questionnaire --------------------------------------------------

// Each question key from /bot/questionnaire maps to either a same-page
// form field (scroll + focus the input) or an external page (link). Kept
// here so adding a new question on the API side is a one-line addition
// here too.
const QUESTION_ACTIONS: Record<
  string,
  { label: string; href?: string; focusId?: string }
> = {
  greeting: { label: 'Edit greeting', focusId: 'bot-greeting' },
  personality: { label: 'Pick personality', focusId: 'bot-greeting' },
  escalation_fallback: { label: 'Set handoff message', focusId: 'bot-fallback' },
  languages: { label: 'Set languages', focusId: 'bot-langs' },
  operating_hours: { label: 'Add hours', href: '/business-info' },
  add_faqs: { label: 'Add FAQs', href: '/business-info' },
  add_policies: { label: 'Add policies', href: '/business-info' },
};

function focusField(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Defer focus until scroll settles so smooth-scroll doesn't pull
  // focus back to the top.
  window.setTimeout(() => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus({ preventScroll: true });
      el.select();
    } else {
      (el as HTMLElement).focus({ preventScroll: true });
    }
  }, 350);
}

function Questionnaire() {
  const list = useQuery({
    queryKey: ['bot-questionnaire'],
    queryFn: () => api.get<{ data: QuestionnaireItem[] }>('/api/v1/bot/questionnaire'),
  });
  const items = list.data?.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>What's missing</CardTitle>
        <CardDescription>Adaptive list — fill these to improve the bot.</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-foreground-muted">Nothing pressing. Looks good!</p>
        ) : (
          <ol className="space-y-2 text-sm">
            {items.map((item) => {
              const action = QUESTION_ACTIONS[item.key];
              return (
                <li
                  key={item.key}
                  className="flex items-start gap-2 rounded-md border border-transparent px-2 py-1.5 hover:border-border hover:bg-surface-muted/40"
                >
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-amber-500" />
                  <div className="min-w-0 flex-1">
                    <p>{item.question}</p>
                    {item.suggested ? (
                      <p className="mt-0.5 text-xs text-foreground-subtle">
                        Suggested: <span className="font-mono">{item.suggested}</span>
                      </p>
                    ) : null}
                  </div>
                  {action ? (
                    action.href ? (
                      <Button asChild size="sm" variant="secondary" className="shrink-0">
                        <Link href={action.href}>{action.label}</Link>
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="shrink-0"
                        onClick={() => action.focusId && focusField(action.focusId)}
                      >
                        {action.label}
                      </Button>
                    )
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Simulator ------------------------------------------------------
function Simulator() {
  const sessionId = useMemo(() => `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, []);
  const [turns, setTurns] = useState<{ role: 'user' | 'assistant'; body: string }[]>([]);
  const [body, setBody] = useState('');
  const scrollerRef = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: (msg: string) =>
      api.post<{ data: { reply: string; usedKbCount: number } }>('/api/v1/bot/simulate', {
        sessionId,
        message: msg,
      }),
    onSuccess: (res, msg) => {
      setTurns((t) => [...t, { role: 'user', body: msg }, { role: 'assistant', body: res.data.reply }]);
      requestAnimationFrame(() => {
        scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' });
      });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'AI not configured'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" /> Live preview
        </CardTitle>
        <CardDescription>
          Talk to your bot as a customer would. Session resets on page refresh.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div
          ref={scrollerRef}
          className="h-72 overflow-y-auto rounded-md border border-border bg-surface-muted/30 p-2"
        >
          {turns.length === 0 ? (
            <p className="py-10 text-center text-xs text-foreground-muted">
              Type something below to begin.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {turns.map((t, i) => (
                <li key={i} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <span
                    className={cn(
                      'inline-block max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2',
                      t.role === 'user'
                        ? 'bg-brand-500 text-on-brand'
                        : 'bg-surface text-foreground border border-border',
                    )}
                  >
                    {t.body}
                  </span>
                </li>
              ))}
              {send.isPending ? (
                <li className="flex justify-start">
                  <span className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground-muted">
                    <Loader2 className="size-3 animate-spin" /> thinking…
                  </span>
                </li>
              ) : null}
            </ul>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = body.trim();
            if (!v) return;
            setBody('');
            send.mutate(v);
          }}
          className="flex gap-2"
        >
          <Input
            placeholder="Ask your bot…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Simulator message"
          />
          <Button type="submit" size="sm" loading={send.isPending} disabled={body.trim().length === 0}>
            <Send className="size-3.5" />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------- Test scenarios -------------------------------------------------
// Operator can override the LLM judge score per row when they disagree
// with the judge's call. The override takes precedence everywhere
// (badge, avg). Set to null to revert to the LLM judge.
function effectiveScore(r: ScenarioRun): number | null {
  return r.overrideScore ?? r.score ?? null;
}

function ScenarioRunner() {
  const qc = useQueryClient();
  const last = useQuery({
    queryKey: ['bot-scenarios-last'],
    queryFn: () => api.get<{ data: ScenarioRun[] }>('/api/v1/bot/scenarios/last'),
    // Keep the prior rows rendered while a refetch (after override / run) is
    // in flight. Without this, the list briefly empties between the optimistic
    // close-the-editor + the refetch returning, which looks like "everything
    // disappeared" for a few hundred ms.
    placeholderData: keepPreviousData,
  });
  const run = useMutation({
    mutationFn: () =>
      api.post<{ data: { runs: ScenarioRun[]; averageScore: number } }>('/api/v1/bot/scenarios/run'),
    onSuccess: (res) => {
      const count = res.data.runs.length;
      toast.success(`Ran ${count} scenario${count === 1 ? '' : 's'} — avg ${res.data.averageScore}/100`);
      qc.invalidateQueries({ queryKey: ['bot-scenarios-last'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'AI not configured'),
  });

  // Regenerate from the current KB — wipes prior AI-generated scenarios +
  // their run history, keeps anything marked `source = manual`. Good to
  // press after re-crawling the website / approving new KB entries.
  const regen = useMutation({
    mutationFn: () =>
      api.post<{ data: { scenarios: { id: string }[] } }>('/api/v1/bot/scenarios/generate'),
    onSuccess: (res) => {
      const n = res.data.scenarios.length;
      toast.success(`Generated ${n} fresh scenario${n === 1 ? '' : 's'} from your knowledge base.`);
      qc.invalidateQueries({ queryKey: ['bot-scenarios-last'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not regenerate'),
  });

  // Wipe ALL scenarios + their runs.
  const deleteAll = useMutation({
    mutationFn: () => api.delete('/api/v1/bot/scenarios'),
    onSuccess: () => {
      toast.success('All scenarios deleted. Press Run all to generate a fresh set.');
      qc.invalidateQueries({ queryKey: ['bot-scenarios-last'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  // Delete a single scenario row + its run history.
  const deleteOne = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/bot/scenarios/${id}`),
    onSuccess: () => {
      toast.success('Scenario deleted.');
      qc.invalidateQueries({ queryKey: ['bot-scenarios-last'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  const override = useMutation({
    mutationFn: (args: { runId: string; overrideScore: number | null; overrideNotes: string | null }) =>
      api.patch(`/api/v1/bot/scenarios/runs/${args.runId}`, {
        overrideScore: args.overrideScore,
        overrideNotes: args.overrideNotes,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-scenarios-last'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Override failed'),
  });

  const rows = last.data?.data ?? [];
  const scored = rows.map(effectiveScore).filter((s): s is number => s != null);
  const avg = scored.length
    ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
    : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Test scenarios</CardTitle>
          <CardDescription>
            Generated from your knowledge base. Each reply is scored 0–100 by an LLM judge — override
            any score if you disagree. Press <span className="font-medium">Generate new tests</span>{' '}
            after you update the knowledge base to refresh the scenarios.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {avg != null ? (
            <Badge variant={avg >= 85 ? 'success' : avg >= 60 ? 'warning' : 'danger'}>
              Avg {avg}
            </Badge>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              if (
                await confirmDialog({
                  title: 'Delete every scenario?',
                  body:
                    'Removes all scenarios (manual + AI) and every run history. The next Run tests click will generate a brand-new set from your current KB.',
                  confirmLabel: 'Delete all',
                  destructive: true,
                })
              ) {
                deleteAll.mutate();
              }
            }}
            loading={deleteAll.isPending}
            disabled={rows.length === 0}
          >
            <Trash2 className="size-4" /> Delete all
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              if (
                await confirmDialog({
                  title: 'Generate new tests from your KB?',
                  body:
                    'Wipes the current AI-generated scenarios and their run history, then drafts a fresh batch from your current knowledge base + catalog. Any scenarios you marked as manual are preserved.',
                  confirmLabel: 'Generate',
                })
              ) {
                regen.mutate();
              }
            }}
            loading={regen.isPending}
          >
            <Sparkles className="size-4" /> Generate new tests
          </Button>
          <Button size="sm" onClick={() => run.mutate()} loading={run.isPending}>
            <Play className="size-4" /> Run tests
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 && last.isSuccess && !last.isFetching ? (
          // Only show the empty state when the query has succeeded AND is
          // not currently re-fetching — otherwise a save-then-invalidate
          // would briefly empty the list between transitions.
          <div className="px-6 py-10 text-center text-sm text-foreground-muted">
            No scenarios yet. Press <span className="font-medium">Run tests</span> — we'll draft them
            from your current knowledge base and grade each reply.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <ScenarioRow
                key={r.id}
                r={r}
                onOverride={(score, notes) => {
                  if (!r.runId) {
                    toast.error('Run this scenario first, then override.');
                    return;
                  }
                  override.mutate({ runId: r.runId, overrideScore: score, overrideNotes: notes });
                }}
                onDelete={() => deleteOne.mutate(r.id)}
                saving={override.isPending}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ScenarioRow({
  r,
  onOverride,
  onDelete,
  saving,
}: {
  r: ScenarioRun;
  onOverride: (score: number | null, notes: string | null) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [score, setScore] = useState<string>(
    r.overrideScore != null ? String(r.overrideScore) : '',
  );
  const [notes, setNotes] = useState<string>(r.overrideNotes ?? '');
  // Re-sync the local form whenever the row changes (after a save / re-run).
  useEffect(() => {
    setScore(r.overrideScore != null ? String(r.overrideScore) : '');
    setNotes(r.overrideNotes ?? '');
  }, [r.id, r.overrideScore, r.overrideNotes]);

  const eff = effectiveScore(r);
  const hasOverride = r.overrideScore != null;

  return (
    <li className="px-6 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium capitalize">{r.key.replace(/_/g, ' ')}</span>
          {r.source === 'manual' ? (
            <Badge variant="muted" className="text-[10px]">
              manual
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {eff != null ? (
            <Badge variant={eff >= 85 ? 'success' : eff >= 60 ? 'warning' : 'danger'}>
              {eff}/100{hasOverride ? ' ✎' : ''}
            </Badge>
          ) : (
            <Badge variant="muted">not run</Badge>
          )}
          {r.runId ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing((v) => !v)}
              aria-expanded={editing}
            >
              {editing ? 'Cancel' : hasOverride ? 'Edit override' : 'Override'}
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            aria-label="Delete this scenario"
            onClick={async () => {
              if (
                await confirmDialog({
                  title: 'Delete this scenario?',
                  body: `"${r.key.replace(/_/g, ' ')}" and its run history will be removed.`,
                  confirmLabel: 'Delete',
                  destructive: true,
                })
              ) {
                onDelete();
              }
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs italic text-foreground-muted">{r.prompt}</p>
      {r.reply ? (
        <p className="mt-1 whitespace-pre-wrap text-xs text-foreground">{r.reply}</p>
      ) : null}
      {r.notes ? (
        <p className="mt-1 text-xs text-foreground-subtle">
          judge: {r.notes}
          {r.ranAt ? <> · {formatRelative(r.ranAt)}</> : null}
        </p>
      ) : null}
      {r.overrideScore != null && r.overrideNotes ? (
        <p className="mt-1 text-xs text-brand-700">
          your override: {r.overrideNotes}
        </p>
      ) : null}
      {editing ? (
        <div className="mt-2 space-y-2 rounded-md border border-border bg-surface-muted/40 p-3">
          <div className="grid grid-cols-[6rem_1fr] items-center gap-2">
            <Label htmlFor={`score-${r.id}`} className="text-xs">
              Your score
            </Label>
            <Input
              id={`score-${r.id}`}
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              placeholder="0–100"
              value={score}
              onChange={(e) => setScore(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`notes-${r.id}`} className="text-xs">
              Your notes (optional)
            </Label>
            <Textarea
              id={`notes-${r.id}`}
              rows={2}
              placeholder="Why this score?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-end gap-1.5">
            {hasOverride ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onOverride(null, null);
                  setEditing(false);
                }}
                disabled={saving}
              >
                Clear override
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => {
                const n = Number(score);
                if (!Number.isInteger(n) || n < 0 || n > 100) {
                  toast.error('Score must be an integer between 0 and 100.');
                  return;
                }
                onOverride(n, notes.trim() || null);
                setEditing(false);
              }}
              loading={saving}
            >
              Save override
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

// ---------- Voice reply (Google Cloud TTS) -------------------------------
// Lets operators flip the bot from text replies to spoken voice notes.
// "match_customer" is the safe default — speaks when the customer's last
// inbound was itself a voice note, types when they type. Voice ID is
// optional; when blank, the API falls back to env-configured defaults.
const VOICE_OPTIONS: { id: string; label: string; lang: string }[] = [
  { id: 'en-US-Neural2-J', label: 'English (US) · Male · Neural2-J', lang: 'en' },
  { id: 'en-US-Neural2-F', label: 'English (US) · Female · Neural2-F', lang: 'en' },
  { id: 'en-US-Neural2-D', label: 'English (US) · Male · Neural2-D', lang: 'en' },
  { id: 'en-GB-Neural2-A', label: 'English (UK) · Female · Neural2-A', lang: 'en' },
  { id: 'en-GB-Neural2-B', label: 'English (UK) · Male · Neural2-B', lang: 'en' },
  { id: 'ar-XA-Wavenet-B', label: 'Arabic (Standard) · Male · WaveNet-B', lang: 'ar' },
  { id: 'ar-XA-Wavenet-A', label: 'Arabic (Standard) · Female · WaveNet-A', lang: 'ar' },
  { id: 'ar-XA-Wavenet-C', label: 'Arabic (Standard) · Male · WaveNet-C', lang: 'ar' },
];

function VoiceReplyCard({ config }: { config: BotConfig | null }) {
  const qc = useQueryClient();
  const [replyMode, setReplyMode] = useState<'text' | 'voice' | 'match_customer'>(
    config?.replyMode ?? 'text',
  );
  const [ttsProvider, setTtsProvider] = useState<'google' | 'elevenlabs'>(
    config?.ttsProvider ?? 'google',
  );
  const [voiceName, setVoiceName] = useState<string>(config?.ttsVoiceName ?? '');

  useEffect(() => {
    if (!config) return;
    setReplyMode(config.replyMode ?? 'text');
    setTtsProvider(config.ttsProvider ?? 'google');
    setVoiceName(config.ttsVoiceName ?? '');
  }, [config]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/bot/config', {
        replyMode,
        ttsProvider,
        ttsVoiceName: voiceName || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-config'] });
      toast.success('Voice reply preferences saved');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Save failed'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice replies</CardTitle>
        <CardDescription>
          Speak the bot&apos;s answers as WhatsApp voice notes instead of plain text. Pick your TTS
          provider below — Google&apos;s free tier covers ~5,000 replies/month; ElevenLabs uses
          characters from your existing plan.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-foreground-subtle">
            When the bot replies
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(
              [
                {
                  v: 'text',
                  label: 'Always text',
                  hint: 'Default. No TTS calls. No extra cost.',
                },
                {
                  v: 'match_customer',
                  label: 'Match the customer',
                  hint: 'Voice if they sent a voice note. Text if they typed.',
                },
                {
                  v: 'voice',
                  label: 'Always voice',
                  hint: 'Every reply spoken. Heavier on TTS quota.',
                },
              ] as const
            ).map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setReplyMode(opt.v)}
                className={`rounded-lg border p-3 text-left transition ${
                  replyMode === opt.v
                    ? 'border-brand-500 bg-brand-50/60 dark:bg-brand-500/10'
                    : 'border-border bg-surface hover:bg-surface-muted'
                }`}
              >
                <div className="text-sm font-semibold">{opt.label}</div>
                <div className="mt-1 text-xs text-foreground-muted">{opt.hint}</div>
              </button>
            ))}
          </div>
        </div>

        {replyMode !== 'text' ? (
          <>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-foreground-subtle">
                Voice provider
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(
                  [
                    {
                      v: 'google' as const,
                      label: 'Google Cloud TTS',
                      hint: 'Standard + Neural2 voices. Free tier ~5k replies/month.',
                    },
                    {
                      v: 'elevenlabs' as const,
                      label: 'ElevenLabs',
                      hint: 'Use a voice you cloned or picked on your ElevenLabs plan.',
                    },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => {
                      setTtsProvider(opt.v);
                      // Different providers use different voice
                      // identifiers (Google names vs ElevenLabs IDs).
                      // Clear the field so the user re-picks for the
                      // new provider — env defaults kick in otherwise.
                      setVoiceName('');
                    }}
                    className={`rounded-lg border p-3 text-left transition ${
                      ttsProvider === opt.v
                        ? 'border-brand-500 bg-brand-50/60 dark:bg-brand-500/10'
                        : 'border-border bg-surface hover:bg-surface-muted'
                    }`}
                  >
                    <div className="text-sm font-semibold">{opt.label}</div>
                    <div className="mt-1 text-xs text-foreground-muted">{opt.hint}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="bot-voice" className="text-xs font-medium text-foreground-muted">
                Voice
              </label>
              {ttsProvider === 'google' ? (
                <select
                  id="bot-voice"
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                >
                  <option value="">— Use default for the bot&apos;s reply language —</option>
                  {VOICE_OPTIONS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="bot-voice"
                  type="text"
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value)}
                  placeholder="ElevenLabs voice ID (e.g. 21m00Tcm4TlvDq8ikWAM) — leave blank to use the env default"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs"
                />
              )}
              <p className="text-[11px] text-foreground-subtle">
                {ttsProvider === 'google' ? (
                  <>
                    Preview voices at{' '}
                    <a
                      href="https://cloud.google.com/text-to-speech"
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      cloud.google.com/text-to-speech
                    </a>
                    .
                  </>
                ) : (
                  <>
                    Find voice IDs at{' '}
                    <a
                      href="https://elevenlabs.io/app/voice-lab"
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      elevenlabs.io/app/voice-lab
                    </a>
                    .
                  </>
                )}
              </p>
            </div>
          </>
        ) : null}

        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save voice preferences
        </Button>
      </CardContent>
    </Card>
  );
}
