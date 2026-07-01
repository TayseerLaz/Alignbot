'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle } from 'lucide-react';

import { getWalletOverview } from '@/lib/dashboard-api';
import { useSession } from '@/lib/session';

// Prominent banner at the top of the dashboard when the tenant's prepaid
// WhatsApp balance is running out. At 0 messages the bot + broadcasts stop
// sending, so this is the alert the operator must not miss. It goes solid red
// and pulsates when the balance is empty, amber when running low. Shares the
// 'billing'/'overview' query cache with the wallet widget + banner, so no extra
// request.
export function WalletBalanceBanner() {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ['billing', 'overview'],
    queryFn: getWalletOverview,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const d = q.data;

  // No WhatsApp for this tenant → no prepaid balance to warn about.
  if (session?.organization?.disabledFeatures?.includes('whatsapp')) return null;
  if (!d || !d.metered) return null;

  const paused = d.messagesRemaining === 0;
  // "Running low" trigger: at or below the configured threshold, or below the
  // cost of ~50 messages (whichever is higher).
  const lowFloorMicros = Math.max(
    d.lowBalanceThresholdMicros,
    d.pricePerMessageMicros * 50,
  );
  const low = !paused && d.availableMicros <= lowFloorMicros;

  if (!paused && !low) return null;

  return (
    <div
      role="alert"
      className={[
        'flex items-start gap-3 rounded-lg border-2 px-4 py-3',
        paused
          ? 'border-red-500 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200 animate-pulse'
          : 'border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
      ].join(' ')}
    >
      {paused ? (
        <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
      ) : (
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          {paused
            ? 'WhatsApp sending is paused — your balance is empty. Contact ALIGNED to top up.'
            : `WhatsApp balance running low — about ${d.messagesRemaining.toLocaleString()} messages left.`}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed">
          {paused
            ? 'Bot replies and broadcasts have stopped until you top up. Contact your account manager to add balance.'
            : 'When the balance runs out, bot replies and broadcasts stop sending. Contact ALIGNED to top up.'}
        </p>
      </div>
    </div>
  );
}
