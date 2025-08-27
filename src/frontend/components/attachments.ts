export function attachmentHrefFromBase64(name:string, mimeType:string, b64:string) {
  try {
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i=0;i<bytes.length;i++) arr[i] = bytes.charCodeAt(i);
    // Force explicit UTF-8 charset for all attachments to avoid mojibake in browsers.
    const baseType = mimeType || 'application/octet-stream';
    const type = /charset=/i.test(baseType) ? baseType : `${baseType};charset=utf-8`;
    const blob = new Blob([arr], { type });
    return URL.createObjectURL(blob);
  } catch { return null; }
}

