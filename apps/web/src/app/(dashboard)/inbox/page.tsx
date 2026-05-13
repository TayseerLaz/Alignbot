'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Inbox,
  MessageCircle,
  Paperclip,
  Phone,
  Send,
  Sparkles,
  StickyNote,
  Tag as TagIcon,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

type ThreadStatus = 'open' | 'pending' | 'resolved' | 'escalated';

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
  const [activeId, setActiveId] = useState<string | null>(null);
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

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden rounded-lg border border-border bg-white lg:grid-cols-[22rem_1fr]">
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
          />
        </div>
        <ThreadView
          thread={active}
          onChanged={() => {
            queryClient.invalidateQueries({ queryKey: ['inbox-threads'] });
            if (active) queryClient.invalidateQueries({ queryKey: ['inbox-thread', active.id] });
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
}: {
  threads: Thread[];
  activeId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
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
                'flex w-full flex-col gap-1 border-b border-border px-3 py-3 text-left text-sm hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400',
                activeId === t.id && 'bg-brand-50/50',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 truncate font-mono text-xs">
                  <Phone className="size-3.5 shrink-0 text-foreground-muted" />
                  {t.customerName ?? t.customerPhone}
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
      />
      <TagBar thread={thread} onAdd={(t) => addTag.mutate(t)} onRemove={(t) => removeTag.mutate(t)} />
      <AiStatusBanner thread={thread} botDeployed={botDeployed} />
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {messagesQ.isLoading ? (
          <p className="text-center text-sm text-foreground-muted">Loading…</p>
        ) : timeline.length === 0 ? (
          <p className="text-center text-sm text-foreground-muted">No messages yet.</p>
        ) : (
          timeline.map((item) =>
            item.kind === 'msg' ? (
              <Bubble key={item.msg.id} message={item.msg} />
            ) : (
              <NoteBubble key={item.note.id} note={item.note} />
            ),
          )
        )}
      </div>
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
}: {
  thread: Thread;
  onStatusChange: (s: ThreadStatus) => void;
  onAssignSelf: () => void;
  onUnassign: () => void;
  onHandoff: () => void;
  onRename: (name: string | null) => void;
  renameSaving: boolean;
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

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-muted/40 px-4 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Phone className="size-4 shrink-0 text-foreground-muted" />
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-2">
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
                className="h-7 max-w-[16rem] text-sm"
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
              className="group block max-w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
              title="Click to rename"
            >
              {/* Top line: operator-set name if any, otherwise the WhatsApp
                  profile name, otherwise the phone. */}
              <p className="truncate text-sm font-semibold text-foreground">
                {thread.customerName ?? thread.customerWhatsappName ?? thread.customerPhone}
                <span className="ml-1 text-[10px] font-normal text-foreground-subtle opacity-0 group-hover:opacity-100">
                  ✎ rename
                </span>
              </p>
              {/* Secondary line(s): show phone always when a name is on
                  top, and the WhatsApp display name when it differs from
                  the operator's rename so both signals are visible. */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0">
                {thread.customerWhatsappName && thread.customerWhatsappName !== thread.customerName ? (
                  <p className="text-[10px] text-foreground-subtle">
                    WhatsApp: <span className="font-medium">{thread.customerWhatsappName}</span>
                  </p>
                ) : null}
                {thread.customerName || thread.customerWhatsappName ? (
                  <p className="font-mono text-[10px] text-foreground-subtle">
                    {thread.customerPhone}
                  </p>
                ) : null}
              </div>
            </button>
          )}
        </div>
        <Badge variant={STATUS_VARIANT[thread.status]} className="ml-2">
          {STATUS_LABEL[thread.status]}
        </Badge>
        {thread.assignedToName ? (
          <Badge variant="muted" className="gap-1">
            <UserCheck className="size-3" /> {thread.assignedToName}
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select value={thread.status} onValueChange={(v) => onStatusChange(v as ThreadStatus)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="escalated">Escalated</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="secondary" onClick={onAssignSelf}>
          <UserCheck className="size-3.5" /> Take
        </Button>
        {/* "AI" toggle: when no human is assigned to this thread, the
            deployed bot replies to inbound messages automatically. The
            button is active/pressed in that state to make it obvious.
            Clicking it on a human-owned thread unassigns the owner so
            the bot can take over. */}
        <Button
          size="sm"
          variant={thread.assignedToUserId ? 'ghost' : 'secondary'}
          aria-pressed={!thread.assignedToUserId}
          onClick={onUnassign}
          title={
            thread.assignedToUserId
              ? 'Let the AI handle this thread (unassigns the current owner)'
              : 'AI is currently handling this thread'
          }
        >
          <Sparkles className="size-3.5" /> AI
        </Button>
        <Button size="sm" variant="secondary" onClick={onHandoff}>
          <AlertTriangle className="size-3.5" /> Handoff
        </Button>
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
    <div className="flex items-center gap-2 border-b border-border bg-white px-4 py-2">
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
        className="h-7 w-32 rounded border border-border bg-white px-2 text-xs placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      />
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

function Bubble({ message }: { message: Message }) {
  const isOut = message.direction === 'outbound';
  return (
    <div className={cn('flex', isOut ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-3 py-2 text-sm',
          isOut ? 'bg-brand-500 text-white' : 'bg-surface-muted text-foreground',
        )}
      >
        <p className="whitespace-pre-wrap break-words">
          {message.body ?? <em className="opacity-70">[{message.messageType ?? 'media'}]</em>}
        </p>
        <p className={cn('mt-1 text-[10px]', isOut ? 'text-white/80' : 'text-foreground-subtle')}>
          {formatRelative(message.receivedAt)}
        </p>
      </div>
    </div>
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
  const [attaching, setAttaching] = useState(false);
  // Pending attachment — uploaded to Wasabi but NOT yet sent to Meta.
  // Operator picks file → it uploads in the background → we keep the
  // assetId here. Send happens when the operator clicks Send, with the
  // current body field used as caption.
  const [pendingAttachment, setPendingAttachment] = useState<{
    assetId: string;
    mediaType: 'image' | 'document';
    filename: string;
  } | null>(null);
  const [sendingMedia, setSendingMedia] = useState(false);
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
            mode === 'reply' ? 'bg-white text-foreground shadow-sm' : 'text-foreground hover:bg-surface-muted',
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
            disabled={mode === 'note' || attaching || !!pendingAttachment}
            loading={attaching}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach file"
          >
            <Paperclip className="size-3.5" /> Attach
          </Button>
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
          {showCanned ? (
            <div className="absolute right-0 z-10 mt-1 w-64 rounded-md border border-border bg-white shadow-lg">
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
            <Paperclip className="size-3.5 text-foreground-muted" />
            <span className="flex-1 truncate font-mono">
              {pendingAttachment.filename}
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
    </div>
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
    });
    es.onerror = () => {
      // EventSource auto-reconnects per `retry: 5000` from the server.
    };
    return () => es.close();
  }, [qc]);
}
