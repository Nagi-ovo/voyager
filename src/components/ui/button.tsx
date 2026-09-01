import * as React from 'react';

import { type VariantProps, cva } from 'class-variance-authority';

import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 relative overflow-hidden',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow hover:bg-primary/90 before:absolute before:inset-1/2 before:h-0 before:w-0 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-white/30 before:transition-all before:duration-500 active:before:h-full active:before:w-full active:before:duration-0',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 before:absolute before:inset-1/2 before:h-0 before:w-0 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-white/30 before:transition-all before:duration-500 active:before:h-full active:before:w-full active:before:duration-0',
        outline:
          'border border-input bg-card hover:bg-accent hover:text-accent-foreground shadow-sm before:absolute before:inset-1/2 before:h-0 before:w-0 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-primary/10 before:transition-all before:duration-500 active:before:h-full active:before:w-full active:before:duration-0',
        secondary:
          'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 before:absolute before:inset-1/2 before:h-0 before:w-0 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-primary/20 before:transition-all before:duration-500 active:before:h-full active:before:w-full active:before:duration-0',
        ghost:
          'hover:bg-accent hover:text-accent-foreground before:absolute before:inset-1/2 before:h-0 before:w-0 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-primary/10 before:transition-all before:duration-500 active:before:h-full active:before:w-full active:before:duration-0',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, children, ...props }, ref) => {
    return (
      <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props}>
        <span className="relative z-10 inline-flex items-center justify-center gap-[inherit]">
          {children}
        </span>
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
