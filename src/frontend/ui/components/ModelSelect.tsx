import React from 'react';

export type ProviderModels = Array<{ name: string; models: string[] }>;

type Props = {
  providers: ProviderModels;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
};

export function ModelSelect({ providers, value, onChange, id, className = '', disabled, title }: Props) {
  return (
    <select
      id={id}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      title={title || value}
    >
      {providers.map((p) => (
        <optgroup key={p.name} label={p.name}>
          {p.models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

