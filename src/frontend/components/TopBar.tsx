import React from 'react';

export function TopBar({ left, right, offset = 0 }: { left: React.ReactNode; right?: React.ReactNode; offset?: 0|48 }) {
  const offClass = offset === 48 ? 'top-12' : 'top-0';
  return (
    <div className={`card compact sticky ${offClass}`}>
      <div className="row compact topbar-row">
        <div className="row compact">
          {left}
        </div>
        <div className="ml-auto row compact">
          {right}
        </div>
      </div>
    </div>
  );
}
