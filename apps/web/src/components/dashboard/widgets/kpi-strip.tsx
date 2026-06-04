'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Plus, X } from 'lucide-react';
import Link from 'next/link';

import { Card, CardContent } from '@/components/ui/card';
import { getKpiStrip, type KpiTile } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';
import { cn } from '@/lib/utils';

import { useEditMode } from '../edit-mode-context';

// The KPI strip is one logical widget but four visual tiles. Treating
// it as one widget keeps the ADD/KEEP UX coherent — "I want the counts
// row" is one decision, not four. Individual tile actions (ADD link
// on Contacts, etc.) still ride on each tile.

const KPI_QUERY_KEY = ['dashboard', 'kpi-strip'] as const;

export function KpiStripWidget() {
  const { editing, layout } = useEditMode();
  const q = useQuery({
    queryKey: KPI_QUERY_KEY,
    queryFn: getKpiStrip,
    staleTime: 30_000,
  });

  if (q.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="h-[124px] animate-pulse" />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="rounded-md bg-red-50 p-3 text-xs text-red-700">
        Could not load key counts. <button onClick={() => q.refetch()} className="underline">Retry</button>
      </div>
    );
  }
  const tiles = q.data?.tiles ?? [];

  return (
    <div className="relative">
      {editing ? (
        <button
          type="button"
          onClick={() => layout.remove('kpi-strip')}
          className="absolute -top-2 right-0 z-10 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 transition hover:bg-emerald-200"
          aria-label="Remove key counts strip"
          title="Remove from dashboard"
        >
          KEEP <X className="size-3" aria-hidden />
        </button>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <KpiTileCard key={t.id} tile={t} />
        ))}
      </div>
    </div>
  );
}

function KpiTileCard({ tile }: { tile: KpiTile }) {
  return (
    <Link
      href={tile.href}
      aria-label={`${tile.label}: ${tile.value}. ${tile.subtext}.`}
      className="group block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <Card className="h-full transition-shadow group-hover:shadow-lg">
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wider text-foreground-subtle">
              {tile.label}
            </p>
            {tile.action ? (
              <Link
                href={tile.action.href}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-500 transition hover:bg-brand-100"
                aria-label={`${tile.action.label} ${tile.label.toLowerCase()}`}
              >
                <Plus className="size-3" aria-hidden /> {tile.action.label}
              </Link>
            ) : null}
          </div>
          <p className="mt-2 text-3xl font-semibold tracking-tight" aria-hidden>
            {formatThousands(tile.value)}
          </p>
          <p
            className={cn(
              'mt-1 flex items-center gap-1 text-xs',
              tile.subtextTone === 'warning'
                ? 'text-amber-700'
                : tile.subtextTone === 'success'
                  ? 'text-emerald-700'
                  : 'text-foreground-subtle',
            )}
          >
            {/* Non-color cue so the warning/success state still reads
                in monochrome / for users with red-green CVD. */}
            <span aria-hidden>
              {tile.subtextTone === 'warning' ? '!' : tile.subtextTone === 'success' ? '✓' : '·'}
            </span>
            {tile.subtext}
            <ArrowUpRight className="ml-auto size-3 text-foreground-subtle transition group-hover:text-foreground" />
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
