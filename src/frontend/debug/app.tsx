import React from 'react';
import { HashRouter, Routes, Route, Navigate, Link } from 'react-router-dom';
import Overview from './routes/overview';
import ConvoList from './routes/conversations.list';
import ConvoDetail from './routes/conversations.detail';
import Scenarios from './routes/scenarios';
import Runners from './routes/runners';
import SqlPage from './routes/sql';
import './styles/tokens';

export function App() {
  return (
    <HashRouter>
      <div className="layout">
        <aside className="nav">
          <Link to="/">Overview</Link>
          <Link to="/conversations">Conversations</Link>
          <Link to="/scenarios">Scenarios</Link>
          <Link to="/runners">Runners</Link>
          <Link to="/sql">SQL</Link>
        </aside>
        <main>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/conversations" element={<ConvoList />} />
            <Route path="/conversations/:id" element={<ConvoDetail />} />
            <Route path="/scenarios" element={<Scenarios />} />
            <Route path="/runners" element={<Runners />} />
            <Route path="/sql" element={<SqlPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
