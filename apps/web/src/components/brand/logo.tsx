import Image from 'next/image';

import { cn } from '@/lib/utils';

/**
 * AlignedLogo — single source of truth for the brand mark.
 *
 * Two raw assets, one per theme, so no CSS filter trickery is needed:
 *   - /aligned-logo-light.png  → dark wordmark on transparent (light mode)
 *   - /aligned-logo.webp       → white wordmark on transparent (dark mode)
 *
 * Both are loaded; we toggle visibility via Tailwind's `dark:` variant
 * so SSR/CSR don't mismatch and there's no first-paint swap.
 *
 * `iconOnly` (collapsed sidebar): we render a brand-blue rounded square
 * with "A" since the wide lockup can't crop cleanly into 36×36.
 */
export function AlignedLogo({
  className,
  iconOnly = false,
}: {
  className?: string;
  variant?: 'default' | 'mono';
  iconOnly?: boolean;
}) {
  if (iconOnly) {
    return (
      <div
        className={cn(
          'flex size-9 items-center justify-center rounded-md bg-brand-500 font-semibold text-white shadow-sm',
          className,
        )}
        aria-label="ALIGNED"
      >
        A
      </div>
    );
  }

  return (
    <span className={cn('inline-flex h-8 items-center', className)} aria-label="ALIGNED">
      {/* Light-mode wordmark — 4880×820 PNG; intrinsic dimensions match
          so Next.js Image picks the right srcset for retina renders. */}
      <Image
        src="/aligned-logo-light.png"
        alt="ALIGNED Business Platform"
        width={488}
        height={82}
        priority
        className="block h-8 w-auto dark:hidden"
      />
      {/* Dark-mode wordmark — same shape, white-on-transparent. */}
      <Image
        src="/aligned-logo.webp"
        alt="ALIGNED Business Platform"
        width={200}
        height={40}
        priority
        className="hidden h-8 w-auto dark:block"
      />
    </span>
  );
}
