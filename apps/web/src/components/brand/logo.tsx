import { cn } from '@/lib/utils';

/**
 * AlignedLogo — Hader AI brand mark + wordmark.
 *
 * Component name is kept as `AlignedLogo` so the dozen-or-so imports
 * around the app don't need touching. Both variants render the source
 * PNGs through CSS mask-image so the actual fill is `currentColor` —
 * the parent's text color decides whether the mark reads as oxblood
 * (light surface), cream (dark hero), or anything else context-driven.
 *
 *   iconOnly = true  → /hader-icon.png        (chat-bubble-E mark)
 *   iconOnly = false → /hader-wordmark.png    (mark + "Hader AI" text)
 *
 * Native aspect ratios:
 *   icon:     2695  × 2702  ≈ 1:1
 *   wordmark: 6452  × 1272  ≈ 5.07:1
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
      <span
        role="img"
        aria-label="Hader AI"
        className={cn('inline-block size-9 shrink-0 text-brand-500', className)}
        style={{
          backgroundColor: 'currentColor',
          WebkitMaskImage: 'url(/hader-icon.png)',
          maskImage: 'url(/hader-icon.png)',
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
        }}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label="Hader AI"
      className={cn('inline-block text-brand-500', className)}
      style={{
        // 5.07:1 aspect, default height 36 → ~183px wide. Caller can
        // override either dimension via Tailwind classes (h-7, h-10, …)
        // and the aspect-ratio keeps the wordmark from squishing.
        height: 36,
        aspectRatio: '6452 / 1272',
        backgroundColor: 'currentColor',
        WebkitMaskImage: 'url(/hader-wordmark.png)',
        maskImage: 'url(/hader-wordmark.png)',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'left center',
        maskPosition: 'left center',
      }}
    />
  );
}
