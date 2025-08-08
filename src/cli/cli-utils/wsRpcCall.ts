// src/cli/cli-utils/wsRpcCall.ts
export async function wsRpcCall<T>(
  wsUrl: string,
  method: string,
  params?: any
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = crypto.randomUUID();
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    };
    ws.onmessage = (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id !== id) return;
      ws.close();
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result as T);
      }
    };
    ws.onerror = (err) => reject(err);
  });
}