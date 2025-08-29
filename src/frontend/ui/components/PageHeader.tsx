import React from 'react';

export function PageHeader({ title, right, fullWidth = false }: { title: string; right?: React.ReactNode; fullWidth?: boolean }) {
  const container = fullWidth ? 'px-4' : 'mx-auto max-w-5xl px-4';
  return (
    <header className="sticky top-0 z-30 border-b bg-white/90 backdrop-blur">
      <div className={`${container} py-2 flex items-center justify-between`}>
        <h1 className="text-xl font-semibold">{title}</h1>
        <div className="flex items-center gap-2">{right}</div>
      </div>
    </header>
  );
}
