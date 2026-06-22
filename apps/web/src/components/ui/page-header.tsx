import { Breadcrumbs, type Crumb } from './breadcrumbs';
import { cn } from '@/lib/utils';

// Standard page header — breadcrumb + title (+ optional description) on the
// left, primary actions on the right. One consistent, compact top for every
// screen, so pages stop inventing their own spacing (a big source of the
// "big gaps" feel).
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumbs?: Crumb[];
  actions?: React.ReactNode;
  className?: string;
  /** Optional row below the header (filters, tabs, segmented control). */
  children?: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {breadcrumbs && breadcrumbs.length > 0 ? <Breadcrumbs items={breadcrumbs} /> : null}
          <h1 className="truncate text-xl font-semibold tracking-[-0.02em] text-foreground">{title}</h1>
          {description ? (
            <p className="max-w-2xl text-sm text-foreground-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
