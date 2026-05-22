'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  Inbox,
  MessageCircle,
  Paperclip,
  Phone,
  Send,
  Sparkles,
  Mic,
  StickyNote,
  Tag as TagIcon,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

type ThreadStatus = 'open' | 'pending' | 'resolved' | 'escalated';

// Minimal shape we use from the dynamically-imported opus-recorder
// package. The library doesn't ship TS types of its own, so we keep
// this shim local rather than pulling in a separate @types package.
interface OpusRecorderLike {
  start: () => Promise<void>;
  stop: () => Promise<void> | void;
  ondataavailable?: (data: Uint8Array) => void;
  onstop?: () => void;
  onerror?: (err: unknown) => void;
}
interface OpusRecorderOptions {
  encoderPath: string;
  streamPages?: boolean;
  encoderApplication?: number;
  encoderSampleRate?: number;
  numberOfChannels?: number;
}
type OpusRecorderCtor = new (opts: OpusRecorderOptions) => OpusRecorderLike;

interface Thread {
  id: string;
  customerPhone: string;
  customerName: string | null;
  // Read-only mirror of the customer's WhatsApp profile name from Meta.
  customerWhatsappName: string | null;
  status: ThreadStatus;
  assignedToUserId: string | null;
  assignedToName: string | null;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  inboundCount: number;
  outboundCount: number;
  tags: string[];
  noteCount: number;
  // Phase 6 — per-thread bot reply-mode override. null = inherit BotConfig.
  botReplyMode: 'text' | 'voice' | 'match_customer' | null;
  createdAt: string;
}

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  metaMessageId: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  messageType: string | null;
  body: string | null;
  receivedAt: string;
  sentBy: 'bot' | 'operator' | null;
  // Phase 8 / 1.5 — for image-type bot messages, the upstream source.
  // Either the greeting image set on /bot, or a product image by SKU.
  imageSource: { kind: 'greeting' | 'product'; productSku: string | null } | null;
}

// Phase 8 / 1.3 — shape returned by GET /inbox/messages/:id/provenance.
// Only ALIGNED admins ever fetch this.
interface MessageProvenance {
  messageId: string;
  organizationId: string;
  systemPrompt: { sha256: string; body: string };
  userPrompt: string;
  historyJson: { role: 'user' | 'assistant'; content: string }[];
  candidates: {
    products: { id: string; name: string; sku: string; priceMinor: number | null; currency: string | null }[];
    services: { id: string; name: string; basePriceMinor: number | null; currency: string | null }[];
    faqs: { id: string; question: string; answer: string }[];
    policyKinds: string[];
    businessInfoFields: string[];
  };
  citations:
    | {
        type:
          | 'product'
          | 'service'
          | 'faq'
          | 'policy'
          | 'business_info'
          | 'bot_config';
        id: string | null;
        label: string;
        snippet: string;
        confidence: number;
        meta?: Record<string, unknown> | null;
      }[]
    | null;
  hallucinations:
    | {
        type: 'unknown_product' | 'price_drift' | 'unknown_business_info';
        matchedText: string;
        context: string;
        severity: 'critical' | 'warning';
        reason: string;
      }[]
    | null;
  model: string;
  temperature: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  createdAt: string;
}

interface Note {
  id: string;
  authorUserId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  body: string;
  createdAt: string;
}

interface CannedResponse {
  id: string;
  shortcut: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

const STATUS_LABEL: Record<ThreadStatus, string> = {
  open: 'Open',
  pending: 'Pending',
  resolved: 'Resolved',
  escalated: 'Escalated',
};

const STATUS_VARIANT: Record<ThreadStatus, 'default' | 'success' | 'warning' | 'danger' | 'muted'> = {
  open: 'default',
  pending: 'warning',
  resolved: 'success',
  escalated: 'danger',
};

export default function InboxPage() {
  const queryClient = useQueryClient();
  const { session } = useSession();
  // Honour ?thread=<uuid> on initial mount so /aligned-admin/provenance's
  // "View thread →" link lands the operator on the right conversation.
  // SearchParams is read once at mount; subsequent thread clicks just
  // update `activeId` without touching the URL.
  const searchParams = useSearchParams();
  const initialThreadId = searchParams?.get('thread') ?? null;
  const [activeId, setActiveId] = useState<string | null>(initialThreadId);
  const [filterQ, setFilterQ] = useState('');
  const [filterStatus, setFilterStatus] = useState<ThreadStatus | 'all'>('all');
  const [filterTag, setFilterTag] = useState('');

  const params = new URLSearchParams();
  if (filterQ.trim()) params.set('q', filterQ.trim());
  if (filterStatus !== 'all') params.set('status', filterStatus);
  if (filterTag.trim()) params.set('tag', filterTag.trim());

  const threadsQ = useQuery({
    queryKey: ['inbox-threads', filterQ, filterStatus, filterTag],
    queryFn: () => api.get<{ data: Thread[] }>(`/api/v1/inbox/threads?${params.toString()}`),
    // 30 s background poll as a fallback. The SSE hook below invalidates
    // on every server tick so the perceived freshness is sub-2s.
    refetchInterval: 30_000,
  });

  // Phase 8 / 1.3 — per-thread hallucination counts for the red-dot.
  // Only fetched for ALIGNED admins. One round-trip across all threads.
  const isAdmin = session?.user.isAlignedAdmin === true;
  const flaggedQ = useQuery({
    queryKey: ['inbox-flagged-summary'],
    queryFn: () =>
      api.get<{ data: { threadId: string; flaggedCount: number }[] }>(
        '/api/v1/inbox/threads/flagged-summary',
      ),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });
  const flaggedByThread = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of flaggedQ.data?.data ?? []) m.set(r.threadId, r.flaggedCount);
    return m;
  }, [flaggedQ.data]);

  // SSE realtime: every 2s tick from the server invalidates the thread
  // queries so they refetch. Cheap for the server (one timer per
  // connected client, no per-event fan-out yet) and works fine through
  // Caddy's HTTP/2 reverse proxy.
  useInboxSSE();

  const threads = threadsQ.data?.data ?? [];
  const active = threads.find((t) => t.id === activeId) ?? null;

  // Auto-select first thread when none is selected and threads load.
  useEffect(() => {
    if (!activeId && threads.length > 0) setActiveId(threads[0]!.id);
  }, [activeId, threads]);

  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-0 flex-col">
      <PageHeader
        title="Inbox"
        description="Every WhatsApp conversation. Status, tags, assignment, internal notes — all here."
        actions={
          <Badge variant="muted" className="gap-1">
            <MessageCircle className="size-3" /> {threads.length} thread{threads.length === 1 ? '' : 's'}
          </Badge>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden rounded-lg border border-border bg-surface lg:grid-cols-[22rem_1fr]">
        <div className="flex min-h-0 flex-col border-r border-border">
          {/* Filters pinned to the top of the thread-list column so the
              conversation pane on the right gets the full vertical space. */}
          <div className="grid shrink-0 grid-cols-1 gap-2 border-b border-border bg-surface-muted/40 px-3 py-2">
            <Input
              placeholder="Search by phone, name, or message…"
              value={filterQ}
              onChange={(e) => setFilterQ(e.target.value)}
              aria-label="Search conversations"
              className="h-8 text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as ThreadStatus | 'all')}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="escalated">Escalated</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Tag…"
                value={filterTag}
                onChange={(e) => setFilterTag(e.target.value)}
                aria-label="Filter by tag"
                className="h-8 text-sm"
              />
            </div>
          </div>
          <ThreadList
            threads={threads}
            activeId={activeId}
            onSelect={setActiveId}
            loading={threadsQ.isLoading}
            flaggedByThread={flaggedByThread}
          />
        </div>
        <ThreadView
          thread={active}
          onChanged={() => {
            queryClient.invalidateQueries({ queryKey: ['inbox-threads'] });
            if (active) queryClient.invalidateQueries({ queryKey: ['inbox-thread', active.id] });
            // Inbox-counts drives the red Inbox badge in the sidebar.
            // Any thread change (status flip, assign, tag, etc.) can
            // shift the counts so we invalidate eagerly — the actual
            // refetch is gated by staleTime on the sidebar query.
            queryClient.invalidateQueries({ queryKey: ['sidebar-inbox-counts'] });
          }}
          currentUserId={session?.user.id ?? null}
        />
      </div>
    </div>
  );
}

