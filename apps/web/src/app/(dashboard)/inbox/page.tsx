'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, MessageCircle, Phone, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Thread {
  phone: string;
  lastDirection: 'inbound' | 'outbound';
  lastBody: string | null;
  lastAt: string;
  inboundCount: number;
  outboundCount: number;
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

export default function InboxPage() {
  const queryClient = useQueryClient();
  const [active, setActive] = useState<string | null>(null);

  const threadsQ = useQuery({
    queryKey: ['inbox-threads'],
    queryFn: () => api.get<{ data: Thread[] }>('/api/v1/whatsapp/threads'),
    refetchInterval: 8_000, // poll for new inbound until WebSockets land
  });

  const messagesQ = useQuery({
    queryKey: ['inbox-thread', active],
    queryFn: () =>
      active
        ? api.get<{ data: Message[] }>(`/api/v1/whatsapp/threads/${encodeURIComponent(active)}`)
        : Promise.resolve({ data: [] as Message[] }),
    enabled: !!active,
    refetchInterval: 5_000,
  });

  const sendReply = useMutation({
    mutationFn: ({ to, body }: { to: string; body: string }) =>
      api.post<{ data: { ok: boolean; errorMessage: string | null } }>(
        '/api/v1/whatsapp/send',
        { to, body },
      ),
    onSuccess: (res) => {
      if (res.data.ok) {
        toast.success('Reply sent');
        queryClient.invalidateQueries({ queryKey: ['inbox-thread', active] });
        queryClient.invalidateQueries({ queryKey: ['inbox-threads'] });
      } else {
        toast.error(res.data.errorMessage ?? 'Send failed');
      }
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Send failed'),
  });

  const threads = threadsQ.data?.data ?? [];
  const messages = messagesQ.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Every WhatsApp conversation grouped by customer. Replies use Meta's 24-hour session window."
        actions={
          <Badge variant="muted" className="gap-1">
            <MessageCircle className="size-3" /> {threads.length} thread{threads.length === 1 ? '' : 's'}
          </Badge>
        }
      />

      {/* Honesty banner — Phase 3 inbox MVP. No assignment, tags, internal notes,
          handoff, search, real-time WebSockets yet. */}
      <Card className="mb-6 border-amber-200 bg-amber-50/30">
        <CardContent className="flex items-start gap-3 py-3 text-xs text-amber-900">
          <Inbox className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Inbox MVP.</p>
            <p className="mt-0.5">
              Read &amp; reply works. Assignment, status, tags, internal notes, handoff routing, full
              search, and real-time WebSocket updates land in the rest of Phase 3 §5.1.1. Threads
              auto-refresh every 8 seconds for now.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid h-[calc(100vh-22rem)] grid-cols-1 gap-0 overflow-hidden rounded-lg border border-border bg-white lg:grid-cols-[20rem_1fr]">
        {/* ----- thread list ----- */}
        <ul
          className="overflow-y-auto border-r border-border"
          aria-label="Conversations"
        >
          {threads.length === 0 ? (
            <li>
              <EmptyState
                icon={Inbox}
                title="No conversations yet"
                description="Inbound WhatsApp messages will appear here once Meta starts posting to the webhook."
              />
            </li>
          ) : (
            threads.map((t) => (
              <li key={t.phone}>
                <button
                  type="button"
                  onClick={() => setActive(t.phone)}
                  aria-current={active === t.phone}
                  className={cn(
                    'flex w-full flex-col gap-0.5 border-b border-border px-4 py-3 text-left text-sm transition-colors hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400',
                    active === t.phone && 'bg-brand-50/50',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 truncate font-mono text-xs">
                      <Phone className="size-3.5 shrink-0 text-foreground-muted" />
                      {t.phone}
                    </span>
                    <span className="whitespace-nowrap text-[10px] text-foreground-subtle">
                      {formatRelative(t.lastAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {t.lastDirection === 'outbound' ? (
                      <Badge variant="muted" className="text-[10px]">
                        you
                      </Badge>
                    ) : null}
                    <span className="truncate text-xs text-foreground">
                      {t.lastBody ?? <em className="text-foreground-subtle">no preview</em>}
                    </span>
                  </div>
                  <div className="text-[10px] text-foreground-subtle">
                    {t.inboundCount} in · {t.outboundCount} out
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>

        {/* ----- thread view ----- */}
        <div className="flex min-w-0 flex-col">
          {!active ? (
            <div className="flex flex-1 items-center justify-center text-sm text-foreground-muted">
              {threads.length > 0 ? 'Select a conversation.' : ''}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-border bg-surface-muted/40 px-4 py-2">
                <span className="flex items-center gap-2 font-mono text-sm">
                  <Phone className="size-4 text-foreground-muted" />
                  {active}
                </span>
                <span className="text-xs text-foreground-subtle">
                  {messages.length} message{messages.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto p-4">
                {messagesQ.isLoading ? (
                  <p className="text-center text-sm text-foreground-muted">Loading…</p>
                ) : messages.length === 0 ? (
                  <p className="text-center text-sm text-foreground-muted">No messages yet.</p>
                ) : (
                  messages.map((m) => <Bubble key={m.id} message={m} />)
                )}
              </div>
              <ReplyBox
                to={active}
                loading={sendReply.isPending}
                onSend={(body) => sendReply.mutate({ to: active, body })}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Bubble({ message }: { message: Message }) {
  const isOut = message.direction === 'outbound';
  return (
    <div
      className={cn(
        'flex',
        isOut ? 'justify-end' : 'justify-start',
      )}
    >
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-3 py-2 text-sm',
          isOut ? 'bg-brand-500 text-white' : 'bg-surface-muted text-foreground',
        )}
      >
        <p className="whitespace-pre-wrap break-words">
          {message.body ?? <em className="opacity-70">{message.messageType ?? 'unknown'}</em>}
        </p>
        <p className={cn('mt-1 text-[10px]', isOut ? 'text-white/80' : 'text-foreground-subtle')}>
          {formatRelative(message.receivedAt)}
        </p>
      </div>
    </div>
  );
}

function ReplyBox({
  to,
  loading,
  onSend,
}: {
  to: string;
  loading: boolean;
  onSend: (body: string) => void;
}) {
  const [body, setBody] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = body.trim();
        if (v) {
          onSend(v);
          setBody('');
        }
      }}
      className="border-t border-border p-3"
    >
      <Textarea
        rows={2}
        placeholder={`Reply to ${to}…`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Reply message"
      />
      <div className="mt-2 flex items-center justify-between">
        <p className="text-[11px] text-foreground-muted">
          Replies must be inside the 24-hour customer-session window. Outside it, send a template
          via the WhatsApp page.
        </p>
        <Button type="submit" size="sm" loading={loading} disabled={body.trim().length === 0}>
          <Send className="size-3.5" /> Send
        </Button>
      </div>
    </form>
  );
}
