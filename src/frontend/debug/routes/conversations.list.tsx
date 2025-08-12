import React from 'react';
import { Link } from 'react-router-dom';
import { API } from '../services/api';

export default function ConvoList() {
  const [rows, setRows] = React.useState<any[]>([]);
  const [status, setStatus] = React.useState<'active'|'completed'|undefined>('active');
  const load = React.useCallback(() => API.listConversations(status).then(setRows).catch(()=>{}), [status]);
  React.useEffect(() => { load(); const t=setInterval(load, 15000); return()=>clearInterval(t); }, [load]);
  return (
    <div>
      <h2>Conversations</h2>
      <label>Status:
        <select value={status ?? ''} onChange={(e) => setStatus((e.target.value || undefined) as any)}>
          <option value="active">active</option>
          <option value="completed">completed</option>
          <option value="">all</option>
        </select>
      </label>
      <table className="grid">
        <thead><tr><th>ID</th><th>Title</th><th>Scenario</th><th>Status</th><th>Updated</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.conversation}>
              <td><Link to={`/conversations/${r.conversation}`}>{r.conversation}</Link></td>
              <td>{r.metadata?.title ?? '(untitled)'}</td>
              <td>{r.metadata?.scenarioId ?? '-'}</td>
              <td>{r.status}</td>
              <td>{r.updatedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

