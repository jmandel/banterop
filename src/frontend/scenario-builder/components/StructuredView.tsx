import React from 'react';
import type { ScenarioConfiguration, Tool, AgentConfiguration } from '$lib/types.js';

interface StructuredViewProps {
  config: ScenarioConfiguration;
}

export function StructuredView({ config }: StructuredViewProps) {

  const renderJsonPreview = (data: any, label: string) => {
    if (!data || Object.keys(data).length === 0) {
      return <div style={{ color: '#666', fontStyle: 'italic' }}>No {label} defined</div>;
    }
    return (
      <div className="json-preview">
        {JSON.stringify(data, null, 2)}
      </div>
    );
  };

  const renderTools = (tools: Tool[]) => {
    if (!tools || tools.length === 0) {
      return <div style={{ color: '#666', fontStyle: 'italic' }}>No tools defined</div>;
    }
    return (
      <div className="tools-list">
        {tools.map((tool, index) => {
          const isTerminal = !!tool.endsConversation;
          const toolType = isTerminal ? (tool.toolName.toLowerCase().includes('success') ? 'success' : 'failure') : 'ongoing';
          return (
            <div key={index} className="tool-item">
              <div className="tool-name">
                {tool.toolName}
                <span className={`tool-type ${toolType}`}>
                  {isTerminal ? 'Terminal' : 'Ongoing'}
                </span>
              </div>
              <div className="tool-description">{tool.description}</div>
            </div>
          );
        })}
      </div>
    );
  };

  const AgentCard = ({ agentConfig }: { agentConfig: AgentConfiguration }) => (
    <div className="section-card">
      <h3 className="section-title">Agent: {agentConfig.agentId}</h3>
      <div className="field-group">
        <div className="field-label">Principal</div>
        <div className="field-value">{agentConfig.principal.name} ({agentConfig.principal.type})</div>
      </div>
      <div className="field-group">
        <div className="field-label">System Prompt</div>
        <div className="field-value" style={{ whiteSpace: 'pre-wrap' }}>{agentConfig.systemPrompt}</div>
      </div>
      <div className="field-group">
        <div className="field-label">Situation</div>
        <div className="field-value">{agentConfig.situation}</div>
      </div>
      <div className="field-group">
        <div className="field-label">Goals</div>
        <ul>{agentConfig.goals.map((g, i) => <li key={i}>{g}</li>)}</ul>
      </div>
      {agentConfig.messageToUseWhenInitiatingConversation && (
        <div className="field-group">
          <div className="field-label">Initiation Message</div>
          <div className="field-value" style={{ whiteSpace: 'pre-wrap', fontStyle: 'italic' }}>
            "{agentConfig.messageToUseWhenInitiatingConversation}"
          </div>
        </div>
      )}
      <div className="field-group">
        <div className="field-label">Knowledge Base</div>
        {renderJsonPreview(agentConfig.knowledgeBase, 'knowledge base')}
      </div>
      <div className="field-group">
        <div className="field-label">Tools</div>
        {renderTools(agentConfig.tools)}
      </div>
    </div>
  );

  return (
    <div className="structured-view">
      <div className="section-card">
        <h3 className="section-title">Scenario Metadata</h3>
        <div className="field-group">
          <div className="field-label">Title</div>
          <div className="field-value">{config.metadata.title}</div>
        </div>
        <div className="field-group">
          <div className="field-label">Description</div>
          <div className="field-value">{config.metadata.description}</div>
        </div>
      </div>

      <div className="section-card">
        <h3 className="section-title">Scenario Narrative</h3>
        <div className="field-group">
          <div className="field-label">Background</div>
          <div className="field-value">{config.scenario.background}</div>
        </div>
        <div className="field-group">
          <div className="field-label">Challenges</div>
          <ul>{config.scenario.challenges.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </div>
      </div>
      
      {config.agents.map(agent => <AgentCard key={agent.agentId} agentConfig={agent} />)}
    </div>
  );
}