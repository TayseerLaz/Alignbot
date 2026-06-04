'use client';

import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';

import { getAiBudgetToday } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';
import { cn } from '@/lib/utils';

import { WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

export function AiBudgetWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'ai-budget'],
    queryFn: getAiBudgetToday,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return (
    <WidgetFrame
      id="ai-budget"
      title="AI chatbot budget · today"
      icon={Sparkles}
      accent="green"
      headerExtra={
        <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">RESETS DAILY</span>
      }
    >
      {q.isLoading ? (
        <WidgetSkeleton rows={2} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data ? null : (
        <Body data={q.data} />
      )}
    </WidgetFrame>
  );
}

function Body({ data }: { data: NonNullable<ReturnType<typeof useQuery<Awaited<ReturnType<typeof getAiBudgetToday>>>>['data']> }) {
  const isUnlimited = data.plan === 'Unlimited';
  const percentUsed = isUnlimited ? 0 : Math.min(100, Math.round((data.used / data.limit) * 100));

  // Threshold logic per spec: amber at 80%, red at 95%. Unlimited stays
  // green (with a faint indicative fill).
  const barColour = isUnlimited
    ? 'bg-emerald-500'
    : percentUsed >= 95
      ? 'bg-red-500'
      : percentUsed >= 80
        ? 'bg-amber-500'
        : 'bg-emerald-500';
  const indicativeFill = isUnlimited ? 18 : percentUsed;

  return (
    <div className="space-y-3">
      <p className="text-3xl font-semibold leading-tight">{data.plan}</p>
      <p className="text-xs text-foreground-muted">
        {formatThousands(data.used)} tokens
        <span className="mx-1 text-foreground-subtle">·</span>
        <span className="font-medium">${data.estCostUsd.toFixed(3)}</span>
      </p>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={isUnlimited ? 0 : 100}
        aria-valuenow={isUnlimited ? undefined : percentUsed}
        aria-label={isUnlimited ? 'Unlimited plan — indicative usage only' : `${percentUsed}% of daily cap used`}
      >
        <div
          className={cn('h-full transition-all', barColour)}
          style={{ width: `${indicativeFill}%`, opacity: isUnlimited ? 0.5 : 1 }}
        />
      </div>
      {!isUnlimited ? (
        <p className="text-xs text-foreground-subtle">
          {percentUsed}% of {formatThousands(data.limit)} daily tokens
        </p>
      ) : null}
    </div>
  );
}
