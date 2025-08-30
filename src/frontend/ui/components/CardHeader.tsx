import React from 'react';

export function CardHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-muted font-semibold">{title}</div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}
