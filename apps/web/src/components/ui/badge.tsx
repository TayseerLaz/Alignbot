import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

// Aligned design system — pill badges with semantic warm-palette colors.
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold tracking-[-0.005em]',
  {
    variants: {
      variant: {
        default: 'bg-brand-100 text-brand-700',
        muted: 'bg-surface-muted text-foreground-muted',
        success: 'bg-success-100 text-success',
        warning: 'bg-warning-100 text-warning',
        danger: 'bg-danger-100 text-danger',
        coral: 'bg-coral-100 text-coral-700',
        info: 'bg-info-100 text-info',
        outline: 'border border-border-strong text-foreground-muted',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
