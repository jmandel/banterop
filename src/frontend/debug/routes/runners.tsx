import React from 'react';
import { API } from '../services/api';

export default function Runners() {
  const [data, setData] = React.useState<any>({});
  React.useEffect(() => { const load=()=>API.runners().then(setData).catch(()=>{}); load(); const t=setInterval(load, 15000); return()=>clearInterval(t); }, []);
  const rows = data.runners ?? [];
  return (
    <div>
      <h2>Runners</h2>
      <table className="grid">
        <thead><tr><th>Agent</th><th>Managed?</th><th>Last seen</th><th>Events (24h)</th></tr></thead>
        <tbody>{rows.map((r:any) =>
          <tr key={r.agentId}><td>{r.agentId}</td><td>{String(r.managed)}</td><td>{r.lastSeen ?? '—'}</td><td>{r.countEvents24h}</td></tr>
        )}</tbody>
      </table>
    </div>
  );
}

