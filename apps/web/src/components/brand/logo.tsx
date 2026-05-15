import Image from 'next/image';

import { cn } from '@/lib/utils';

/**
 * AlignedLogo — single source of truth for the brand mark.
 *
 * - Full lockup (`iconOnly=false`): wide horizontal logo for top bars and
 *   sidebars at their expanded width.
 * - Icon-only (`iconOnly=true`): a square crop of the same image for the
 *   collapsed sidebar. Kept as the same asset to avoid serving two files;
 *   the right portion of the lockup is clipped via object-cover + width.
 *
 * The asset auto-inverts on dark mode via a CSS filter — the logo is a
 * blue-on-transparent mark, so `brightness(0) invert(1)` flips it to
 * white on dark backgrounds without needing a second asset.
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
          'relative size-9 overflow-hidden rounded-md',
          className,
        )}
        aria-label="ALIGNED"
      >
        <Image
          src="/aligned-logo.webp"
          alt="ALIGNED"
          fill
          priority
          sizes="36px"
          className="object-contain object-left dark:[filter:brightness(0)_invert(1)]"
          style={{ objectPosition: 'left center' }}
        />
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
      className={cn('h-8 w-auto dark:[filter:brightness(0)_invert(1)]', className)}
    />
  );
}
