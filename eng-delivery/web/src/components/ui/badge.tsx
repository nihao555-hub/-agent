import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// 极小号、宽字距的胶囊标签，颜色取自 minimalist-ui 的低饱和暖色板。
const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider',
  {
    variants: {
      variant: {
        default: 'bg-muted text-muted-foreground',
        outline: 'border border-border text-muted-foreground',
        red: 'bg-[#FDEBEC] text-[#9F2F2D]',
        blue: 'bg-[#E1F3FE] text-[#1F6C9F]',
        green: 'bg-[#EDF3EC] text-[#346538]',
        yellow: 'bg-[#FBF3DB] text-[#956400]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
