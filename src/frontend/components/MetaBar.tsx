import React from 'react';

type Chip = { text: string; tone?: 'neutral'|'green'|'amber'|'blue'|'gray'; icon?: React.ReactNode };

function chipClass(tone?: Chip['tone']): string {
  switch (tone) {
    case 'green': return 'bg-green-50 text-green-800';
    case 'amber': return 'bg-amber-50 text-amber-800';
    case 'blue': return 'bg-primary-50 text-primary-800';
    case 'gray': return 'bg-gray-100 text-gray-800';
    case 'neutral':
    default: return 'bg-gray-100 text-gray-800';
  }
}

export function MetaBar({ left, chips, right, elRef, offset = 48 }:{ left: React.ReactNode; chips: Chip[]; right?: React.ReactNode; elRef?: React.Ref<HTMLDivElement>; offset?: number }) {
  return (
    <div ref={elRef as any} className="lg:sticky z-20" style={{ top: offset }}>
      <div className="bg-white">
        <div className="card compact !mb-0">
          <div className="row compact w-full">
            <div className="row compact">
              {left}
              {/* chips: left-justified next to the label */}
              {chips.map((c, i) => (
                <span key={i} className={`pill ${chipClass(c.tone)} flex items-center gap-1.5`}>
                  {c.icon && <span className="inline-block align-middle">{c.icon}</span>}
                  <span>{c.text}</span>
                </span>
              ))}
            </div>
            {right && <div className="row compact" style={{ marginLeft:'auto' }}>{right}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
