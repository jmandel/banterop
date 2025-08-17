import React from 'react';

export function Toolbar({ left, right, className = '' }: { left?: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center justify-between gap-2 ${className}`}>
      <div className="flex items-center gap-2">{left}</div>
      <div className="flex items-center gap-2">{right}</div>
    </div>
  );
}

