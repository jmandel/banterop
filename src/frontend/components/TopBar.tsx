import React from 'react';

export function TopBar({ left, right, offset = 0 }: { left: React.ReactNode; right?: React.ReactNode; offset?: 0|48 }) {
  const offClass = offset === 48 ? 'lg:top-12' : 'lg:top-0';
  return (
    <div className={`lg:sticky ${offClass} z-20`}>
      <div className="bg-white">
        <div className="card compact !mb-0">
          <div className="row compact topbar-row">
            <div className="row compact">
              {left}
            </div>
            <div className="ml-auto row compact">
              {right}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
