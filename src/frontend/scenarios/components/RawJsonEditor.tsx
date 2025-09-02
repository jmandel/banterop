import React from 'react';

export function RawJsonEditor({ config, onChange, isReadOnly, revision = 0 }: { config: any; onChange: (c: any) => void; isReadOnly?: boolean; revision?: number }) {
  const [text, setText] = React.useState<string>(() => JSON.stringify(config, null, 2));
  const [isValid, setIsValid] = React.useState(true);
  // When user is typing, avoid resetting text from incoming props to prevent cursor jumps
  const [dirty, setDirty] = React.useState(false);
  const debounceRef = React.useRef<number | null>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    const s = JSON.stringify(config, null, 2);
    if (!dirty) {
      setText(s);
      setIsValid(true);
    } else {
      // If parent reflected our edit (same JSON string), clear dirty flag
      if (s === text) setDirty(false);
    }
  }, [config, dirty, text]);
  // Force-sync when revision changes (programmatic updates like LLM patches)
  React.useEffect(() => {
    const s = JSON.stringify(config, null, 2);
    setText(s);
    setDirty(false);
    setIsValid(true);
  }, [revision]);
  // Fixed-height editor prevents page scroll jumps; let textarea scroll internally

  const onTextChange = (v: string) => {
    setText(v);
    if (isReadOnly) return;
    setDirty(true);
    // Debounce parse + propagate to reduce re-renders while typing
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      try {
        const obj = JSON.parse(v);
        setIsValid(true);
        onChange(obj);
      } catch {
        setIsValid(false);
      }
    }, 150);
  };

  return (
    <div>
      <textarea
        ref={taRef}
        className={`w-full border rounded-2xl bg-panel text-text font-mono text-sm px-3 py-2 resize-none overflow-auto leading-snug ${isValid ? 'border-border' : 'border-danger'}`}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        readOnly={isReadOnly}
        style={{ height: '60vh', scrollPaddingBottom: '80px' }}
      />
      {!isReadOnly && !isValid && (
        <div className="mt-2 text-xs text-danger">Invalid JSON — changes not applied</div>
      )}
    </div>
  );
}
