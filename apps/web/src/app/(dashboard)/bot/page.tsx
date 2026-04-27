'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Globe,
  Loader2,
  Play,
  PowerOff,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

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
import { cn } from '@/lib/utils';

interface BotConfig {
  id: string;
  personality: string | null;
  customPersonality: string | null;
  detectedTone: string | null;
  greeting: string | null;
  languages: string;
  escalationRules: Record<string, unknown> | null;
  conversationFlow: Record<string, unknown> | null;
  responseTemplates: Record<string, unknown> | null;
  deployedAt: string | null;
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

interface KbEntry {
  id: string;
  kind: string;
  question: string;
  answer: string;
  sourceUrl: string | null;
  sourceType: string;
  approved: boolean;
  createdAt: string;
  updatedAt: string;
}

interface QuestionnaireItem {
  key: string;
  question: string;
  suggested?: string;
}

interface ScenarioRun {
  key: string;
  prompt: string;
  reply: string | null;
  score: number | null;
  notes: string | null;
  ranAt: string | null;
}

const PERSONALITIES = [
  { key: 'friendly', label: 'Friendly', desc: 'Warm and helpful, light emoji' },
  { key: 'casual', label: 'Casual', desc: 'Conversational, contractions OK' },
  { key: 'formal', label: 'Formal', desc: 'Professional, no contractions' },
  { key: 'clinical', label: 'Clinical', desc: 'Concise, factual, list-driven' },
  { key: 'professional', label: 'Professional', desc: 'Polite and direct' },
];

export default function BotPage() {
  const qc = useQueryClient();

  const configQ = useQuery({
    queryKey: ['bot-config'],
    queryFn: () => api.get<{ data: BotConfig }>('/api/v1/bot/config'),
  });
  const config = configQ.data?.data ?? null;

  return (
    <>
      <PageHeader
        title="AI bot builder"
        description="Crawl your site, review the auto-generated knowledge base, set personality + greeting, simulate, deploy."
        actions={
          config ? (
            <DeployToggle
              config={config}
              onChanged={() => qc.invalidateQueries({ queryKey: ['bot-config'] })}
            />
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <AnalyzeCard />
          <KnowledgeBaseCard />
          <PersonalityCard config={config} />
          <FlowAndTemplatesCard config={config} />
          <ScenarioRunner />
        </div>
        <div className="space-y-6">
          <Questionnaire />
          <Simulator />
        </div>
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
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      api.post<{ data: CrawlJob }>('/api/v1/bot/analyze', { rootUrl: url, maxPages: 30, maxDepth: 2 }),
    onSuccess: (res) => {
      toast.success('Crawl started');
      setActiveJobId(res.data.id);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Failed'),
  });

  const status = useQuery({
    queryKey: ['bot-analyze', activeJobId],
    queryFn: () => api.get<{ data: CrawlJob }>(`/api/v1/bot/analyze/${activeJobId}`),
    enabled: !!activeJobId,
    refetchInterval: (q) => {
      const s = q.state.data?.data.status;
      return s === 'pending' || s === 'running' ? 2000 : false;
    },
  });

  const job = status.data?.data;
  const done =
    job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'partial');

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
          The crawler walks up to 30 pages of your public site, then Claude turns the content into a
          knowledge base + suggests a tone preset. Up to a few minutes.
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
            </div>
            {job.errorMessage ? (
              <p className="mt-1 text-xs text-amber-700">{job.errorMessage}</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------- Knowledge base -------------------------------------------------
function KnowledgeBaseCard() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['bot-kb'],
    queryFn: () => api.get<{ data: KbEntry[] }>('/api/v1/bot/knowledge-base'),
  });

  const approveAll = useMutation({
    mutationFn: () => api.post('/api/v1/bot/knowledge-base/approve-all'),
    onSuccess: () => {
      toast.success('All AI entries approved');
      qc.invalidateQueries({ queryKey: ['bot-kb'] });
    },
  });

  const rows = list.data?.data ?? [];
  const pending = rows.filter((r) => !r.approved);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Knowledge base</CardTitle>
          <CardDescription>
            What the bot answers from. AI entries start unapproved — review them, then approve or
            edit before deploy.
          </CardDescription>
        </div>
        {pending.length > 0 ? (
          <Button
            size="sm"
            variant="secondary"
            loading={approveAll.isPending}
            onClick={() => approveAll.mutate()}
          >
            <CheckCircle2 className="size-4" /> Approve all ({pending.length})
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        {list.isLoading ? (
          <p className="px-6 py-6 text-center text-sm text-foreground-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-6 py-6 text-center text-sm text-foreground-muted">
            No entries yet. Run an analysis above, or add entries manually.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.slice(0, 50).map((e) => (
              <KbRow key={e.id} entry={e} />
            ))}
            {rows.length > 50 ? (
              <li className="px-6 py-2 text-xs text-foreground-subtle">
                Showing first 50 of {rows.length}.
              </li>
            ) : null}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function KbRow({ entry }: { entry: KbEntry }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState(entry.question);
  const [a, setA] = useState(entry.answer);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/v1/bot/knowledge-base/${entry.id}`, { question: q, answer: a, approved: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-kb'] });
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/v1/bot/knowledge-base/${entry.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bot-kb'] }),
  });
  const approve = useMutation({
    mutationFn: () => api.patch(`/api/v1/bot/knowledge-base/${entry.id}`, { approved: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bot-kb'] }),
  });

  if (editing) {
    return (
      <li className="space-y-2 px-6 py-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} />
        <Textarea rows={3} value={a} onChange={(e) => setA(e.target.value)} />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>
            Save + approve
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-start justify-between gap-3 px-6 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge variant="muted" className="text-[10px]">
            {entry.kind}
          </Badge>
          <Badge
            variant={entry.approved ? 'success' : entry.sourceType === 'ai' ? 'warning' : 'default'}
            className="text-[10px]"
          >
            {entry.approved ? 'approved' : entry.sourceType === 'ai' ? 'ai · review' : 'manual'}
          </Badge>
          {entry.sourceUrl ? (
            <a
              href={entry.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[10px] text-brand-500 underline truncate max-w-[200px]"
            >
              source
            </a>
          ) : null}
        </div>
        <p className="mt-1 truncate text-sm font-medium">{entry.question}</p>
        <p className="mt-0.5 truncate text-xs text-foreground-muted">{entry.answer}</p>
      </div>
      <div className="flex items-center gap-1">
        {!entry.approved ? (
          <Button size="sm" variant="ghost" onClick={() => approve.mutate()} loading={approve.isPending}>
            <CheckCircle2 className="size-4 text-emerald-600" />
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit">
          <RefreshCw className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Delete"
          onClick={async () => {
            if (await confirmDialog({ title: 'Delete this entry?', destructive: true, confirmLabel: 'Delete' })) {
              remove.mutate();
            }
          }}
        >
          <Trash2 className="size-4 text-red-600" />
        </Button>
      </div>
    </li>
  );
}

// ---------- Personality + greeting -----------------------------------------
function PersonalityCard({ config }: { config: BotConfig | null }) {
  const qc = useQueryClient();
  const [personality, setPersonality] = useState<string>(config?.personality ?? 'friendly');
  const [greeting, setGreeting] = useState<string>(config?.greeting ?? '');
  const [languages, setLanguages] = useState<string>(config?.languages ?? 'en');
  const [fallback, setFallback] = useState<string>(
    (config?.escalationRules as Record<string, string> | null)?.fallback ?? '',
  );

  useEffect(() => {
    if (!config) return;
    setPersonality(config.personality ?? config.detectedTone ?? 'friendly');
    setGreeting(config.greeting ?? '');
    setLanguages(config.languages ?? 'en');
    setFallback((config.escalationRules as Record<string, string> | null)?.fallback ?? '');
  }, [config]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/bot/config', {
        personality,
        greeting,
        languages,
        escalationRules: fallback ? { fallback } : null,
      }),
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['bot-config'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

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
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="bot-langs">Languages (comma-sep)</Label>
            <Input id="bot-langs" value={languages} onChange={(e) => setLanguages(e.target.value)} />
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

// ---------- Flow + templates -----------------------------------------------
const FLOW_INTENTS = ['greeting', 'product_inquiry', 'booking', 'support', 'escalation'];

function FlowAndTemplatesCard({ config }: { config: BotConfig | null }) {
  const qc = useQueryClient();
  const [flow, setFlow] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!config) return;
    const f = (config.conversationFlow ?? {}) as Record<string, string>;
    setFlow(f);
  }, [config]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/bot/config', {
        conversationFlow: flow,
        responseTemplates: flow, // keep them aligned for v1
      }),
    onSuccess: () => {
      toast.success('Flow + templates saved');
      qc.invalidateQueries({ queryKey: ['bot-config'] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversation flow + templates</CardTitle>
        <CardDescription>
          One-line guidance per canonical intent. Drag-and-drop graph editor coming later — this
          form covers the same five paths the bot needs to handle.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {FLOW_INTENTS.map((intent) => (
          <div key={intent} className="space-y-1.5">
            <Label htmlFor={`flow-${intent}`} className="capitalize">
              {intent.replace(/_/g, ' ')}
            </Label>
            <Textarea
              id={`flow-${intent}`}
              rows={2}
              placeholder={
                intent === 'escalation'
                  ? 'When asked, escalate to a human via the inbox.'
                  : `Sample reply / guidance for ${intent.replace(/_/g, ' ')}…`
              }
              value={flow[intent] ?? ''}
              onChange={(e) => setFlow((f) => ({ ...f, [intent]: e.target.value }))}
            />
          </div>
        ))}
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save flow
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------- Questionnaire --------------------------------------------------
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
            {items.map((item) => (
              <li key={item.key} className="flex items-start gap-2">
                <span className="mt-1 size-1.5 shrink-0 rounded-full bg-amber-500" />
                <div>
                  <p>{item.question}</p>
                  {item.suggested ? (
                    <p className="mt-0.5 text-xs text-foreground-subtle">
                      Suggested: <span className="font-mono">{item.suggested}</span>
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
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
                        ? 'bg-brand-500 text-white'
                        : 'bg-white text-foreground border border-border',
                    )}
                  >
                    {t.body}
                  </span>
                </li>
              ))}
              {send.isPending ? (
                <li className="flex justify-start">
                  <span className="inline-flex items-center gap-1 rounded-lg border border-border bg-white px-3 py-2 text-xs text-foreground-muted">
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
function ScenarioRunner() {
  const qc = useQueryClient();
  const last = useQuery({
    queryKey: ['bot-scenarios-last'],
    queryFn: () => api.get<{ data: ScenarioRun[] }>('/api/v1/bot/scenarios/last'),
  });
  const run = useMutation({
    mutationFn: () =>
      api.post<{ data: { runs: ScenarioRun[]; averageScore: number } }>('/api/v1/bot/scenarios/run'),
    onSuccess: (res) => {
      toast.success(`Avg score: ${res.data.averageScore}/100`);
      qc.invalidateQueries({ queryKey: ['bot-scenarios-last'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'AI not configured'),
  });

  const rows = last.data?.data ?? [];
  const avg = rows.length
    ? Math.round(
        rows.filter((r) => r.score != null).reduce((a, b) => a + (b.score ?? 0), 0) /
          Math.max(1, rows.filter((r) => r.score != null).length),
      )
    : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Test scenarios</CardTitle>
          <CardDescription>
            Five canned customer queries. Each reply is scored 0–100 by an LLM judge.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {avg != null ? (
            <Badge variant={avg >= 85 ? 'success' : avg >= 60 ? 'warning' : 'danger'}>
              Avg {avg}
            </Badge>
          ) : null}
          <Button size="sm" onClick={() => run.mutate()} loading={run.isPending}>
            <Play className="size-4" /> Run all
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.key} className="px-6 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium capitalize">{r.key.replace(/_/g, ' ')}</span>
                {r.score != null ? (
                  <Badge variant={r.score >= 85 ? 'success' : r.score >= 60 ? 'warning' : 'danger'}>
                    {r.score}/100
                  </Badge>
                ) : (
                  <Badge variant="muted">not run</Badge>
                )}
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
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
