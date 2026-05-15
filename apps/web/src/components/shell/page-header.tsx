import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    // Spacing below the header is now provided by app-shell's `space-y-6`
    // wrapper, so PageHeader no longer adds its own mb-* (avoids the
    // header sitting too far from the first card).
    <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="space-y-1.5">
        <h1 className="text-[28px] font-bold leading-tight tracking-[-0.025em]">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-foreground-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
