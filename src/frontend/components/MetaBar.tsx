import React from 'react';

type Chip = { text: string; tone?: 'neutral'|'green'|'amber'|'blue'|'gray' };

function chipClass(tone?: Chip['tone']): string {
  switch (tone) {
    case 'green': return 'bg-green-50 text-green-800';
    case 'amber': return 'bg-amber-50 text-amber-800';
    case 'blue': return 'bg-blue-50 text-blue-800';
    case 'gray': return 'bg-gray-100 text-gray-800';
    case 'neutral':
    default: return 'bg-gray-100 text-gray-800';
  }
}

export function MetaBar({ left, chips, right }:{ left: React.ReactNode; chips: Chip[]; right?: React.ReactNode }) {
  return (
    <div className="card compact sticky top-12">
      <div className="row compact w-full">
        <div className="row compact">
          {left}
          {/* chips: left-justified next to the label */}
          {chips.map((c, i) => (
            <span key={i} className={`pill ${chipClass(c.tone)}`}>{c.text}</span>
          ))}
        </div>
        {right && <div className="row compact" style={{ marginLeft:'auto' }}>{right}</div>}
      </div>
    </div>
  );
}