function ThreadList({
  threads,
  activeId,
  onSelect,
  loading,
  flaggedByThread,
}: {
  threads: Thread[];
  activeId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  // Phase 8 / 1.3 — ALIGNED-admin only: map of threadId → hallucination
  // count. Renders a red dot on flagged threads. Empty map when the user
  // isn't an admin (the parent never fetches the summary).
  flaggedByThread: Map<string, number>;
}) {
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversations">
      {loading ? (
        <li className="px-4 py-6 text-center text-sm text-foreground-muted">Loading…</li>
      ) : threads.length === 0 ? (
        <li>
          <EmptyState
            icon={Inbox}
            title="No conversations"
            description="Inbound WhatsApp messages will land here once Meta starts posting."
          />
        </li>
      ) : (
        threads.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onSelect(t.id)}
              aria-current={activeId === t.id}
              className={cn(
                'flex w-full flex-col gap-1 border-b border-l-4 border-border border-l-transparent px-3 py-3 text-left text-sm hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400',
                // Bot-flagged "needs human" threads get a tinted background +
                // a red left bar so operators can spot them at a glance.
                t.status === 'escalated' &&
                  'border-l-red-500 bg-red-50/60 hover:bg-red-50/80',
                activeId === t.id && t.status !== 'escalated' && 'bg-brand-50/50',
                activeId === t.id && t.status === 'escalated' && 'bg-red-100/70',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 truncate font-mono text-xs">
                  <Phone className="size-3.5 shrink-0 text-foreground-muted" />
                  {t.customerName ?? t.customerPhone}
                  {/* ALIGNED-admin only — red dot indicating ≥1 bot reply
                      on this thread has hallucinations flagged. */}
                  {(flaggedByThread.get(t.id) ?? 0) > 0 ? (
                    <span
                      className="ml-0.5 inline-flex h-2 w-2 shrink-0 rounded-full bg-rose-500"
                      title={`${flaggedByThread.get(t.id)} flagged bot reply${(flaggedByThread.get(t.id) ?? 0) > 1 ? 'ies' : ''}`}
                    />
                  ) : null}
                </span>
                <span className="whitespace-nowrap text-[10px] text-foreground-subtle">
                  {formatRelative(t.lastMessageAt)}
                </span>
              </div>
              <p className="truncate text-xs text-foreground">
                {t.lastMessagePreview ?? <em className="text-foreground-subtle">no preview</em>}
              </p>
              <div className="flex flex-wrap items-center gap-1">
                <Badge variant={STATUS_VARIANT[t.status]} className="text-[10px]">
                  {STATUS_LABEL[t.status]}
                </Badge>
                {t.assignedToName ? (
                  <Badge variant="muted" className="text-[10px]">
                    @{t.assignedToName.split(' ')[0]}
                  </Badge>
                ) : null}
                {t.noteCount > 0 ? (
                  <Badge variant="muted" className="gap-1 text-[10px]">
                    <StickyNote className="size-3" /> {t.noteCount}
                  </Badge>
                ) : null}
                {t.tags.slice(0, 2).map((tag) => (
                  <Badge key={tag} variant="outline" className="text-[10px]">
                    {tag}
                  </Badge>
                ))}
                {t.tags.length > 2 ? (
                  <span className="text-[10px] text-foreground-subtle">+{t.tags.length - 2}</span>
                ) : null}
              </div>
              <div className="text-[10px] text-foreground-subtle">
                {t.inboundCount} in · {t.outboundCount} out
              </div>
            </button>
          </li>
        ))
      )}
    </ul>
  );
}

function ThreadView({
  thread,
  onChanged,
  currentUserId,
}: {
  thread: Thread | null;
  onChanged: () => void;
  currentUserId: string | null;
}) {
  const queryClient = useQueryClient();
  // Phase 8 / 1.3 — only ALIGNED admins see the AI provenance affordance
  // on bot bubbles. Regular org users get a clean chat surface.
  const { session } = useSession();
  const isAlignedAdmin = session?.user.isAlignedAdmin === true;

  // Whether the AI bot is deployed at the org level. This + an
  // unassigned thread are the two preconditions for auto-reply; the
  // inbox surfaces both so the operator knows why a thread is or
  // isn't getting bot answers.
  const botCfg = useQuery({
    queryKey: ['bot-config-deployment'],
    queryFn: () =>
      api.get<{ data: { deployedAt: string | null } }>('/api/v1/bot/config'),
    staleTime: 30_000,
  });
  const botDeployed = !!botCfg.data?.data?.deployedAt;

  const messagesQ = useQuery({
    queryKey: ['inbox-thread', thread?.id, 'messages'],
    queryFn: () =>
      thread
        ? api.get<{ data: Message[] }>(`/api/v1/inbox/threads/${thread.id}/messages`)
        : Promise.resolve({ data: [] as Message[] }),
    enabled: !!thread,
    refetchInterval: 5_000,
  });

  const notesQ = useQuery({
    queryKey: ['inbox-thread', thread?.id, 'notes'],
    queryFn: () =>
      thread
        ? api.get<{ data: Note[] }>(`/api/v1/inbox/threads/${thread.id}/notes`)
        : Promise.resolve({ data: [] as Note[] }),
    enabled: !!thread,
    refetchInterval: 10_000,
  });

  const cannedQ = useQuery({
    queryKey: ['canned-responses'],
    queryFn: () => api.get<{ data: CannedResponse[] }>('/api/v1/canned-responses'),
  });

  const sendReply = useMutation({
    mutationFn: ({ to, body }: { to: string; body: string }) =>
      api.post<{ data: { ok: boolean; errorMessage: string | null } }>('/api/v1/whatsapp/send', { to, body }),
    onSuccess: (res) => {
      if (res.data.ok) {
        toast.success('Reply sent');
        if (thread) {
          queryClient.invalidateQueries({ queryKey: ['inbox-thread', thread.id, 'messages'] });
          onChanged();
        }
      } else {
        toast.error(res.data.errorMessage ?? 'Send failed');
      }
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Send failed'),
  });

  const addNote = useMutation({
    mutationFn: (body: string) =>
      thread
        ? api.post(`/api/v1/inbox/threads/${thread.id}/notes`, { body })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Note added');
      if (thread) queryClient.invalidateQueries({ queryKey: ['inbox-thread', thread.id, 'notes'] });
      onChanged();
    },
  });

  const setStatus = useMutation({
    mutationFn: (status: ThreadStatus) =>
      thread
        ? api.patch(`/api/v1/inbox/threads/${thread.id}`, { status })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => onChanged(),
  });

  const setAssignee = useMutation({
    mutationFn: (assignedToUserId: string | null) =>
      thread
        ? api.patch(`/api/v1/inbox/threads/${thread.id}`, { assignedToUserId })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Assigned');
      onChanged();
    },
  });

  // Phase 6 — per-thread bot reply-mode override. NULL clears the
  // override and inherits BotConfig.replyMode again.
  const setBotReplyMode = useMutation({
    mutationFn: (botReplyMode: 'text' | 'voice' | 'match_customer' | null) =>
      thread
        ? api.patch(`/api/v1/inbox/threads/${thread.id}`, { botReplyMode })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Bot reply mode updated');
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Update failed'),
  });

  // Rename the customer's display name. Backend mirrors the change to
  // Contact.displayName so /contacts stays in sync automatically.
  const renameContact = useMutation({
    mutationFn: (customerName: string | null) =>
      thread
        ? api.patch(`/api/v1/inbox/threads/${thread.id}`, { customerName })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Saved');
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Rename failed'),
  });

  const addTag = useMutation({
    mutationFn: (tag: string) =>
      thread
        ? api.post(`/api/v1/inbox/threads/${thread.id}/tags`, { tag })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => onChanged(),
  });

  const removeTag = useMutation({
    mutationFn: (tag: string) =>
      thread
        ? api.delete(`/api/v1/inbox/threads/${thread.id}/tags/${encodeURIComponent(tag)}`)
        : Promise.reject(new Error('no thread')),
    onSuccess: () => onChanged(),
  });

  const handoff = useMutation({
    mutationFn: () =>
      thread
        ? api.post(`/api/v1/inbox/threads/${thread.id}/handoff`, {})
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Handed off — status set to Pending');
      onChanged();
    },
  });

  // IMPORTANT: hooks must be called in the same order every render. The
  // early `return` for the null-thread case must come AFTER every hook
  // call in this component, otherwise the moment a thread arrives the
  // render count of hooks changes and React throws #310 "Rendered more
  // hooks than during the previous render."
  const messages = messagesQ.data?.data ?? [];
  const notes = notesQ.data?.data ?? [];
  // Interleave messages + notes by time.
  const timeline = useMemo(() => {
    const items = [
      ...messages.map((m) => ({ kind: 'msg' as const, at: m.receivedAt, msg: m })),
      ...notes.map((n) => ({ kind: 'note' as const, at: n.createdAt, note: n })),
    ];
    items.sort((a, b) => (a.at < b.at ? -1 : 1));
    return items;
  }, [messages, notes]);

  if (!thread) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-foreground-muted">
        Select a conversation to view it.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ThreadHeader
        thread={thread}
        onStatusChange={(s) => setStatus.mutate(s)}
        onAssignSelf={() => currentUserId && setAssignee.mutate(currentUserId)}
        onUnassign={() => setAssignee.mutate(null)}
        onHandoff={() => handoff.mutate()}
        onRename={(name) => renameContact.mutate(name)}
        renameSaving={renameContact.isPending}
        onBotReplyModeChange={(m) => setBotReplyMode.mutate(m)}
      />
      <TagBar thread={thread} onAdd={(t) => addTag.mutate(t)} onRemove={(t) => removeTag.mutate(t)} />
      <AiStatusBanner thread={thread} botDeployed={botDeployed} />
      <MessageScroller
        threadId={thread.id}
        timelineLength={timeline.length}
        latestTimestamp={
          timeline.length > 0 ? timeline[timeline.length - 1]!.at : null
        }
      >
        {messagesQ.isLoading ? (
          <p className="text-center text-sm text-foreground-muted">Loading…</p>
        ) : timeline.length === 0 ? (
          <p className="text-center text-sm text-foreground-muted">No messages yet.</p>
        ) : (
          timeline.map((item) =>
            item.kind === 'msg' ? (
              <Bubble
                key={item.msg.id}
                message={item.msg}
                isAlignedAdmin={isAlignedAdmin}
              />
            ) : (
              <NoteBubble key={item.note.id} note={item.note} />
            ),
          )
        )}
      </MessageScroller>
      <div className="shrink-0">
        <ReplyBox
          to={thread.customerPhone}
          cannedResponses={cannedQ.data?.data ?? []}
          loading={sendReply.isPending}
          onSend={(body) => sendReply.mutate({ to: thread.customerPhone, body })}
          onAddNote={(body) => addNote.mutate(body)}
          addingNote={addNote.isPending}
        />
      </div>
    </div>
  );
}

