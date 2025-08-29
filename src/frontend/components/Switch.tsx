import React from 'react';

export function Switch({ checked, onChange, label }:{ checked: boolean; onChange: (v:boolean)=>void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center w-10 h-5 rounded-full transition-colors ${checked ? 'bg-green-500' : 'bg-gray-300'}`}
    >
      <span className={`inline-block w-4 h-4 bg-white rounded-full transform transition-transform ${checked ? 'translate-x-5' : 'translate-x-1'}`} />
      {label && <span className="ml-2 text-xs text-gray-700">{label}</span>}
    </button>
  );
}

