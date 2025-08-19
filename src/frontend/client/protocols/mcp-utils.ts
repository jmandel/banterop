import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function toUrl(endpointUrl: string): URL {
  try { return new URL(endpointUrl); }
  catch { return new URL(endpointUrl, (typeof window !== 'undefined' ? window.location.href : 'http://localhost')); }
}

export async function listMcpTools(endpointUrl: string): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(toUrl(endpointUrl) as any);
  const client = new Client({ name: "conversational-interop-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools({});
    const names = Array.isArray((tools as any)?.tools)
      ? (tools as any).tools.map((t: any) => String(t?.name || "")).filter(Boolean)
      : [];
    return names;
  } finally {
    try { await (client as any).close?.(); } catch {}
  }
}
