'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Filter, MessageSquare, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api';

const STATUSES = ['new', 'confirmed', 'completed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];

interface BookingAnswer {
  key: string;
  label: string;
  type: string;
  required: boolean;
  value: string | number | boolean | null;
}

interface Booking {
  id: string;
  threadId: string | null;
  customerPhone: string;
  customerName: string | null;
  fields: BookingAnswer[];
  status: Status;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

function StatusBadge({ status }: { status: Status }) {
  const tone: Record<Status, 'default' | 'muted' | 'success' | 'danger'> = {
    new: 'default',
    confirmed: 'success',
    completed: 'muted',
    cancelled: 'danger',
  };
  return <Badge variant={tone[status]}>{status}</Badge>;
}

// ---------- Date / time extraction --------------------------------------
// The booking form can capture appointment date + time as answer fields.
// Pull them out so we can render them in dedicated columns and avoid
// repeating them inside the Answers cell. Two strategies:
//   1. Field type matches 'date' / 'time' / 'datetime' / 'datetime-local'.
//   2. Field key/label contains 'date' or 'time' (case-insensitive).
// If neither matches, fall back to the booking's createdAt timestamp.
function pickAppointment(fields: BookingAnswer[]): {
  dateFieldKey: string | null;
  timeFieldKey: string | null;
  dateRaw: string | null;
  timeRaw: string | null;
} {
  const findByType = (...types: string[]) =>
    fields.find((f) => types.includes(f.type.toLowerCase()));
  const findByText = (needle: string) =>
    fields.find(
      (f) =>
        f.key.toLowerCase().includes(needle) || f.label.toLowerCase().includes(needle),
    );

  // Datetime (single combined field) — split it.
  const dt = findByType('datetime', 'datetime-local') ?? findByText('datetime');
  if (dt && typeof dt.value === 'string' && dt.value) {
    const [d, t] = dt.value.split(/[T\s]/);
    return { dateFieldKey: dt.key, timeFieldKey: dt.key, dateRaw: d ?? null, timeRaw: t ?? null };
  }

  const dateField = findByType('date') ?? findByText('date');
  const timeField = findByType('time') ?? findByText('time');
  return {
    dateFieldKey: dateField?.key ?? null,
    timeFieldKey: timeField?.key ?? null,
    dateRaw:
      typeof dateField?.value === 'string' && dateField.value ? dateField.value : null,
    timeRaw:
      typeof timeField?.value === 'string' && timeField.value ? timeField.value : null,
  };
}

// Format a YYYY-MM-DD string as "Mon, 12 May" (or with the year if not
// current year). Always weekday + day + month — no "tomorrow", no relative.
function formatBookingDate(iso: string | null, fallback: Date): string {
  const d = iso ? new Date(iso) : fallback;
  if (Number.isNaN(d.getTime())) return iso ?? '';
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
  return fmt.format(d);
}

// Format an HH:MM (or HH:MM:SS) string, or pull H/M from a Date.
function formatBookingTime(raw: string | null, fallback: Date): string {
  if (raw) {
    // Strip any trailing seconds; render as HH:MM 24-hour for clarity.
    const m = raw.match(/^(\d{1,2}):(\d{2})/);
    if (m) return `${m[1]!.padStart(2, '0')}:${m[2]}`;
  }
  const d = fallback;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export default function BookingsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useMemo(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useQuery({
    queryKey: ['bookings', statusFilter, debouncedSearch],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (debouncedSearch) params.set('q', debouncedSearch);
      params.set('limit', '100');
      return api.get<{ data: Booking[] }>(`/api/v1/bookings?${params.toString()}`);
    },
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Status }) =>
      api.patch(`/api/v1/bookings/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bookings'] });
      toast.success('Status updated');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/bookings/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bookings'] });
      toast.success('Booking deleted');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });

  const rows = list.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Bookings"
        description="Customer intakes captured by the AI chatbot. Configure the form on /business-info → Booking form."
      />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <CalendarCheck className="size-4 text-brand-600" />
            {rows.length} bookings
          </CardTitle>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search phone, name, notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64"
            />
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as Status | 'all')}>
              <SelectTrigger className="w-40">
                <Filter className="mr-2 size-3.5" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-foreground-subtle">
              <tr>
                <th className="px-6 py-3">Date</th>
                <th className="px-6 py-3">Time</th>
                <th className="px-6 py-3">Customer</th>
                <th className="px-6 py-3">Answers</th>
                <th className="px-6 py-3">Status</th>
                <th className="w-32 px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-foreground-muted">
                    Loading…
                  </td>
                </tr>
              ) : null}
              {!list.isLoading && rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-16 text-center text-foreground-muted">
                    No bookings yet. When a customer asks the bot to book something, the captured
                    answers will appear here.
                  </td>
                </tr>
              ) : null}
              {rows.map((b) => {
                const created = new Date(b.createdAt);
                const apt = pickAppointment(b.fields);
                const dateLabel = formatBookingDate(apt.dateRaw, created);
                const timeLabel = formatBookingTime(apt.timeRaw, created);
                // Hide the date/time fields from the Answers cell since we
                // surface them in their own columns now.
                const otherFields = b.fields.filter(
                  (f) => f.key !== apt.dateFieldKey && f.key !== apt.timeFieldKey,
                );
                return (
                <tr key={b.id} className="border-b border-border last:border-0 align-top">
                  <td className="whitespace-nowrap px-6 py-4 text-sm font-medium">
                    {dateLabel}
                    {!apt.dateRaw ? (
                      <div className="text-[10px] font-normal text-foreground-subtle">
                        captured
                      </div>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 font-mono text-sm">
                    {timeLabel}
                  </td>
                  <td className="px-6 py-4">
                    <div className="font-medium">{b.customerName ?? b.customerPhone}</div>
                    <div className="font-mono text-[11px] text-foreground-subtle">
                      {b.customerPhone}
                    </div>
                    {b.threadId ? (
                      <Link
                        href={`/inbox?thread=${b.threadId}`}
                        className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline"
                      >
                        <MessageSquare className="size-3" /> View chat
                      </Link>
                    ) : null}
                  </td>
                  <td className="px-6 py-4">
                    {otherFields.length > 0 ? (
                      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                        {otherFields.map((f) => (
                          <div key={f.key} className="text-xs">
                            <dt className="font-semibold text-foreground-subtle">{f.label}</dt>
                            <dd className="text-foreground">
                              {f.value === null || f.value === '' ? (
                                <span className="italic text-foreground-subtle">(empty)</span>
                              ) : (
                                String(f.value)
                              )}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <span className="text-xs italic text-foreground-subtle">
                        (no extra fields)
                      </span>
                    )}
                    {b.notes ? (
                      <p className="mt-2 text-xs italic text-foreground-muted">{b.notes}</p>
                    ) : null}
                  </td>
                  <td className="px-6 py-4">
                    <Select
                      value={b.status}
                      onValueChange={(v) => setStatus.mutate({ id: b.id, status: v as Status })}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue>{<StatusBadge status={b.status} />}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Delete booking"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete booking from ${b.customerName ?? b.customerPhone}?`,
                          )
                        ) {
                          remove.mutate(b.id);
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}
