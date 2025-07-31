import React, { useState } from 'react';
import type { ScenarioItem } from '$lib/types.js';

interface ScenarioListProps {
  scenarios: ScenarioItem[];
  activeScenarioId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

export function ScenarioList({
  scenarios,
  activeScenarioId,
  onSelect,
  onCreate,
  onDelete
}: ScenarioListProps) {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredScenarios = scenarios.filter(scenario =>
    scenario.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    scenario.config.metadata.title.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h2 className="sidebar-title">Scenarios</h2>
        <input
          type="text"
          className="search-input"
          placeholder="Search scenarios..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="scenario-list">
        {filteredScenarios.length === 0 ? (
          <div style={{ padding: '16px', textAlign: 'center', color: '#666' }}>
            {searchTerm ? 'No scenarios found' : 'No scenarios yet'}
          </div>
        ) : (
          filteredScenarios.map(scenario => (
            <div
              key={scenario.id}
              className={`scenario-item ${scenario.id === activeScenarioId ? 'active' : ''}`}
              onClick={() => onSelect(scenario.id)}
            >
              <div className="scenario-name">{scenario.name}</div>
              <div className="scenario-meta">
                {scenario.config.agents.map(a => a.principal.name).join(' ↔ ')}
              </div>
              <div className="scenario-meta">
                Modified: {formatDate(scenario.modified)}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button className="btn-primary" onClick={onCreate}>
          Create New Scenario
        </button>
      </div>
    </div>
  );
}