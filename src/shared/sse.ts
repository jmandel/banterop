export async function* parseSse<T = any>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    let read;
    try {
      read = await reader.read();
    } catch {
      // Stream aborted or errored; treat as end-of-stream
      break;
    }
    const { value, done } = read;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const i = buf.indexOf('\n\n'), j = buf.indexOf('\r\n\r\n');
      const idx = i !== -1 ? i : (j !== -1 ? j : -1);
      const dlen = i !== -1 ? 2 : (j !== -1 ? 4 : 0);
      if (idx === -1) break;
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + dlen);
      const lines = chunk.replace(/\r/g, '').split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trimStart();
        try {
          const obj = JSON.parse(data);
          if (obj && 'result' in obj) yield obj.result as T;
        } catch {}
      }
    }
  }
}
