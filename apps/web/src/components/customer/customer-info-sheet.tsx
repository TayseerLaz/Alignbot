'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CalendarCheck,
  Clock,
  Globe,
  Hash,
  Phone,
  Plus,
  ShoppingBag,
  Tag as TagIcon,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';

interface Overview {
  contact: {
    id: string;
    phoneE164: string;
    displayName: string | null;
    whatsappName: string | null;
    optedInAt: string | null;
    optedOutAt: string | null;
    timezone: string | null;
    source: string;
    tags: string[];
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    createdAt: string | null;
  } | null;
  memory: {
    persona: string | null;
    language: string | null;
    facts: Record<string, unknown>;
    lastSummaryAt: string | null;
  } | null;
  orders: {
    id: string;
    createdAt: string;
    status: string;
    totalMinor: number;
    currency: string;
    itemsCount: number;
    items: { name: string; quantity: number }[];
  }[];
  bookings: {
    id: string;
    status: string;
    appointmentAt: string | null;
    notes: string | null;
    createdAt: string;
    fields: { label: string; value: string }[];
  }[];
  stats: { inboundCount: number; outboundCount: number; threadId: string | null };
}

function money(minor: number, currency: string): string {
  const dec = ['KWD', 'BHD', 'OMR', 'JOD'].includes(currency) ? 3 : 2;
  return `${(minor / Math.pow(10, dec)).toFixed(dec)} ${currency}`;
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Phone;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border px-5 py-4">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
        <Icon className="size-3.5" /> {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * Right-side slide-over showing everything we know about one customer, keyed
 * by phone. Used from the inbox conversation header AND the contacts page.
 * Reads GET /contacts/overview; tag add/remove writes through the existing
 * /contacts/:id/tags endpoints.
 */
export function CustomerInfoSheet({
  phone,
  fallbackName,
  open,
  onClose,
}: {
  phone: string | null;
  fallbackName?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [tagInput, setTagInput] = useState('');

  const q = useQuery({
    queryKey: ['contact-overview', phone],
    queryFn: () =>
      api.get<{ data: Overview }>(
        `/api/v1/contacts/overview?phone=${encodeURIComponent(phone ?? '')}`,
      ),
    enabled: open && !!phone,
  });
  const data = q.data?.data;
  const contactId = data?.contact?.id ?? null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['contact-overview', phone] });
    qc.invalidateQueries({ queryKey: ['contacts'] });
  };
  const addTag = useMutation({
    mutationFn: (tag: string) => api.post(`/api/v1/contacts/${contactId}/tags`, { tag }),
    onSuccess: () => {
      setTagInput('');
      invalidate();
    },
    onError: () => toast.error('Could not add tag'),
  });
  const removeTag = useMutation({
    mutationFn: (tag: string) =>
      api.delete(`/api/v1/contacts/${contactId}/tags/${encodeURIComponent(tag)}`),
    onSuccess: invalidate,
    onError: () => toast.error('Could not remove tag'),
  });

  if (!open) return null;

  const name = data?.contact?.displayName ?? data?.contact?.whatsappName ?? fallbackName ?? phone;
  const initial =
    (name ?? '#').replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '#';
  const facts = data?.memory?.facts ?? {};
  const factEntries = Object.entries(facts).filter(
    ([, v]) => v != null && v !== '' && (typeof v !== 'object' || Object.keys(v as object).length > 0),
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto bg-surface shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-surface px-5 py-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-100 text-base font-semibold text-brand-700">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-foreground">{name}</p>
            <p className="flex items-center gap-1 truncate font-mono text-xs text-foreground-subtle">
              <Phone className="size-3" /> {phone}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>

        {q.isLoading ? (
          <div className="space-y-6 p-5">
            <div className="space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </div>
        ) : (
          <>
            {/* Profile */}
            <Section icon={Hash} title="Profile">
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                {data?.contact?.whatsappName ? (
                  <>
                    <dt className="text-foreground-subtle">WhatsApp name</dt>
                    <dd className="text-foreground">{data.contact.whatsappName}</dd>
                  </>
                ) : null}
                <dt className="text-foreground-subtle">Status</dt>
                <dd>
                  {data?.contact?.optedOutAt ? (
                    <Badge variant="warning">Opted out</Badge>
                  ) : (
                    <Badge variant="success">Subscribed</Badge>
                  )}
                </dd>
                {data?.memory?.language ? (
                  <>
                    <dt className="flex items-center gap-1 text-foreground-subtle">
                      <Globe className="size-3" /> Language
                    </dt>
                    <dd className="uppercase text-foreground">{data.memory.language}</dd>
                  </>
                ) : null}
                {data?.contact?.timezone ? (
                  <>
                    <dt className="text-foreground-subtle">Timezone</dt>
                    <dd className="text-foreground">{data.contact.timezone}</dd>
                  </>
                ) : null}
                <dt className="text-foreground-subtle">Source</dt>
                <dd className="capitalize text-foreground">
                  {data?.contact?.source?.replace(/_/g, ' ') ?? '—'}
                </dd>
                {data?.contact?.createdAt ? (
                  <>
                    <dt className="text-foreground-subtle">First seen</dt>
                    <dd className="text-foreground">{formatRelative(data.contact.createdAt)}</dd>
                  </>
                ) : null}
                {data?.contact?.lastInboundAt ? (
                  <>
                    <dt className="text-foreground-subtle">Last message</dt>
                    <dd className="text-foreground">{formatRelative(data.contact.lastInboundAt)}</dd>
                  </>
                ) : null}
              </dl>
            </Section>

            {/* Tags — add + remove */}
            <Section icon={TagIcon} title="Tags">
              {!contactId ? (
                <p className="text-xs text-foreground-subtle">
                  Tags appear once this customer is saved to Contacts (happens automatically on
                  their next message).
                </p>
              ) : (
                <>
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {(data?.contact?.tags ?? []).length === 0 ? (
                      <span className="text-xs text-foreground-subtle">No tags yet.</span>
                    ) : (
                      data!.contact!.tags.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2.5 py-1 text-xs font-medium text-foreground"
                        >
                          {t}
                          <button
                            type="button"
                            onClick={() => removeTag.mutate(t)}
                            className="text-foreground-subtle hover:text-rose-600"
                            aria-label={`Remove tag ${t}`}
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      ))
                    )}
                  </div>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = tagInput.trim();
                      if (v) addTag.mutate(v);
                    }}
                  >
                    <Input
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      placeholder="Add a tag…"
                      maxLength={40}
                      className="h-9 text-sm"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!tagInput.trim() || addTag.isPending}
                    >
                      <Plus className="size-4" /> Add
                    </Button>
                  </form>
                </>
              )}
            </Section>

            {/* AI memory */}
            {data?.memory && (data.memory.persona || factEntries.length > 0) ? (
              <Section icon={Bot} title="What the AI remembers">
                {data.memory.persona ? (
                  <p className="mb-2 whitespace-pre-wrap text-sm text-foreground">
                    {data.memory.persona}
                  </p>
                ) : null}
                {factEntries.length > 0 ? (
                  <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
                    {factEntries.map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="truncate capitalize text-foreground-subtle">
                          {k.replace(/_/g, ' ')}
                        </dt>
                        <dd className="text-foreground">
                          {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </Section>
            ) : null}

            {/* Orders */}
            <Section icon={ShoppingBag} title={`Orders (${data?.orders.length ?? 0})`}>
              {(data?.orders.length ?? 0) === 0 ? (
                <p className="text-xs text-foreground-subtle">No orders yet.</p>
              ) : (
                <ul className="space-y-2">
                  {data!.orders.map((o) => (
                    <li key={o.id} className="rounded-lg border border-border p-2.5 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-foreground">
                          {money(o.totalMinor, o.currency)}
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge variant={o.status === 'confirmed' ? 'muted' : 'outline'}>
                            {o.status}
                          </Badge>
                          <span className="text-xs text-foreground-subtle">
                            {formatRelative(o.createdAt)}
                          </span>
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-foreground-muted">
                        {o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* Bookings */}
            <Section icon={CalendarCheck} title={`Bookings (${data?.bookings.length ?? 0})`}>
              {(data?.bookings.length ?? 0) === 0 ? (
                <p className="text-xs text-foreground-subtle">No bookings yet.</p>
              ) : (
                <ul className="space-y-2">
                  {data!.bookings.map((b) => (
                    <li key={b.id} className="rounded-lg border border-border p-2.5 text-sm">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-foreground-subtle">
                          {b.appointmentAt
                            ? new Date(b.appointmentAt).toLocaleString()
                            : `Requested ${formatRelative(b.createdAt)}`}
                        </span>
                        <Badge variant="outline">{b.status}</Badge>
                      </div>
                      {/* The actual answers the customer gave (name, preferred
                          date, …). This is the real content of the booking. */}
                      {b.fields.length > 0 ? (
                        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-0.5 text-xs">
                          {b.fields.map((f) => (
                            <div key={f.label} className="contents">
                              <dt className="truncate text-foreground-subtle">{f.label}</dt>
                              <dd className="break-words text-foreground">{f.value}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <p className="text-xs text-foreground-subtle">No details captured.</p>
                      )}
                      {b.notes ? (
                        <p className="mt-1 text-xs text-foreground-muted">{b.notes}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* Activity */}
            <Section icon={Clock} title="Activity">
              <p className="text-sm text-foreground">
                <span className="font-semibold">{data?.stats.inboundCount ?? 0}</span> received ·{' '}
                <span className="font-semibold">{data?.stats.outboundCount ?? 0}</span> sent
              </p>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
