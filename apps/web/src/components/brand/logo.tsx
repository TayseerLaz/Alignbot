import { cn } from '@/lib/utils';

/**
 * AlignedLogo — single source of truth for the Hader AI brand mark.
 *
 * Component name is kept as `AlignedLogo` so the dozen-or-so imports
 * around the app don't need touching. Renders the Hader wordmark
 * (Fraunces serif) + small-caps "AI" subscript, in oxblood on light
 * surfaces and cream on dark.
 *
 * `iconOnly` (collapsed sidebar): oxblood rounded square with "H" —
 * a wordmark can't crop cleanly into 36×36 so we drop to the monogram.
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
        aria-label="Hader AI"
        style={{ fontFamily: 'var(--font-serif)' }}
      >
        H
      </div>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-baseline gap-1.5 text-brand-500 dark:text-brand-700',
        className,
      )}
      aria-label="Hader AI"
    >
      <span
        className="text-[26px] font-medium leading-none tracking-[-0.02em]"
        style={{ fontFamily: 'var(--font-serif)' }}
      >
        Hader
      </span>
      <span
        className="rounded-sm bg-brand-500 px-1 py-[1px] text-[10px] font-semibold uppercase leading-none tracking-[0.18em] text-white dark:bg-brand-700 dark:text-brand-100"
      >
        AI
      </span>
    </span>
  );
}