function ThreadHeader({
  thread,
  onStatusChange,
  onAssignSelf,
  onUnassign,
  onHandoff,
  onRename,
  renameSaving,
  onBotReplyModeChange,
}: {
  thread: Thread;
  onStatusChange: (s: ThreadStatus) => void;
  onAssignSelf: () => void;
  onUnassign: () => void;
  onHandoff: () => void;
  onRename: (name: string | null) => void;
  renameSaving: boolean;
  onBotReplyModeChange: (m: 'text' | 'voice' | 'match_customer' | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.customerName ?? '');
  useEffect(() => {
    setDraft(thread.customerName ?? '');
    setEditing(false);
  }, [thread.id, thread.customerName]);

  const save = () => {
    const trimmed = draft.trim();
    const next = trimmed.length > 0 ? trimmed : null;
    if (next === (thread.customerName ?? null)) {
      setEditing(false);
      return;
    }
    onRename(next);
    setEditing(false);
  };

  // Tightened layout:
  //   Row 1 (always visible):  avatar circle + customer name (clickable
  //                            to rename) + status pill + assignee chip.
  //                            On the right: Take / AI / Handoff (the
  //                            three ownership actions, grouped).
  //   Row 2 (always visible):  phone (mono) + WhatsApp nickname.
  //                            Quiet — these are reference info, not
  //                            actions.
  // No more layout shifts on rename: secondary line is unconditional.
  const initial = (thread.customerName ?? thread.customerWhatsappName ?? thread.customerPhone)
    .replace(/[^\p{L}\p{N}]/gu, '')
    .charAt(0)
    .toUpperCase() || '#';

  return (
    <div className="flex flex-col gap-2 border-b border-border bg-surface-muted/40 px-4 py-2.5">
      {/* Row 1 — identity + actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {/* Avatar circle with the first character of the visible name */}
          <div
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700"
          >
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="flex items-center gap-1.5">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') save();
                    if (e.key === 'Escape') {
                      setDraft(thread.customerName ?? '');
                      setEditing(false);
                    }
                  }}
                  placeholder="Customer name"
                  autoFocus
                  className="h-7 max-w-[14rem] text-sm"
                  aria-label="Customer name"
                />
                <Button size="sm" onClick={save} loading={renameSaving}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft(thread.customerName ?? '');
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="group inline-flex max-w-full items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                title="Click to rename"
              >
                <span className="truncate text-sm font-semibold text-foreground">
                  {thread.customerName ?? thread.customerWhatsappName ?? thread.customerPhone}
                </span>
                <span className="text-[10px] font-normal text-foreground-subtle opacity-0 group-hover:opacity-100">
                  ✎ rename
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Right cluster: status pill + assignee chip + action group.
            Status comes first so it reads top-left to bottom-right:
            who is this, what state, who owns it, what can I do. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Select value={thread.status} onValueChange={(v) => onStatusChange(v as ThreadStatus)}>
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="escalated">Escalated</SelectItem>
            </SelectContent>
          </Select>
          {thread.assignedToName ? (
            <Badge variant="muted" className="gap-1 whitespace-nowrap">
              <UserCheck className="size-3" /> {thread.assignedToName}
            </Badge>
          ) : (
            <Badge variant={STATUS_VARIANT[thread.status]} className="gap-1 whitespace-nowrap">
              <Sparkles className="size-3" /> AI handling
            </Badge>
          )}
          {/* The three ownership actions, visually grouped via a rounded
              container so they read as a single control. */}
          <div className="flex items-center overflow-hidden rounded-md border border-border bg-surface">
            <Button
              size="sm"
              variant="ghost"
              className="rounded-none border-0"
              onClick={onAssignSelf}
              title="Take this thread (you become the assignee)"
            >
              <UserCheck className="size-3.5" /> Take
            </Button>
            <span className="h-5 w-px bg-border" aria-hidden />
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                'rounded-none border-0',
                !thread.assignedToUserId && 'bg-brand-50 text-brand-700',
              )}
              aria-pressed={!thread.assignedToUserId}
              onClick={onUnassign}
              title={
                thread.assignedToUserId
                  ? 'Hand the thread to the AI (unassigns the current owner)'
                  : 'AI is currently handling this thread'
              }
            >
              <Sparkles className="size-3.5" /> AI
            </Button>
            <span className="h-5 w-px bg-border" aria-hidden />
            <Button
              size="sm"
              variant="ghost"
              className="rounded-none border-0 text-amber-700"
              onClick={onHandoff}
              title="Escalate to a human + post an internal note"
            >
              <AlertTriangle className="size-3.5" /> Handoff
            </Button>
          </div>
        </div>
      </div>

      {/* Row 2 — phone + WhatsApp nickname (quiet reference info) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-12 text-[11px] text-foreground-subtle">
        <span className="inline-flex items-center gap-1 font-mono">
          <Phone className="size-3" />
          {thread.customerPhone}
        </span>
        {thread.customerWhatsappName ? (
          <span title="The customer's WhatsApp profile name (read-only)">
            WhatsApp: <span className="font-medium">{thread.customerWhatsappName}</span>
          </span>
        ) : null}
        {/* Phase 6 — per-thread bot reply-mode override. "Default" inherits
            BotConfig.replyMode (set on /bot). */}
        <span className="ml-auto inline-flex items-center gap-1.5">
          <span className="text-foreground-subtle">Bot reply:</span>
          <select
            value={thread.botReplyMode ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              onBotReplyModeChange(
                v === ''
                  ? null
                  : (v as 'text' | 'voice' | 'match_customer'),
              );
            }}
            className="rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-surface-muted"
            title="Override how the bot replies to THIS conversation only. Default = use org-wide setting from /bot."
          >
            <option value="">Default (org-wide)</option>
            <option value="text">Always text</option>
            <option value="voice">Always voice</option>
            <option value="match_customer">Match customer</option>
          </select>
        </span>
      </div>
    </div>
  );
}

function TagBar({
  thread,
  onAdd,
  onRemove,
}: {
  thread: Thread;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const [input, setInput] = useState('');
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
      <TagIcon className="size-3.5 shrink-0 text-foreground-muted" />
      {thread.tags.map((t) => (
        <Badge key={t} variant="outline" className="gap-1 text-xs">
          {t}
          <button
            type="button"
            onClick={() => onRemove(t)}
            aria-label={`Remove tag ${t}`}
            className="rounded hover:bg-surface-muted"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && input.trim()) {
            e.preventDefault();
            onAdd(input.trim());
            setInput('');
          }
        }}
        placeholder="+ tag"
        aria-label="Add tag"
        className="h-7 w-32 rounded border border-border bg-surface px-2 text-xs placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      />
    </div>
  );
}

