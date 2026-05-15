import Image from 'next/image';

import { cn } from '@/lib/utils';

/**
 * AlignedLogo — single source of truth for the brand mark.
 *
 * The asset (/public/aligned-logo.webp) is a white wordmark on a transparent
 * background. On its own it disappears against a white sidebar in light mode,
 * so we tint it:
 *   - Light mode  → `filter: brightness(0)`              (black silhouette)
 *   - Dark mode   → `filter: brightness(0) invert(1)`    (back to white)
 * Both states render clearly on the surface color underneath.
 *
 * `iconOnly` (collapsed sidebar): we can't crop the wide horizontal lockup
 * into a square cleanly, so we render a brand-blue rounded square with "A".
 * Keeps the look on-brand without needing a second asset.
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
    <Image
      src="/aligned-logo.webp"
      alt="ALIGNED Business Platform"
      width={160}
      height={32}
      priority
      className={cn(
        'h-8 w-auto',
        // Tint the white asset so it reads on whatever background.
        '[filter:brightness(0)]',
        'dark:[filter:brightness(0)_invert(1)]',
        className,
      )}
    />
  );
}
