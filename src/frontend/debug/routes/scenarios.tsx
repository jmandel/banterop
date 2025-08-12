import React from 'react';
import { API } from '../services/api';

export default function Scenarios() {
  const [rows, setRows] = React.useState<any[]>([]);
  React.useEffect(() => { API.scenarios().then(setRows).catch(()=>{}); }, []);
  return (
    <div>
      <h2>Scenarios</h2>
      <table className="grid"><thead><tr><th>ID</th><th>Name</th><th>Modified</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td>{r.id}</td><td>{r.name}</td><td>{r.modifiedAt}</td></tr>)}</tbody></table>
    </div>
  );
}

