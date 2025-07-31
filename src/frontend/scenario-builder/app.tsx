import React from 'react';
import { createRoot } from 'react-dom/client';
import { ScenarioBuilderPage } from './components/ScenarioBuilderPage.js';

function App() {
  return <ScenarioBuilderPage />;
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}