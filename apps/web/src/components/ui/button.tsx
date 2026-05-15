import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

// Aligned design system — pill buttons with soft purple-tinted shadow.
// Variants map to the .al-btn-* set in tokens. Brand uses lavender
// (var(--color-brand-500)) + var(--shadow-brand) glow; coral is for
// secondary CTAs and accent actions like Send broadcast / Send template.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold text-sm tracking-[-0.005em] ring-offset-background transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700 shadow-brand',
        secondary:
          'bg-white text-foreground border border-border-strong hover:bg-surface-muted',
        ghost: 'text-foreground hover:bg-surface-muted',
        soft: 'bg-brand-100 text-brand-700 hover:bg-brand-200',
        coral:
          'bg-coral-500 text-white hover:bg-coral-600 shadow-coral',
        dark: 'bg-[#1a1828] text-white hover:bg-[#2e2a40]',
        danger: 'bg-danger text-white hover:bg-danger/90 shadow-sm',
        link: 'text-brand-500 underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3.5 text-xs',
        md: 'h-10 px-5',
        lg: 'h-12 px-6 text-[15px]',
        icon: 'h-10 w-10 p-0 rounded-full',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, disabled, children, ...props }, ref) => {
    if (asChild) {
      return (
        <Slot
          ref={ref}
          className={cn(buttonVariants({ variant, size }), className)}
          {...props}
        >
          {children}
        </Slot>
      );
    }
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';
