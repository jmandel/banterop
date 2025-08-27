// NOTE ON FILE PARTS (server policy)
// ----------------------------------
// The shared client-side validator (src/shared/parts-validator.ts) allows a file
// part to specify either base64 `bytes` or a remote `uri`.
// This server intentionally rejects `uri` and requires inline `bytes`.
// Rationale: we do not dereference external URIs in the server (avoid SSRF,
// cross-origin fetches, auth leakage, and race conditions). As a result, a payload
// that passes the shared validator with only `uri` will fail here with
// INVALID_PARAMS (HTTP 400/422 at the route layer). Clients should always send
// `bytes` for file parts when targeting this server.
export function assertDataPartObject(part:any) {
  if (part?.kind === 'data' && (typeof part.data !== 'object' || part.data === null || Array.isArray(part.data))) {
    const err:any = new Error('data part requires object'); err.code = 'INVALID_PARAMS'; throw err
  }
}

export function assertFilePartXorBytes(part:any) {
  if (part?.kind !== 'file') return
  const f = part.file ?? {}
  const hasBytes = typeof f.bytes === 'string' && f.bytes.length > 0
  const hasUri = typeof f.uri === 'string' && f.uri.length > 0
  if (!hasBytes && hasUri) { const err:any = new Error('file part requires bytes; uri is not supported'); err.code = 'INVALID_PARAMS'; throw err }
  if (hasBytes && hasUri) { const err:any = new Error('file part invalid: specify exactly one of bytes or uri'); err.code = 'INVALID_PARAMS'; throw err }
}

export function calcFileSizeBytes(part:any): number | undefined {
  if (part?.kind !== 'file') return
  const b64 = part.file?.bytes; if (!b64) return
  return Uint8Array.from(Buffer.from(b64, 'base64')).length
}

export function validateParts(parts:any[]) {
  for (const p of parts ?? []) {
    assertDataPartObject(p)
    assertFilePartXorBytes(p)
    if (p.kind === 'file') { const sz = calcFileSizeBytes(p); if (sz != null) p.file.size = sz }
  }
}
