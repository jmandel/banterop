import React from 'react';

type Variant = 'neutral' | 'success' | 'warning' | 'danger';
type Props = {
  children: React.ReactNode;
  variant?: Variant;
  className?: string;
  as?: 'span' | 'button';
} & (React.HTMLAttributes<HTMLSpanElement> | React.ButtonHTMLAttributes<HTMLButtonElement>);

export function Badge({ children, variant = 'neutral', className = '', as = 'span', ...rest }: Props) {
  const base = 'inline-flex items-center gap-2 px-2 py-1 rounded-full text-xs border';
  const look = {
    neutral: 'bg-panel border-border text-muted',
    success: 'bg-panel border-success text-success',
    warning: 'bg-panel border-warning text-warning',
    danger: 'bg-panel border-danger text-danger',
  }[variant];
  const cls = `${base} ${look} ${className}`;
  if (as === 'button') {
    const Btn = 'button' as any;
    return <Btn className={cls} {...(rest as any)}>{children}</Btn>;
  }
  const Span = 'span' as any;
  return <Span className={cls} {...(rest as any)}>{children}</Span>;
}
