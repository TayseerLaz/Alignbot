'use client';

import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { getOutreachCampaigns } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';

import { LiveDot, WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

export function OutreachCampaignsWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'outreach'],
    queryFn: getOutreachCampaigns,
    // Live numbers while sending: poll every 10s. When no campaign is
    // active this is overkill but it's a single small request, so the
    // simplicity beats branching the interval on status.
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  return (
    <WidgetFrame id="outreach" title="Outreach & campaigns" icon={Send} accent="blue">
      {q.isLoading ? (
        <WidgetSkeleton rows={3} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data?.active ? (
        <WidgetEmpty
          title="No campaign running."
          hint="Send a one-off message to a list of contacts."
          action={
            <Button asChild size="sm">
              <Link href="/broadcasts/new">Create broadcast</Link>
            </Button>
          }
        />
      ) : (
        <Link
          href={`/broadcasts/${q.data.active.id}`}
          className="block rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-label={`Open ${q.data.active.name} campaign`}
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              {q.data.active.status === 'sending' ? <LiveDot /> : null}
              <span className="font-medium">&ldquo;{q.data.active.name}&rdquo; broadcast</span>
              <span className="text-foreground-subtle">— {statusLabel(q.data.active.status)}</span>
            </div>
            <div className="grid grid-cols-1 min-[400px]:grid-cols-3 gap-2 rounded-md bg-surface-muted/60 p-3 text-center">
              <FunnelStat label="Sent" value={formatThousands(q.data.active.sent)} />
              <FunnelStat label="Delivered" value={formatThousands(q.data.active.delivered)} />
              <FunnelStat
                label="Read"
                value={formatThousands(q.data.active.read)}
                emphasised
              />
            </div>
          </div>
        </Link>
      )}
    </WidgetFrame>
  );
}

function statusLabel(s: string): string {
  switch (s) {
    case 'sending':
      return 'sending live';
    case 'paused':
      return 'paused';
    case 'completed':
      return 'completed';
    default:
      return s;
  }
}

function FunnelStat({ label, value, emphasised }: { label: string; value: string; emphasised?: boolean }) {
  return (
    <div>
      <p className={`text-xl font-semibold ${emphasised ? 'text-emerald-700' : 'text-foreground'}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">{label}</p>
    </div>
  );
}
