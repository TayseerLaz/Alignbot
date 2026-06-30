'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle } from 'lucide-react';

import { getAiBudgetToday } from '@/lib/dashboard-api';

// Prominent banner at the top of the dashboard when the org's DAILY AI-token
// budget is running out. The daily token cap is what PAUSES the bot's automatic
// replies — so this is the alert the operator must not miss. Amber at 80% (a
// heads-up before it pauses), big red at 100% (replies are paused). Shares the
// 'ai-budget' query cache with the widget, so no extra request.
export function AiBudgetBanner() {
  const q = useQuery({
    queryKey: ['dashboard', 'ai-budget'],
    queryFn: getAiBudgetToday,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const d = q.data;
  if (!d || d.unlimited) return null;
  const pct = Math.min(100, Math.max(0, Math.round(d.percentUsed)));
  if (pct < 80) return null;

  const paused = pct >= 100;
  return (
    <div
      role="alert"
      className={
        paused
          ? 'flex items-start gap-3 rounded-lg border-2 border-red-500 bg-red-50 px-4 py-3 text-red-900 dark:bg-red-950/40 dark:text-red-200'
          : 'flex items-start gap-3 rounded-lg border-2 border-amber-400 bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
      }
    >
      {paused ? (
        <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
      ) : (
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          {paused
            ? 'AI replies are paused — you’ve reached today’s AI limit (100%)'
            : `Heads up — your bot has used ${pct}% of today’s AI allowance`}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed">
          {paused
            ? 'The bot has stopped replying automatically. Reply to customers manually from the Inbox — automatic replies resume tomorrow. Contact ALIGNED if you need a higher daily limit.'
            : 'When usage reaches 100%, the bot stops replying automatically until tomorrow. Keep an eye on it, or contact ALIGNED to raise your limit.'}
        </p>
      </div>
    </div>
  );
}
