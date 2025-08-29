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
    neutral: 'bg-[color:var(--panel)] border-[color:var(--border)] text-[color:var(--muted)]',
    success: 'bg-[color:var(--panel)] border-[color:var(--success)] text-[color:var(--success)]',
    warning: 'bg-[color:var(--panel)] border-[color:var(--warning)] text-[color:var(--warning)]',
    danger: 'bg-[color:var(--panel)] border-[color:var(--danger)] text-[color:var(--danger)]',
  }[variant];
  const cls = `${base} ${look} ${className}`;
  if (as === 'button') {
    const Btn = 'button' as any;
    return <Btn className={cls} {...(rest as any)}>{children}</Btn>;
  }
  const Span = 'span' as any;
  return <Span className={cls} {...(rest as any)}>{children}</Span>;
}

