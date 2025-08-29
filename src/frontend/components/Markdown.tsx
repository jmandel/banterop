import React from 'react';
import { marked } from 'marked';

// Keep options minimal for broad version compatibility
try { marked.setOptions({ gfm: true, breaks: true } as any); } catch {}

function ensureLinksOpenInNewTab(html: string): string {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const anchors = doc.querySelectorAll('a[href]');
    anchors.forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
    return doc.body.innerHTML;
  } catch {
    try { return html.replaceAll('<a ', '<a target="_blank" rel="noopener noreferrer" '); } catch { return html; }
  }
}

export function Markdown({ text, className }:{ text?: string; className?: string }) {
  const html = React.useMemo(() => {
    try {
      const raw = marked.parse(String(text ?? '')) as string;
      return ensureLinksOpenInNewTab(raw);
    } catch { return String(text ?? ''); }
  }, [text]);
  return <div className={className || 'text'} dangerouslySetInnerHTML={{ __html: html }} />;
}
