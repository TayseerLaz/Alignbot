import { cn } from '@/lib/utils';

/**
 * AlignedLogo — single source of truth for the brand mark.
 *
 * Uses plain <img> rather than next/image because the new light-mode
 * wordmark has an extreme aspect ratio (5.95:1) which kept hitting
 * width/height auto-sizing edge cases in next/image. <img> with
 * explicit width attributes is the simplest path that "just works"
 * on every viewport.
 *
 *   - /aligned-logo-light-v2.png  → black wordmark (light mode)
 *   - /aligned-logo.webp          → white wordmark (dark mode)
 *
 * `iconOnly` (collapsed sidebar): brand-blue rounded square with "A"
 * since the wide lockup can't crop cleanly into 36×36.
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
    <span
      className={cn('inline-flex items-center', className)}
      style={{ height: 36 }}
      aria-label="ALIGNED"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/aligned-logo-light-v2.png"
        alt="ALIGNED Business Platform"
        height={36}
        // Native aspect ratio = 4880/820 ≈ 5.95, so at height=36
        // the rendered width is ~214 px which fits the 256 px sidebar
        // header (256 − 40 px horizontal padding = 216 px content).
        style={{ height: 36, width: 'auto' }}
        className="block dark:hidden"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/aligned-logo.webp"
        alt="ALIGNED Business Platform"
        height={32}
        style={{ height: 32, width: 'auto' }}
        className="hidden dark:block"
      />
    </span>
  );
}
