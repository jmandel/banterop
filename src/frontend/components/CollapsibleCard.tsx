import React from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

export function CollapsibleCard({ title, initialOpen=true, children }:{ title: string; initialOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(!!initialOpen);
  return (
    <div className="card">
      <div className="row items-center justify-between" onClick={()=>setOpen(!open)} style={{ cursor:'pointer' }}>
        <div className="small font-semibold">{title}</div>
        <button
          type="button"
          aria-label={open ? 'Collapse' : 'Expand'}
          title={open ? 'Collapse' : 'Expand'}
          className="p-1 rounded hover:bg-gray-100 text-gray-600 bg-transparent border-0"
          onClick={(e)=>{ e.stopPropagation(); setOpen(!open); }}
        >
          {open ? <ChevronUp size={16} strokeWidth={1.75} /> : <ChevronDown size={16} strokeWidth={1.75} />}
        </button>
      </div>
      {open && (
        <div className="mt-2">
          {children}
        </div>
      )}
    </div>
  );
}
