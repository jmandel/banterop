import React from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

type ButtonProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType<any>; // polymorphic element (e.g., 'a', 'label')
  variant?: Variant;
  size?: Size;
  className?: string;
  disabled?: boolean;
  // Common anchor/button props to satisfy polymorphic usage
  href?: string;
  target?: string;
  rel?: string;
  type?: 'button' | 'submit' | 'reset';
};

export function Button({ as = 'button', variant = 'primary', size = 'md', className = '', ...props }: ButtonProps) {
  const Comp: any = as;
  const base = 'inline-flex items-center justify-center gap-2 rounded-2xl font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-700 focus-visible:ring-offset-2';
  const sizes: Record<Size, string> = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-2 text-sm',
    lg: 'px-4 py-2.5 text-base',
  };
  const look = (
    {
      primary: 'bg-primary text-primary-foreground hover:bg-primary-700',
      secondary: 'border border-border bg-panel hover:bg-gray-50',
      danger: 'bg-danger text-white hover:opacity-90',
      ghost: 'text-muted hover:bg-gray-50',
    } as const
  )[variant];
  const typeProps = Comp === 'button' ? { type: 'button', ...props } : props;
  return <Comp className={`${base} ${sizes[size]} ${look} ${className}`} {...typeProps} />;
}
