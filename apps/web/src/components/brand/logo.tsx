import { cn } from '@/lib/utils';

export function AlignedLogo({
  className,
  variant = 'default',
  iconOnly = false,
}: {
  className?: string;
  variant?: 'default' | 'mono';
  iconOnly?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        aria-hidden
        className={cn(
          'flex size-8 items-center justify-center rounded-md font-semibold text-white',
          variant === 'default' ? 'bg-brand-500' : 'bg-foreground',
        )}
      >
        A
      </div>
      {iconOnly ? null : (
        <div className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight">ALIGNED</span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-foreground-subtle">
            Business Platform
          </span>
        </div>
      )}
    </div>
  );
}
