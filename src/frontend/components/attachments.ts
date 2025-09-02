export function attachmentHrefFromBase64(name:string, mimeType:string, b64:string) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    // Decode bytes as UTF-8 text for preview. We rely on the declared mimeType only.
    const text = new TextDecoder('utf-8').decode(arr);
    const mt = String(mimeType || '').toLowerCase();
    const isJson = mt.includes('json');
    const isXml  = mt.includes('xml');
    const type = isJson
      ? 'application/json; charset=utf-8'
      : (isXml ? 'application/xml; charset=utf-8' : 'text/markdown; charset=utf-8');
    const payload = text;
    const blob = new Blob([payload], { type });
    return URL.createObjectURL(blob);
  } catch { return null; }
}
