'use client';

import {
  BROADCAST_STATUS_LABELS,
  type BroadcastDto,
  type BroadcastStatus,
} from '@aligned/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

const STATUS_CLASS: Record<BroadcastStatus, string> = {
  draft: 'bg-slate-100 text-slate-600',
  scheduled: 'bg-amber-50 text-amber-700',
  sending: 'bg-blue-50 text-blue-700',
  paused: 'bg-yellow-50 text-yellow-700',
  completed: 'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-slate-100 text-slate-500',
  failed: 'bg-red-50 text-red-700',
};

export default function BroadcastsPage() {
  const broadcastsQuery = useQuery({
    queryKey: ['broadcasts'],
    queryFn: () =>
      api.get<{ data: BroadcastDto[]; nextCursor: string | null }>('/api/v1/broadcasts'),
    refetchInterval: 5000, // live counters
  });

  const total = broadcastsQuery.data?.data.length ?? 0;

  return (
    <>
      <PageHeader
        title="Broadcasts"
        description="Send WhatsApp template messages to a list of contacts. Schedule, A/B test, and watch delivery in real time."
        actions={
          <Link href="/broadcasts/new">
            <Button>
              <Plus className="size-4" /> New broadcast
            </Button>
          </Link>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>{total} broadcast{total === 1 ? '' : 's'}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-6 py-3">Name</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Audience</th>
                  <th className="px-6 py-3">Sent / Delivered / Read</th>
                  <th className="px-6 py-3">Scheduled</th>
                  <th className="w-20 px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {broadcastsQuery.isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-8 text-center text-foreground-muted">
                      Loading…
                    </td>
                  </tr>
                ) : null}
                {broadcastsQuery.data?.data.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-foreground-muted">
                      No broadcasts yet. Create your first one to start reaching customers.
                    </td>
                  </tr>
                ) : null}
                {broadcastsQuery.data?.data.map((b) => (
                  <tr key={b.id} className="border-b border-border last:border-0">
                    <td className="px-6 py-4 font-medium">
                      <Link href={`/broadcasts/${b.id}`} className="hover:underline">
                        {b.name}
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[b.status]}`}
                      >
                        {BROADCAST_STATUS_LABELS[b.status]}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-foreground-muted">
                      {b.audienceKind === 'csv'
                        ? 'CSV'
                        : b.audienceKind === 'segment'
                          ? 'Segment'
                          : 'Manual'}
                      {' · '}
                      <span className="font-mono text-xs">{b.totalRecipients}</span>
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-foreground-muted">
                      {b.sentCount} / {b.deliveredCount} / {b.readCount}
                      {b.failedCount > 0 ? (
                        <span className="ml-2 text-red-600">· {b.failedCount} failed</span>
                      ) : null}
                    </td>
                    <td className="px-6 py-4 text-foreground-muted">
                      {b.scheduledFor
                        ? new Date(b.scheduledFor).toLocaleString()
                        : b.startedAt
                          ? new Date(b.startedAt).toLocaleString()
                          : '—'}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link href={`/broadcasts/${b.id}`}>
                        <Button variant="ghost" size="sm">
                          Open
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
