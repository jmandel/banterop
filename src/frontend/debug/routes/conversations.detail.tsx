import React from 'react';
import { useParams } from 'react-router-dom';
import { API } from '../services/api';
import { Rpc } from '../services/rpc';
import { analyze } from '../services/diagnostics';

export default function ConvoDetail() {
  const { id } = useParams(); const conversationId = Number(id);
  const [snapshot, setSnapshot] = React.useState<any>();
  const [events, setEvents] = React.useState<any[]>([]);
  const [guidance, setGuidance] = React.useState<any[]>([]);
  const [rpc] = React.useState(() => new Rpc());
  const [autoscroll, setAutoscroll] = React.useState(true);

  React.useEffect(() => {
    let unsub = () => {};
    (async () => {
      const snap = await API.snapshot(conversationId).catch(()=>null); setSnapshot(snap);
      const res = await rpc.connectWithBacklog(conversationId, 500);
      setEvents(res.events);
      rpc.onEvent = (e) => { if (e.conversation!==conversationId) return; setEvents((prev) => [...prev, e].slice(-1000)); };
      rpc.onGuidance = (g) => { if (g.conversation!==conversationId) return; setGuidance((prev) => [...prev, g]); };
      unsub = () => rpc.call('unsubscribe', { subId: res.subId }).catch(()=>{});
    })();
    return () => unsub();
  }, [conversationId]);

  const hints = analyze({ events, guidance, idleTurnMs: snapshot?.snapshot?.metadata?.config?.idleTurnMs ?? 60000 });

  return (
    <div>
      <h2>Conversation {conversationId}</h2>
      <Head snapshot={snapshot} />
      <Diagnostics hints={hints} />
      <Timeline events={events} autoscroll={autoscroll} onToggle={() => setAutoscroll(!autoscroll)} />
    </div>
  );
}

function Head({ snapshot }: any) {
  const head = snapshot?.head ?? { lastTurn: 0, lastClosedSeq: 0, hasOpenTurn: false };
  const meta = snapshot?.snapshot?.metadata ?? {};
  return (
    <div className="head">
      <div>
        <b>{meta.title ?? '(untitled)'}</b> · Scenario: {meta.scenarioId ?? '—'} · Status: {snapshot?.snapshot?.status}
      </div>
      <div>Turn: {head.lastTurn} · Closed seq: {head.lastClosedSeq} · {head.hasOpenTurn ? 'Open turn' : 'No open turn'}</div>
    </div>
  );
}
function Diagnostics({ hints }: any) {
  if (!hints?.length) return null;
  return <ul className="diag">{hints.map((h: any, i: number) => <li key={i} className={h.severity}>{h.kind}: {h.note}</li>)}</ul>;
}
function Timeline({ events, autoscroll, onToggle }: any) {
  return (
    <div>
      <div className="toolbar"><label><input type="checkbox" checked={autoscroll} onChange={onToggle}/> autoscroll</label></div>
      <div className="timeline">
        {events.map((e:any) => (
          <div key={e.seq} className={`row type-${e.type}`}>
            <span className="addr">{e.turn}•{e.event}</span>
            <span className="chip">{e.type}</span>
            {e.type==='message' && e.finality!=='none' && <span className={`chip fin-${e.finality}`}>{e.finality}</span>}
            <span className="agent">{e.agentId}</span>
            <span className="ts">{e.ts}</span>
            <details><summary>payload</summary><pre>{JSON.stringify(e.payload, null, 2)}</pre></details>
          </div>
        ))}
      </div>
    </div>
  );
}

