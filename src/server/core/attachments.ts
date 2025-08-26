export type AttachmentFact = { name:string; mimeType?:string; size?:number; sourceMessageId:string }
export function updateAttachmentIndex(index: Map<string,AttachmentFact>, parts:any[], messageId:string) {
  for (const p of parts ?? []) {
    if (p.kind === 'file' && p.file?.name) {
      const name = p.file.name as string
      if (!index.has(name)) index.set(name, { name, mimeType: p.file.mimeType, size: p.file.size, sourceMessageId: messageId })
    }
  }
}