// Scroll container that auto-pins the conversation to the bottom on
// thread open and whenever a new message arrives. Respects operator
// intent: if they've scrolled up to read older history (more than
// ~80px from the bottom), we don't yank them back — but the moment
// they scroll near the bottom again we resume sticking.
function MessageScroller({
  threadId,
  timelineLength,
  latestTimestamp,
  children,
}: {
  threadId: string;
  timelineLength: number;
  latestTimestamp: string | null;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Tracks whether the operator is "stuck to the bottom" — true means
  // any new message scrolls them down; false means they're reading
  // older messages and we leave them alone.
  const stuckRef = useRef(true);

  // Jump (instant, no animation) to the bottom whenever the thread
  // changes — different conversation, different reading position.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckRef.current = true;
  }, [threadId]);

  // Smooth-scroll to the bottom whenever a new message lands AND the
  // operator is currently near the bottom. Triggered by either a
  // timeline count change OR the most recent message's timestamp
  // changing (covers in-place edits).
  useEffect(() => {
    const el = ref.current;
    if (!el || !stuckRef.current) return;
    // Defer one frame so the DOM has rendered the new message before
    // we measure scrollHeight.
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  }, [timelineLength, latestTimestamp]);

  const handleScroll = () => {
    const el = ref.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stuckRef.current = distanceFromBottom < 80;
  };

  return (
    <div
      ref={ref}
      onScroll={handleScroll}
      className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4"
    >
      {children}
    </div>
  );
}

// Tiny banner just under the thread header that tells the operator
// whether the AI is actively replying to this thread. Three cases:
//   - bot deployed + thread unassigned → AI is auto-replying
//   - bot deployed + thread assigned   → AI paused (human owns it)
//   - bot not deployed                 → AI off platform-wide, click
//                                        through to /bot to deploy
function AiStatusBanner({ thread, botDeployed }: { thread: Thread; botDeployed: boolean }) {
  if (!botDeployed) {
    return (
      <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50/60 px-4 py-1.5 text-xs text-amber-900">
        <Sparkles className="size-3.5" />
        <span>
          AI auto-reply is OFF — bot isn't deployed yet.{' '}
          <a href="/bot" className="font-medium underline">
            Deploy it on /bot
          </a>{' '}
          first.
        </span>
      </div>
    );
  }
  if (thread.assignedToUserId) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-surface-muted/40 px-4 py-1.5 text-xs text-foreground-muted">
        <UserCheck className="size-3.5" />
        <span>
          AI paused — this thread is assigned to a human ({thread.assignedToName ?? 'operator'}).
          Click <span className="font-medium">AI</span> above to give it back to the bot.
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-b border-emerald-200 bg-emerald-50/60 px-4 py-1.5 text-xs text-emerald-900">
      <Sparkles className="size-3.5" />
      <span>AI is replying automatically. Click <span className="font-medium">Take</span> to step in.</span>
    </div>
  );
}

