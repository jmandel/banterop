import React from 'react';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });

export function Markdown({ text, className }:{ text?: string; className?: string }) {
  const html = React.useMemo(() => {
    try { return marked.parse(String(text ?? '')) as string; } catch { return String(text ?? ''); }
  }, [text]);
  return <div className={className || 'text'} dangerouslySetInnerHTML={{ __html: html }} />;
}

