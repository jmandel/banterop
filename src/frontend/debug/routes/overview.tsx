import React from 'react';
import { API } from '../services/api';

export default function Overview() {
  const [data, setData] = React.useState<any>();
  React.useEffect(() => { API.overview().then(setData).catch(console.error); const t=setInterval(()=>API.overview().then(setData).catch(()=>{}), 10000); return()=>clearInterval(t); }, []);
  if (!data) return <div>Loading…</div>;
  return (
    <div className="cards">
      <Card title="Active" value={data.activeConversations} />
      <Card title="Completed" value={data.completedConversations} />
      <Card title="Events/min" value={data.eventsPerMinute} />
      <Card title="Open-turn convos" value={data.openTurnConversations} />
    </div>
  );
}

function Card({ title, value }: any) { return <div className="card"><div>{title}</div><b>{value}</b></div>; }

