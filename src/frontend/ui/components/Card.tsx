import React from 'react';

export function Card({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`bg-panel border border-border rounded-2xl p-3 shadow-sm ${className}`} {...props} />
  );
}