function Bubble({
  message,
  isAlignedAdmin,
}: {
  message: Message;
  isAlignedAdmin: boolean;
}) {
  const isOut = message.direction === 'outbound';
  // Phase 8 / 1.3 — ALIGNED-admin only: click any bot bubble to inline
  // the message provenance panel underneath. Regular users see nothing.
  const isBotMessage = isOut && message.sentBy === 'bot';
  const canAudit = isAlignedAdmin && isBotMessage;
  // Phase 8 / 1.5 — image bubbles have no LLM provenance row, but we
  // still surface their upstream source inline (greeting image on /bot
  // vs product image keyed by SKU). Visible to ALIGNED admins only.
  const hasImageSource =
    isAlignedAdmin && isBotMessage && message.imageSource != null;
  const [open, setOpen] = useState(false);
  const provQ = useQuery({
    queryKey: ['provenance', message.id],
    queryFn: () =>
      api.get<{ data: MessageProvenance }>(
        `/api/v1/inbox/messages/${message.id}/provenance`,
      ),
    enabled: open && canAudit,
    staleTime: 60_000,
  });
  // Detect button/interactive replies and surface them visually. The
  // body text is already the button's label (via extractInboundBody on
  // the API side) — but a customer tapping "INTERESTED" looks
  // identical to one TYPING "INTERESTED" without an annotation. The
  // little 🔘 label tells the operator it was a button press, not
  // typed.
  const mt = (message.messageType ?? '').toLowerCase();
  const isButtonReply = mt === 'button' || mt === 'interactive';
  // Same idea for media types — show a small "📷 image" / "🎙 voice" /
  // "📄 document" tag when the message is a media type, regardless of
  // whether a caption is also present.
  const MEDIA_TAGS: Record<string, string> = {
    image: '📷 Image',
    video: '🎥 Video',
    audio: '🎙 Voice note',
    voice: '🎙 Voice note',
    document: '📄 Document',
    sticker: '🌟 Sticker',
    location: '📍 Location',
    contacts: '👤 Contact',
  };
  const mediaTag = MEDIA_TAGS[mt];
  const flaggedCount = provQ.data?.data?.hallucinations?.length ?? 0;
  return (
    <div className={cn('flex flex-col', isOut ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-3 py-2 text-sm',
          isOut ? 'bg-brand-500 text-white' : 'bg-surface-muted text-foreground',
          // Subtle red ring when the scanner flagged hallucinations.
          canAudit && flaggedCount > 0 ? 'ring-2 ring-rose-400/70' : '',
        )}
      >
        {isButtonReply ? (
          <p
            className={cn(
              'mb-1 text-[10px] font-semibold uppercase tracking-wide',
              isOut ? 'text-white/80' : 'text-brand-600',
            )}
          >
            🔘 Button tapped
          </p>
        ) : mediaTag ? (
          <p
            className={cn(
              'mb-1 text-[10px] font-semibold uppercase tracking-wide',
              isOut ? 'text-white/80' : 'text-foreground-subtle',
            )}
          >
            {mediaTag}
          </p>
        ) : null}
        <p className="whitespace-pre-wrap break-words">
          {message.body ?? <em className="opacity-70">[{message.messageType ?? 'media'}]</em>}
        </p>
        <div
          className={cn(
            'mt-1 flex items-center gap-2 text-[10px]',
            isOut ? 'text-white/80' : 'text-foreground-subtle',
          )}
        >
          <span>{formatRelative(message.receivedAt)}</span>
          {canAudit ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className={cn(
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors',
                isOut
                  ? 'bg-white/10 hover:bg-white/20'
                  : 'bg-foreground/10 hover:bg-foreground/20',
              )}
              title="ALIGNED admin — view AI provenance"
            >
              {open ? 'Hide' : 'AI source'}
              {flaggedCount > 0 ? (
                <span className="ml-1 rounded-full bg-rose-500 px-1.5 text-[9px] font-bold text-white">
                  {flaggedCount}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
      </div>
      {canAudit && open ? (
        <div className={cn('mt-1 w-full max-w-[80%]', isOut ? 'self-end' : 'self-start')}>
          <ProvenancePanel query={provQ} />
        </div>
      ) : null}
      {hasImageSource ? (
        <div
          className={cn(
            'mt-1 max-w-[80%] rounded-md border border-border bg-surface-muted/40 px-2 py-1 text-[11px] text-foreground-muted',
            isOut ? 'self-end' : 'self-start',
          )}
        >
          <ImageSourceAttribution source={message.imageSource!} />
        </div>
      ) : null}
    </div>
  );
}

// Phase 8 / 1.5 — inline attribution shown under image bubbles for
// ALIGNED admins. Tells the admin EXACTLY which catalog row or config
// field the image came from + links straight to the editor.
function ImageSourceAttribution({
  source,
}: {
  source: { kind: 'greeting' | 'product'; productSku: string | null };
}) {
  if (source.kind === 'greeting') {
    return (
      <span className="flex items-center gap-1">
        <span className="font-semibold">Image source:</span>
        <span>Greeting image uploaded on</span>
        <a href="/bot" className="font-medium text-brand-600 hover:underline">
          /bot
        </a>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 flex-wrap">
      <span className="font-semibold">Image source:</span>
      <span>Product image for SKU</span>
      <code className="rounded bg-surface px-1 py-0.5 text-[10px] font-mono">
        {source.productSku ?? '(unknown)'}
      </code>
      <span>—</span>
      <a href="/products" className="font-medium text-brand-600 hover:underline">
        find it on /products
      </a>
    </span>
  );
}

// Phase 8 / 1.3 — inline provenance panel rendered under a bot bubble in
// /inbox when an ALIGNED admin clicks "AI source". Four tabs:
//   • Sources         — citations + dereferenced rows
//   • Hallucinations  — flagged phrases
//   • LLM call        — model / tokens / latency
//   • Raw I/O         — full system prompt + history
function ProvenancePanel({
  query,
}: {
  query: ReturnType<typeof useQuery<{ data: MessageProvenance }>>;
}) {
  const [tab, setTab] = useState<'sources' | 'hallucinations' | 'llm' | 'raw'>(
    'sources',
  );
  if (query.isLoading) {
    return (
      <div className="rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs text-foreground-muted">
        Loading provenance…
      </div>
    );
  }
  if (query.error || !query.data?.data) {
    const status =
      query.error instanceof ApiError && query.error.status === 404
        ? 'No provenance recorded for this message yet.'
        : 'Could not load provenance.';
    return (
      <div className="rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs text-foreground-muted">
        {status}
      </div>
    );
  }
  const p = query.data.data;
  const cits = p.citations ?? [];
  const hals = p.hallucinations ?? [];
  return (
    <div className="rounded-md border border-border bg-surface-muted/30 text-xs">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <ProvTab
          active={tab === 'sources'}
          onClick={() => setTab('sources')}
          label={`Sources (${cits.length})`}
        />
        <ProvTab
          active={tab === 'hallucinations'}
          onClick={() => setTab('hallucinations')}
          label={`Hallucinations (${hals.length})`}
          accent={hals.length > 0 ? 'rose' : undefined}
        />
        <ProvTab active={tab === 'llm'} onClick={() => setTab('llm')} label="LLM call" />
        <ProvTab active={tab === 'raw'} onClick={() => setTab('raw')} label="Raw I/O" />
      </div>
      <div className="max-h-72 overflow-auto px-3 py-2 leading-relaxed">
        {tab === 'sources' ? <ProvSources p={p} /> : null}
        {tab === 'hallucinations' ? <ProvHallucinations p={p} /> : null}
        {tab === 'llm' ? <ProvLLM p={p} /> : null}
        {tab === 'raw' ? <ProvRaw p={p} /> : null}
      </div>
    </div>
  );
}

function ProvTab({
  active,
  onClick,
  label,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent?: 'rose';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
        active
          ? accent === 'rose'
            ? 'bg-rose-500 text-white'
            : 'bg-brand-500 text-white'
          : accent === 'rose'
            ? 'text-rose-700 hover:bg-rose-100'
            : 'text-foreground-muted hover:bg-surface-muted',
      )}
    >
      {label}
    </button>
  );
}

function ProvSources({ p }: { p: MessageProvenance }) {
  const cits = p.citations ?? [];
  if (cits.length === 0) {
    return (
      <p className="text-foreground-muted">
        No source matched the reply text. The bot might have replied with conversational
        filler only.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {cits.map((c, i) => (
        <SourceCitationRow key={i} c={c} />
      ))}
    </ul>
  );
}

// Phase 8 / 1.5 — type-specific rendering of a single citation. Shows:
// - product/service: name + SKU + DB price + cited price (with ✓ or ⚠
//   if they differ) + a clickable /products link
// - bot_config greeting: "Configured greeting on /bot"
// - business_info menuUrl: "Menu link · set on /business-info"
// - faq: question + matched n-gram snippet + link to /faqs
// - policy: kind + title
// Goal: when the admin opens this panel they can see at a glance EXACTLY
// where the bot pulled each fragment from, in the operator's own terms.
function SourceCitationRow({
  c,
}: {
  c: MessageProvenance['citations'] extends Array<infer U> | null ? U : never;
}) {
  const sourceUrl = sourcePageForCitation(c);
  return (
    <li className="rounded border border-border bg-surface px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">
          <ProvTypeBadge type={c.type} /> {c.label}
        </span>
        <span className="text-[10px] text-foreground-subtle">
          {(c.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <p className="mt-1 text-[11px] italic text-foreground-muted">"{c.snippet}"</p>
      <CitationDetail c={c} />
      {sourceUrl ? (
        <p className="mt-1 text-[10px]">
          <a href={sourceUrl.href} className="text-brand-600 hover:underline">
            {sourceUrl.label} →
          </a>
        </p>
      ) : null}
    </li>
  );
}

function CitationDetail({
  c,
}: {
  c: MessageProvenance['citations'] extends Array<infer U> | null ? U : never;
}) {
  if (c.type === 'product' || c.type === 'service') {
    const meta = (c.meta ?? {}) as {
      sku?: string;
      catalogPriceMinor?: number | null;
      citedPrice?: string;
      citedPriceMinor?: number;
      priceMatchesDb?: boolean;
    };
    return (
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        {meta.sku ? (
          <>
            <dt className="text-foreground-subtle">SKU</dt>
            <dd>
              <code className="rounded bg-surface-muted px-1 font-mono">{meta.sku}</code>
            </dd>
          </>
        ) : null}
        {typeof meta.catalogPriceMinor === 'number' ? (
          <>
            <dt className="text-foreground-subtle">Catalog price</dt>
            <dd className="font-mono">{(meta.catalogPriceMinor / 1000).toFixed(3)}</dd>
          </>
        ) : null}
        {meta.citedPrice ? (
          <>
            <dt className="text-foreground-subtle">Cited in reply</dt>
            <dd className="font-mono">
              {meta.citedPrice}{' '}
              {meta.priceMatchesDb === true ? (
                <span className="text-emerald-700">✓ matches</span>
              ) : meta.priceMatchesDb === false ? (
                <span className="text-rose-700">⚠ differs from catalog</span>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
    );
  }
  if (c.type === 'bot_config' && c.label === 'greeting') {
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        Configured greeting (BotConfig.greeting)
      </p>
    );
  }
  if (c.type === 'business_info' && c.label === 'menuUrl') {
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        Menu link set on Business info
      </p>
    );
  }
  if (c.type === 'business_info') {
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        Business info field: <code className="font-mono">{c.label}</code>
      </p>
    );
  }
  return null;
}

function sourcePageForCitation(c: {
  type: 'product' | 'service' | 'faq' | 'policy' | 'business_info' | 'bot_config';
  id: string | null;
  label: string;
}): { href: string; label: string } | null {
  switch (c.type) {
    case 'product':
      return c.id
        ? { href: `/products/${c.id}`, label: 'Open in /products' }
        : { href: '/products', label: 'Open /products' };
    case 'service':
      return c.id
        ? { href: `/services/${c.id}`, label: 'Open in /services' }
        : { href: '/services', label: 'Open /services' };
    case 'faq':
      return { href: '/business-info', label: 'Edit FAQs on /business-info' };
    case 'policy':
      return { href: '/business-info', label: 'Edit policies on /business-info' };
    case 'business_info':
      return { href: '/business-info', label: 'Edit on /business-info' };
    case 'bot_config':
      return { href: '/bot', label: 'Edit on /bot' };
    default:
      return null;
  }
}

function ProvHallucinations({ p }: { p: MessageProvenance }) {
  const hals = p.hallucinations ?? [];
  if (hals.length === 0) {
    return (
      <p className="text-emerald-700">
        ✓ Nothing flagged. Every product, price, and business-info phrase the bot used was
        present in the candidate catalog.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {hals.map((h, i) => (
        <li
          key={i}
          className={cn(
            'rounded border px-2 py-1.5',
            h.severity === 'critical'
              ? 'border-rose-300 bg-rose-50'
              : 'border-amber-300 bg-amber-50',
          )}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium">
              <span
                className={cn(
                  'mr-1 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white',
                  h.severity === 'critical' ? 'bg-rose-500' : 'bg-amber-500',
                )}
              >
                {h.severity}
              </span>
              {h.matchedText}
            </span>
            <span className="text-[10px] text-foreground-subtle">{h.type}</span>
          </div>
          <p className="mt-1 text-[11px] italic text-foreground-muted">"{h.context}"</p>
          <p className="mt-1 text-[11px] text-foreground">{h.reason}</p>
        </li>
      ))}
    </ul>
  );
}

function ProvLLM({ p }: { p: MessageProvenance }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
      <dt className="text-foreground-subtle">Model</dt>
      <dd className="font-mono">{p.model}</dd>
      <dt className="text-foreground-subtle">Temperature</dt>
      <dd className="font-mono">{p.temperature.toFixed(2)}</dd>
      <dt className="text-foreground-subtle">Prompt tokens</dt>
      <dd className="font-mono">{p.promptTokens.toLocaleString()}</dd>
      <dt className="text-foreground-subtle">Completion tokens</dt>
      <dd className="font-mono">{p.completionTokens.toLocaleString()}</dd>
      <dt className="text-foreground-subtle">Latency</dt>
      <dd className="font-mono">{p.latencyMs} ms</dd>
      <dt className="text-foreground-subtle">Prompt SHA-256</dt>
      <dd className="truncate font-mono text-[10px]" title={p.systemPrompt.sha256}>
        {p.systemPrompt.sha256.slice(0, 16)}…
      </dd>
      <dt className="text-foreground-subtle">Candidates packed</dt>
      <dd className="font-mono">
        {p.candidates.products.length}p / {p.candidates.services.length}s /{' '}
        {p.candidates.faqs.length}f
      </dd>
      <dt className="text-foreground-subtle">Recorded</dt>
      <dd className="font-mono">{formatRelative(p.createdAt)}</dd>
    </dl>
  );
}

function ProvRaw({ p }: { p: MessageProvenance }) {
  return (
    <div className="space-y-2">
      <details>
        <summary className="cursor-pointer text-[11px] font-medium text-foreground-muted hover:text-foreground">
          System prompt ({p.systemPrompt.body.length.toLocaleString()} chars)
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-surface px-2 py-1.5 text-[10px] leading-snug text-foreground">
          {p.systemPrompt.body}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer text-[11px] font-medium text-foreground-muted hover:text-foreground">
          User prompt
        </summary>
        <pre className="mt-1 overflow-auto rounded bg-surface px-2 py-1.5 text-[10px] text-foreground">
          {p.userPrompt}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer text-[11px] font-medium text-foreground-muted hover:text-foreground">
          History ({p.historyJson.length} turns)
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-surface px-2 py-1.5 text-[10px] text-foreground">
          {p.historyJson.map((t) => `[${t.role}] ${t.content}`).join('\n\n')}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer text-[11px] font-medium text-foreground-muted hover:text-foreground">
          Candidate set (products / services / FAQs packed into the prompt)
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-surface px-2 py-1.5 text-[10px] text-foreground">
          {JSON.stringify(p.candidates, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function ProvTypeBadge({
  type,
}: {
  type: 'product' | 'service' | 'faq' | 'policy' | 'business_info' | 'bot_config';
}) {
  const colours: Record<typeof type, string> = {
    product: 'bg-emerald-100 text-emerald-700',
    service: 'bg-sky-100 text-sky-700',
    faq: 'bg-violet-100 text-violet-700',
    policy: 'bg-amber-100 text-amber-700',
    business_info: 'bg-slate-100 text-slate-700',
    bot_config: 'bg-fuchsia-100 text-fuchsia-700',
  };
  return (
    <span
      className={cn(
        'mr-1 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide',
        colours[type],
      )}
    >
      {type}
    </span>
  );
}

function NoteBubble({ note }: { note: Note }) {
  return (
    <div className="flex justify-center">
      <div className="max-w-[80%] rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
        <div className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide">
          <StickyNote className="size-3" /> Internal note · {note.authorName ?? note.authorEmail ?? 'system'}
        </div>
        <p className="whitespace-pre-wrap break-words">{note.body}</p>
        <p className="mt-1 text-[10px] text-amber-700/80">{formatRelative(note.createdAt)}</p>
      </div>
    </div>
  );
}

function ReplyBox({
  to,
  cannedResponses,
  loading,
  onSend,
  onAddNote,
  addingNote,
}: {
  to: string;
  cannedResponses: CannedResponse[];
  loading: boolean;
  onSend: (body: string) => void;
  onAddNote: (body: string) => void;
  addingNote: boolean;
}) {
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [showCanned, setShowCanned] = useState(false);
  // Template-send dialog state. The Template button next to Canned opens
  // a picker that lists approved WhatsApp templates + lets the operator
  // fill any {{1}}, {{2}}… body variables before sending. Reuses the
  // existing /whatsapp/test-send endpoint that the channel-config page
  // uses for test sends — it already persists the rendered template to
  // the thread + bumps the inbox counters.
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [attaching, setAttaching] = useState(false);
  // Pending attachment — uploaded to Wasabi but NOT yet sent to Meta.
  // Operator picks file → it uploads in the background → we keep the
  // assetId here. Send happens when the operator clicks Send, with the
  // current body field used as caption.
  const [pendingAttachment, setPendingAttachment] = useState<{
    assetId: string;
    mediaType: 'image' | 'document' | 'audio';
    filename: string;
    durationSec?: number;
  } | null>(null);
  const [sendingMedia, setSendingMedia] = useState(false);
  // Voice recording state. We prefer opus-recorder (canonical OGG/Opus
  // — passes Meta's strict media validator and lands as a real
  // WhatsApp voice bubble). MediaRecorder is the fallback for older
  // browsers; its output gets degraded to a document on the server.
  const [recording, setRecording] = useState(false);
  const [recordedSec, setRecordedSec] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  // opus-recorder is dynamically imported so the 80-100kB worker
  // doesn't ship to non-voice users on initial bundle.
  const opusRecorderRef = useRef<OpusRecorderLike | null>(null);
  const opusBytesRef = useRef<Uint8Array | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartRef = useRef<number>(0);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const insertCanned = (cr: CannedResponse) => {
    // {first_name}, {phone} substitution — first_name is left empty for the
    // operator to fill (we don't have a name → first_name mapping yet).
    const filled = cr.body.replace(/\{phone\}/g, to);
    setBody((prev) => (prev ? `${prev}\n${filled}` : filled));
    setShowCanned(false);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  // Two-tier voice recording strategy:
  //
  //   1) Prefer opus-recorder — a JS lib that produces a canonical
  //      OGG/Opus container (the exact format WhatsApp uses for native
  //      voice notes). Meta's strict async validator accepts it, so
  //      the customer sees a real voice bubble with the play button.
  //   2) Fallback: native MediaRecorder. Its MP4/WebM output passes
  //      Meta's /media upload but fails the deeper delivery validation
  //      with error 131053 — the server then degrades it to a document
  //      so the customer still receives the audio, just as a file.
  async function startOpusRecording(): Promise<boolean> {
    try {
      // @ts-expect-error — opus-recorder ships no TS types
      const mod = await import('opus-recorder');
      const RecorderCtor = (mod as { default: OpusRecorderCtor }).default;
      if (!RecorderCtor) return false;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordStreamRef.current = stream;
      const rec = new RecorderCtor({
        encoderPath: '/opus/encoderWorker.min.js',
        // streamPages:false → ondataavailable fires ONCE at stop with
        // the entire OGG file as a Uint8Array. We just collect it
        // into opusBytesRef and build a File in stopRecording.
        streamPages: false,
        encoderApplication: 2048, // VOIP — what WhatsApp / phone calls use
        encoderSampleRate: 16_000, // matches WhatsApp voice notes
        numberOfChannels: 1,
      });
      rec.ondataavailable = (typedArray: Uint8Array) => {
        opusBytesRef.current = typedArray;
      };
      rec.onstop = () => {
        // Tear down the mic so the OS recording indicator clears.
        recordStreamRef.current?.getTracks().forEach((t) => t.stop());
        recordStreamRef.current = null;
      };
      rec.onerror = (err: unknown) => {
        console.warn('[voice] opus-recorder error', err);
      };
      opusBytesRef.current = null;
      await rec.start();
      opusRecorderRef.current = rec;
      return true;
    } catch (err) {
      console.warn('[voice] opus-recorder failed to start, falling back to MediaRecorder', err);
      recordStreamRef.current?.getTracks().forEach((t) => t.stop());
      recordStreamRef.current = null;
      return false;
    }
  }

  function pickRecorderMime(): string | null {
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return null;
    const candidates = ['audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/webm;codecs=opus'];
    for (const mime of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(mime)) return mime;
      } catch {
        /* some browsers throw */
      }
    }
    return null;
  }
  const canRecord = typeof window !== 'undefined' && pickRecorderMime() !== null;

  async function startRecording() {
    if (recording) return;
    // Tier 1: try opus-recorder first.
    const opusOk = await startOpusRecording();
    if (opusOk) {
      recordStartRef.current = Date.now();
      setRecording(true);
      setRecordedSec(0);
      recordTimerRef.current = setInterval(() => {
        setRecordedSec(Math.round((Date.now() - recordStartRef.current) / 1000));
      }, 250);
      return;
    }
    // Tier 2: MediaRecorder fallback.
    const mime = pickRecorderMime();
    if (!mime) {
      toast.error('Voice recording not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordStreamRef.current = stream;
      const mr = new MediaRecorder(stream, { mimeType: mime });
      recordChunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        // Tear down the mic stream before uploading so the OS-level
        // recording indicator stops immediately.
        recordStreamRef.current?.getTracks().forEach((t) => t.stop());
        recordStreamRef.current = null;
        if (recordTimerRef.current) {
          clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        const durationSec = Math.round((Date.now() - recordStartRef.current) / 1000);
        const blob = new Blob(recordChunksRef.current, { type: mime });
        if (blob.size < 500) {
          toast.error('Recording too short — try again.');
          setRecording(false);
          setRecordedSec(0);
          return;
        }
        // Upload as a document-kind asset — the server doesn't gate
        // MIME on documents, and /whatsapp/send-media reads the
        // stored content-type when posting to Meta.
        const ext = mime.startsWith('audio/ogg') ? 'ogg' : mime.startsWith('audio/mp4') ? 'm4a' : 'webm';
        const filename = `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
        const file = new File([blob], filename, { type: mime });
        setAttaching(true);
        try {
          const { uploadFile } = await import('@/lib/upload');
          const { assetId } = await uploadFile(file, 'document');
          // Voice notes auto-send the moment the recording stops —
          // every messenger app behaves this way and operators
          // expect the same. Files / images keep the explicit
          // staging UI because they often want a caption.
          setAttaching(false);
          setRecording(false);
          setRecordedSec(0);
          setSendingMedia(true);
          try {
            const res = await api.post<{ data: { ok: boolean; errorMessage: string | null } }>(
              '/api/v1/whatsapp/send-media',
              { to, assetId, mediaType: 'audio' },
            );
            if (res.data.ok) {
              toast.success(`Voice note (${durationSec}s) sent`);
              qc.invalidateQueries({ queryKey: ['inbox-thread'] });
              qc.invalidateQueries({ queryKey: ['inbox-threads'] });
            } else {
              toast.error(res.data.errorMessage ?? 'Voice send failed');
            }
          } catch (sendErr) {
            toast.error(sendErr instanceof Error ? sendErr.message : 'Voice send failed');
          } finally {
            setSendingMedia(false);
          }
          return;
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Upload failed');
        } finally {
          setAttaching(false);
          setRecording(false);
          setRecordedSec(0);
        }
      };
      recorderRef.current = mr;
      recordStartRef.current = Date.now();
      mr.start();
      setRecording(true);
      setRecordedSec(0);
      recordTimerRef.current = setInterval(() => {
        setRecordedSec(Math.round((Date.now() - recordStartRef.current) / 1000));
      }, 250);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Mic permission denied');
    }
  }

  async function finishOpusRecording(durationSec: number) {
    // ondataavailable fires synchronously during rec.stop(); give the
    // worker a tick to post back if we got here too fast.
    if (!opusBytesRef.current) await new Promise((r) => setTimeout(r, 50));
    const bytes = opusBytesRef.current;
    opusBytesRef.current = null;
    opusRecorderRef.current = null;
    if (!bytes || bytes.byteLength < 500) {
      toast.error('Recording too short — try again.');
      return;
    }
    const filename = `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.ogg`;
    const file = new File([bytes as BlobPart], filename, { type: 'audio/ogg' });
    setAttaching(true);
    try {
      const { uploadFile } = await import('@/lib/upload');
      const { assetId } = await uploadFile(file, 'document');
      setAttaching(false);
      setSendingMedia(true);
      try {
        const res = await api.post<{ data: { ok: boolean; errorMessage: string | null } }>(
          '/api/v1/whatsapp/send-media',
          { to, assetId, mediaType: 'audio' },
        );
        if (res.data.ok) {
          toast.success(`Voice note (${durationSec}s) sent`);
          qc.invalidateQueries({ queryKey: ['inbox-thread'] });
          qc.invalidateQueries({ queryKey: ['inbox-threads'] });
        } else {
          toast.error(res.data.errorMessage ?? 'Voice send failed');
        }
      } catch (sendErr) {
        toast.error(sendErr instanceof Error ? sendErr.message : 'Voice send failed');
      } finally {
        setSendingMedia(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setAttaching(false);
    }
  }

  function stopRecording() {
    if (!recording) return;
    if (opusRecorderRef.current) {
      const durationSec = Math.round((Date.now() - recordStartRef.current) / 1000);
      try {
        opusRecorderRef.current.stop();
      } catch {
        /* already stopped */
      }
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      setRecording(false);
      setRecordedSec(0);
      void finishOpusRecording(durationSec);
      return;
    }
    if (recorderRef.current) {
      try {
        recorderRef.current.stop();
      } catch {
        /* already stopped */
      }
    }
  }

  function cancelRecording() {
    if (!recording) return;
    // Opus path: discard the worker output before stopping.
    if (opusRecorderRef.current) {
      opusBytesRef.current = null;
      try {
        opusRecorderRef.current.stop();
      } catch {
        /* */
      }
      opusRecorderRef.current = null;
      recordStreamRef.current?.getTracks().forEach((t) => t.stop());
      recordStreamRef.current = null;
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      setRecording(false);
      setRecordedSec(0);
      return;
    }
    // MediaRecorder path: discard chunks before stopping so onstop
    // doesn't upload them.
    recordChunksRef.current = [];
    recorderRef.current?.stop();
    recordStreamRef.current?.getTracks().forEach((t) => t.stop());
    recordStreamRef.current = null;
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
    setRecordedSec(0);
  }

  // Cleanup if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      recordStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    };
  }, []);

  // Stage the attachment: upload to Wasabi but DO NOT call /send-media
  // yet. The Send button below handles the actual transmission.
  async function stageAttachment(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) {
      toast.error('Files must be under 16 MB.');
      return;
    }
    setAttaching(true);
    try {
      const isImage = file.type.startsWith('image/');
      const { uploadFile } = await import('@/lib/upload');
      const { assetId } = await uploadFile(file, isImage ? 'image' : 'document');
      setPendingAttachment({
        assetId,
        mediaType: isImage ? 'image' : 'document',
        filename: file.name,
      });
      toast.success('Attached — click Send to deliver');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function sendMediaNow() {
    if (!pendingAttachment) return;
    setSendingMedia(true);
    try {
      const res = await api.post<{ data: { ok: boolean; errorMessage: string | null } }>(
        '/api/v1/whatsapp/send-media',
        {
          to,
          assetId: pendingAttachment.assetId,
          mediaType: pendingAttachment.mediaType,
          caption: body.trim() || undefined,
        },
      );
      if (res.data.ok) {
        toast.success('Media sent');
        setBody('');
        setPendingAttachment(null);
        qc.invalidateQueries({ queryKey: ['inbox-thread'] });
        qc.invalidateQueries({ queryKey: ['inbox-threads'] });
      } else {
        toast.error(res.data.errorMessage ?? 'Send failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSendingMedia(false);
    }
  }

  const submit = () => {
    // If a file is attached, sending the message means transmitting the
    // media (with current text as caption). Otherwise, plain text reply
    // or note.
    if (mode === 'reply' && pendingAttachment) {
      void sendMediaNow();
      return;
    }
    const v = body.trim();
    if (!v) return;
    if (mode === 'reply') onSend(v);
    else onAddNote(v);
    setBody('');
  };

  return (
    <div className="border-t border-border">
      <div className="flex items-center gap-1.5 border-b border-border bg-surface-muted/40 px-3 py-1">
        <button
          type="button"
          onClick={() => setMode('reply')}
          aria-pressed={mode === 'reply'}
          className={cn(
            'rounded px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
            mode === 'reply' ? 'bg-surface text-foreground shadow-sm' : 'text-foreground hover:bg-surface-muted',
          )}
        >
          Reply
        </button>
        <button
          type="button"
          onClick={() => setMode('note')}
          aria-pressed={mode === 'note'}
          className={cn(
            'rounded px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
            mode === 'note'
              ? 'bg-amber-50 text-amber-800 shadow-sm'
              : 'text-foreground hover:bg-surface-muted',
          )}
        >
          <StickyNote className="mr-1 inline size-3" /> Internal note
        </button>
        <div className="ml-auto flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            className="hidden"
            onChange={stageAttachment}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={mode === 'note' || attaching || !!pendingAttachment || recording}
            loading={attaching && !recording}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach file"
          >
            <Paperclip className="size-3.5" /> Attach
          </Button>
          {/* Voice recorder. Disabled when an attachment is staged or
              when MediaRecorder is unsupported. While recording the
              button turns red and shows the elapsed seconds; a Cancel
              ✕ appears next to it to discard without sending. */}
          {recording ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="bg-red-50 text-red-700 hover:bg-red-100"
                onClick={stopRecording}
                aria-label="Stop recording"
              >
                <Mic className="size-3.5" /> Stop · {recordedSec}s
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={cancelRecording}
                aria-label="Cancel recording"
              >
                <X className="size-3.5" />
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={mode === 'note' || attaching || !!pendingAttachment || !canRecord}
              onClick={startRecording}
              aria-label="Record voice note"
              title={
                canRecord
                  ? 'Record a voice note (sent as a WhatsApp voice message)'
                  : "This browser doesn't support voice recording — try Chrome/Safari"
              }
            >
              <Mic className="size-3.5" /> Voice
            </Button>
          )}
          <div className="relative">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowCanned((v) => !v)}
            disabled={mode === 'note'}
            aria-haspopup="true"
            aria-expanded={showCanned}
          >
            <Clock className="size-3.5" /> Canned <ChevronDown className="size-3" />
          </Button>
          {/* Template-send. Always enabled — templates are the ONE thing
              Meta lets us send outside the 24-hour customer-session
              window, so the button must be reachable even when the
              free-form reply Send is disabled. Internal notes mode
              hides it (templates only go outbound to WhatsApp). */}
          {mode === 'reply' ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setTemplateDialogOpen(true)}
              aria-haspopup="dialog"
              title="Send an approved WhatsApp template"
            >
              <FileText className="size-3.5" /> Template
            </Button>
          ) : null}
          {showCanned ? (
            <div className="absolute right-0 z-10 mt-1 w-64 rounded-md border border-border bg-surface shadow-lg">
              {cannedResponses.length === 0 ? (
                <p className="px-3 py-2 text-xs text-foreground-muted">
                  No canned responses yet. Manage in Settings.
                </p>
              ) : (
                cannedResponses.map((cr) => (
                  <button
                    key={cr.id}
                    type="button"
                    onClick={() => insertCanned(cr)}
                    className="block w-full border-b border-border px-3 py-2 text-left text-xs hover:bg-surface-muted last:border-b-0 focus-visible:outline-none focus-visible:bg-surface-muted"
                  >
                    <span className="font-mono text-brand-600">/{cr.shortcut}</span>{' '}
                    <span className="truncate text-foreground-muted">{cr.body.slice(0, 60)}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
          </div>
        </div>
      </div>
      <div className="p-3">
        {pendingAttachment ? (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs">
            {pendingAttachment.mediaType === 'audio' ? (
              <Mic className="size-3.5 text-foreground-muted" />
            ) : (
              <Paperclip className="size-3.5 text-foreground-muted" />
            )}
            <span className="flex-1 truncate font-mono">
              {pendingAttachment.mediaType === 'audio' && pendingAttachment.durationSec != null
                ? `Voice note · ${pendingAttachment.durationSec}s`
                : pendingAttachment.filename}
            </span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
              Not sent yet
            </span>
            <button
              type="button"
              onClick={() => setPendingAttachment(null)}
              className="rounded p-0.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground"
              aria-label="Remove attachment"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ) : null}
        <Textarea
          ref={taRef}
          rows={3}
          placeholder={
            mode === 'reply'
              ? pendingAttachment
                ? 'Optional caption…'
                : `Reply to ${to}…  (must be inside Meta's 24-hour customer-session window)`
              : 'Internal note — visible to your team, not sent to the customer.'
          }
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-label={mode === 'reply' ? 'Reply message' : 'Internal note'}
        />
        <div className="mt-2 flex items-center justify-between">
          <p className="text-[11px] text-foreground-muted">
            {mode === 'reply' ? (
              pendingAttachment ? (
                <>Click Send to deliver this attachment with your caption.</>
              ) : (
                <>Outside the 24h window? Send a template from the WhatsApp page.</>
              )
            ) : (
              <>Notes are stored on the thread, never sent to Meta.</>
            )}
          </p>
          <Button
            type="button"
            size="sm"
            loading={
              mode === 'reply'
                ? pendingAttachment
                  ? sendingMedia
                  : loading
                : addingNote
            }
            disabled={
              mode === 'reply'
                ? pendingAttachment
                  ? sendingMedia
                  : body.trim().length === 0
                : body.trim().length === 0
            }
            onClick={submit}
          >
            {mode === 'reply' ? (
              <>
                <Send className="size-3.5" /> Send
              </>
            ) : (
              <>
                <CheckCircle2 className="size-3.5" /> Add note
              </>
            )}
          </Button>
        </div>
      </div>
      {/* Template-send dialog. Mounted inside ReplyBox so it has the
          right `to` in scope. Closes itself on a successful send + the
          thread refresh happens via React Query invalidation inside the
          dialog. */}
      <TemplateSendDialog
        open={templateDialogOpen}
        onOpenChange={setTemplateDialogOpen}
        to={to}
      />
    </div>
  );
}

interface TemplateOption {
  id: string;
  name: string;
  language: string;
  status: string;
  bodyText?: string | null;
  components?: Record<string, unknown>[] | null;
}

// Parse the `{{n}}` placeholders out of a template's body text and
// return them as a sorted unique list. Used to render exactly the
// right number of variable inputs in the dialog.
function placeholdersIn(body: string | null | undefined): number[] {
  if (!body) return [];
  const set = new Set<number>();
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

function TemplateSendDialog({
  open,
  onOpenChange,
  to,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  to: string;
}) {
  const qc = useQueryClient();
  const templatesQ = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: () => api.get<{ data: TemplateOption[] }>('/api/v1/whatsapp/templates'),
    // Don't refetch while the dialog is open — gives the operator a
    // stable list to pick from. They can reload by reopening.
    enabled: open,
    staleTime: 60_000,
  });
  const [selectedId, setSelectedId] = useState<string>('');
  const [vars, setVars] = useState<string[]>([]);

  // Approved-only templates surface in the picker. Anything else (pending,
  // rejected, disabled) won't actually deliver via Meta, so we hide them
  // rather than letting the operator pick + then fail at send time.
  const templates = (templatesQ.data?.data ?? []).filter((t) => t.status === 'approved');
  const selected = templates.find((t) => t.id === selectedId) ?? null;
  const placeholders = useMemo(() => placeholdersIn(selected?.bodyText), [selected]);

  // Reset state when the dialog opens / the picked template changes.
  useEffect(() => {
    if (!open) return;
    setSelectedId('');
    setVars([]);
  }, [open]);
  useEffect(() => {
    setVars(new Array(placeholders.length).fill(''));
  }, [selectedId, placeholders.length]);

  const send = useMutation({
    mutationFn: () => {
      if (!selected) return Promise.reject(new Error('Pick a template first'));
      return api.post<{ data: { ok: boolean; metaMessageId: string | null; errorMessage: string | null } }>(
        '/api/v1/whatsapp/test-send',
        {
          to,
          templateName: selected.name,
          templateLanguage: selected.language,
          parameters: vars.map((v) => v.trim()),
        },
      );
    },
    onSuccess: (res) => {
      if (res.data.ok) {
        toast.success('Template sent');
        qc.invalidateQueries({ queryKey: ['inbox-thread'] });
        qc.invalidateQueries({ queryKey: ['inbox-threads'] });
        onOpenChange(false);
      } else {
        toast.error(res.data.errorMessage ?? 'Send failed — Meta rejected the template.');
      }
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Send failed'),
  });

  // Preview the body with the operator's filled values substituted in.
  // Shown beneath the form so they can see exactly what the customer
  // will receive before clicking Send.
  const preview = useMemo(() => {
    if (!selected?.bodyText) return '';
    return selected.bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_full, idx: string) => {
      const i = Number(idx) - 1;
      return vars[i]?.trim() ? vars[i].trim() : `{{${idx}}}`;
    });
  }, [selected, vars]);

  const canSend = Boolean(selected) && vars.every((v) => v.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send a template</DialogTitle>
          <DialogDescription>
            Approved WhatsApp template message. Sends to {to} immediately; works inside or
            outside Meta&apos;s 24-hour session window.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-pick">Template</Label>
            {templatesQ.isLoading ? (
              <p className="text-xs text-foreground-muted">Loading…</p>
            ) : templates.length === 0 ? (
              <p className="text-xs text-foreground-muted">
                No approved templates yet. Create + submit one on{' '}
                <a href="/whatsapp/templates" className="underline">
                  /whatsapp/templates
                </a>{' '}
                — Meta&apos;s approval usually takes a few minutes.
              </p>
            ) : (
              <Select value={selectedId} onValueChange={setSelectedId}>
                <SelectTrigger id="tpl-pick">
                  <SelectValue placeholder="Pick an approved template…" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.language})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {placeholders.length > 0 ? (
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-foreground-subtle">
                Variables
              </Label>
              {placeholders.map((n, i) => (
                <div key={n} className="space-y-1">
                  <Label htmlFor={`tpl-var-${n}`} className="text-xs">
                    {`{{${n}}}`}
                  </Label>
                  <Input
                    id={`tpl-var-${n}`}
                    value={vars[i] ?? ''}
                    onChange={(e) => {
                      const next = [...vars];
                      next[i] = e.target.value;
                      setVars(next);
                    }}
                    placeholder={`Value for {{${n}}}`}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {selected ? (
            <div className="rounded-md border border-border bg-surface-muted/60 p-3 text-xs">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
                Preview
              </p>
              <p className="whitespace-pre-wrap text-sm">{preview || '(no body)'}</p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => send.mutate()} disabled={!canSend} loading={send.isPending}>
            <Send className="size-3.5" /> Send template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- SSE realtime hook ---------------------------------------------
// EventSource doesn't support setting Authorization headers, so we pass
// the access token as a query string. The server treats `?token=` the same
// way it treats the bearer header for SSE-only routes (added in inbox.routes).
function useInboxSSE() {
  const qc = useQueryClient();
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const url = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/inbox/sse?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener('tick', () => {
      qc.invalidateQueries({ queryKey: ['inbox-threads'] });
      qc.invalidateQueries({ queryKey: ['inbox-thread'] });
      // Drive the sidebar Inbox badge in real time. When the bot
      // escalates a chat or the operator un-escalates one, the count
      // should flip without waiting for the 10s sidebar poll.
      qc.invalidateQueries({ queryKey: ['sidebar-inbox-counts'] });
    });
    es.onerror = () => {
      // EventSource auto-reconnects per `retry: 5000` from the server.
    };
    return () => es.close();
  }, [qc]);
}
