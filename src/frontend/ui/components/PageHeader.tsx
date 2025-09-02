import React from 'react';

export function PageHeader({ title, right, fullWidth = false, offset = 48 }: { title: React.ReactNode; right?: React.ReactNode; fullWidth?: boolean; offset?: number }) {
  const container = fullWidth ? 'px-4' : 'container mx-auto px-3';
  return (
    <header className="sticky z-30 border-b bg-white/95 backdrop-blur" style={{ top: offset }}>
      <div className={`${container} py-2.5 flex items-center justify-between`}>
        <div className="text-xl font-semibold truncate flex items-center gap-2 min-w-0">{title}</div>
        <div className="flex items-center gap-2">{right}</div>
      </div>
    </header>
  );
}
