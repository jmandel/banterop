import React from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

type ButtonProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType<any>; // polymorphic element (e.g., 'a', 'label')
  variant?: Variant;
  size?: Size;
  className?: string;
  disabled?: boolean;
};

export function Button({ as = 'button', variant = 'primary', size = 'md', className = '', ...props }: ButtonProps) {
  const Comp: any = as;
  const base = 'inline-flex items-center justify-center gap-2 rounded-2xl font-medium disabled:opacity-50';
  const sizes: Record<Size, string> = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-2 text-sm',
    lg: 'px-4 py-2.5 text-base',
  };
  const look = (
    {
      primary: 'bg-[color:var(--primary)] text-[color:var(--primary-foreground)] hover:opacity-90',
      secondary: 'border border-[color:var(--border)] bg-[color:var(--panel)] hover:bg-gray-50',
      danger: 'bg-[color:var(--danger)] text-white hover:opacity-90',
      ghost: 'text-[color:var(--muted)] hover:bg-gray-50',
    } as const
  )[variant];
  const typeProps = Comp === 'button' ? { type: 'button', ...props } : props;
  return <Comp className={`${base} ${sizes[size]} ${look} ${className}`} {...typeProps} />;
}
