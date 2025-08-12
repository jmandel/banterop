export type Hint = { kind:string; severity:'info'|'warn'|'error'; seq?:number; note?:string };
export function analyze({ events, guidance, idleTurnMs = 60000 }: { events:any[]; guidance:any[]; idleTurnMs?:number }): Hint[] {
  const hints: Hint[] = [];
  if (!events?.length) return hints;
  const lastTurn = Math.max(...events.map((e:any) => e.turn));
  const lastTurnEvents = events.filter((e:any) => e.turn === lastTurn && e.type !== 'system');
  const closed = lastTurnEvents.some((e:any) => e.type==='message' && (e.finality==='turn' || e.finality==='conversation'));
  if (!closed && lastTurnEvents.length) {
    const lastTs = Date.parse(lastTurnEvents[lastTurnEvents.length - 1].ts);
    if (Date.now() - lastTs > idleTurnMs) hints.push({ kind:'stuck-open-turn', severity:'warn', note:`Turn ${lastTurn} idle > ${idleTurnMs}ms` });
  }
  for (let i=1;i<events.length;i++) {
    const a = events[i-1], b = events[i];
    if (a.type==='message' && b.type==='message' && a.turn===b.turn && a.agentId===b.agentId) {
      hints.push({ kind:'alternation-violation', severity:'error', seq:b.seq, note:`Two messages by ${b.agentId} in turn ${b.turn}` });
    }
  }
  const closes = events.filter((e:any) => e.type==='message' && e.finality==='turn');
  for (const c of closes) {
    const after = guidance.find((g:any) => Date.parse(g.ts) >= Date.parse(c.ts));
    if (!after) hints.push({ kind:'missing-guidance', severity:'warn', seq:c.seq, note:'No guidance after turn close' });
  }
  const seen = new Set<string>();
  for (const e of events) {
    const rid = e?.payload?.clientRequestId;
    if (rid) {
      const k = `${e.agentId}•${rid}`;
      if (seen.has(k)) hints.push({ kind:'idempotent-duplicate', severity:'info', seq:e.seq, note:`Duplicate clientRequestId ${rid}` });
      else seen.add(k);
    }
  }
  return hints;
}

