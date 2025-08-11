import React from 'react';

export function RawJsonEditor({ config, onChange, isReadOnly }: { config: any; onChange: (c: any) => void; isReadOnly?: boolean }) {
  const [text, setText] = React.useState<string>(() => JSON.stringify(config, null, 2));
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  const autoSize = React.useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, []);

  React.useEffect(() => { setText(JSON.stringify(config, null, 2)); }, [config]);
  React.useEffect(() => { autoSize(); }, [text, autoSize]);
  React.useEffect(() => { autoSize(); }, [autoSize]);

  const apply = () => {
    try { const obj = JSON.parse(text); onChange(obj); } catch { /* ignore */ }
  };

  return (
    <div>
      <textarea
        ref={taRef}
        className="w-full border rounded font-mono text-sm p-2 resize-none overflow-hidden leading-snug"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onInput={autoSize}
        readOnly={isReadOnly}
        style={{ height: 'auto' }}
      />
      {!isReadOnly && (
        <div className="mt-2 text-right">
          <button className="px-3 py-1 text-xs bg-blue-600 text-white rounded" onClick={apply}>Apply JSON</button>
        </div>
      )}
    </div>
  );
}
