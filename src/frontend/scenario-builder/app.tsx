import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './components/AppLayout.js';
import { ScenarioLandingPage } from './components/ScenarioLandingPage.js';
import { ScenarioBuilderPage } from './components/ScenarioBuilderPage.js';
import { ScenarioRunPage } from './components/ScenarioRunPage.js';
import { ScenarioPluginPage } from './components/ScenarioPluginPage.js';
import { ScenarioConfiguredPage } from './components/ScenarioConfiguredPage.js';
import "./output.css";

function App() {
  return (
    <HashRouter>
      <AppLayout>
        <Routes>
          {/* Default route - redirect to landing page */}
          <Route path="/" element={<Navigate to="/scenarios" replace />} />
          
          {/* Landing page with scenario cards */}
          <Route path="/scenarios" element={<ScenarioLandingPage />} />
          
          {/* Scenario viewing (default) and editing */}
          <Route path="/scenarios/:scenarioId" element={<ScenarioBuilderPage />} />
          <Route path="/scenarios/:scenarioId/edit" element={<ScenarioBuilderPage />} />
          
          {/* Run and plugin routes */}
          <Route path="/scenarios/:scenarioId/run" element={<ScenarioRunPage />} />
          <Route path="/scenarios/:scenarioId/plug-in/:config64" element={<ScenarioPluginPage />} />
          
          {/* Unified configured scenario route */}
          <Route path="/scenarios/configured/:config64" element={<ScenarioConfiguredPage />} />
        </Routes>
      </AppLayout>
    </HashRouter>
  );
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}