import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentConfig, CreateConversationRequest, CreateConversationResponse } from '$lib/types.js';

// ============= Types =============

interface Agent {
  id: string;
  label: string;
  type: string;
  description?: string;
}

interface Conversation {
  id: string;
  name: string;
  createdAt: string;
  status: 'active' | 'completed';
  agents: string[];
  turns?: any[];
}

interface DashboardStats {
  totalAgents: number;
  totalConversations: number;
  activeConversations: number;
}

// ============= API Client =============

class DashboardAPI {
  private baseUrl: string;

  constructor(baseUrl = 'http://localhost:3001') {
    this.baseUrl = baseUrl;
  }

  async createConversation(request: CreateConversationRequest): Promise<CreateConversationResponse> {
    const response = await fetch(`${this.baseUrl}/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Failed to create conversation: ${response.statusText}`);
    }

    return response.json();
  }

  async getConversation(id: string): Promise<Conversation> {
    const response = await fetch(`${this.baseUrl}/conversations/${id}`);
    
    if (!response.ok) {
      throw new Error(`Failed to get conversation: ${response.statusText}`);
    }

    return response.json();
  }
}

// ============= Components =============

const StatCard: React.FC<{ value: number; label: string }> = ({ value, label }) => (
  <div className="stat-card">
    <div className="stat-value">{value}</div>
    <div className="stat-label">{label}</div>
  </div>
);

const AgentForm: React.FC<{ onAgentCreated: (agent: Agent) => void }> = ({ onAgentCreated }) => {
  const [formData, setFormData] = useState({
    id: '',
    label: '',
    type: '',
    description: ''
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.id || !formData.label || !formData.type) return;

    const agent: Agent = {
      id: formData.id,
      label: formData.label,
      type: formData.type,
      description: formData.description
    };

    onAgentCreated(agent);
    setFormData({ id: '', label: '', type: '', description: '' });
  };

  return (
    <div className="card">
      <h2>Create Agent</h2>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="agentId">Agent ID</label>
          <input
            type="text"
            id="agentId"
            value={formData.id}
            onChange={(e) => setFormData(prev => ({ ...prev, id: e.target.value }))}
            placeholder="e.g., assistant-01"
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="agentLabel">Display Name</label>
          <input
            type="text"
            id="agentLabel"
            value={formData.label}
            onChange={(e) => setFormData(prev => ({ ...prev, label: e.target.value }))}
            placeholder="e.g., Assistant Agent"
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="agentType">Agent Type</label>
          <select
            id="agentType"
            value={formData.type}
            onChange={(e) => setFormData(prev => ({ ...prev, type: e.target.value }))}
            required
          >
            <option value="">Select type...</option>
            <option value="assistant">Assistant</option>
            <option value="specialist">Specialist</option>
            <option value="coordinator">Coordinator</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="agentDescription">Description</label>
          <textarea
            id="agentDescription"
            value={formData.description}
            onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
            placeholder="Agent capabilities and purpose..."
          />
        </div>
        <button type="submit" className="btn">Create Agent</button>
      </form>
    </div>
  );
};

const ConversationForm: React.FC<{
  agents: Agent[];
  onConversationCreated: (conversation: Conversation, tokens: Record<string, string>) => void;
}> = ({ agents, onConversationCreated }) => {
  const [formData, setFormData] = useState({
    name: '',
    selectedAgents: [] as string[],
    initialMessage: ''
  });
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || formData.selectedAgents.length === 0) return;

    setIsLoading(true);
    try {
      const api = new DashboardAPI();
      
      const agentConfigs: AgentConfig[] = formData.selectedAgents.map(agentId => {
        const agent = agents.find(a => a.id === agentId)!;
        return {
          agentId: { id: agent.id, label: agent.label },
          type: agent.type as any,
          description: agent.description
        };
      });

      const request: CreateConversationRequest = {
        name: formData.name,
        agents: agentConfigs,
        initialMessage: formData.initialMessage ? {
          agentId: formData.selectedAgents[0],
          content: formData.initialMessage
        } : undefined
      };

      const response = await api.createConversation(request);
      
      onConversationCreated(response.conversation, response.agentTokens);
      setFormData({ name: '', selectedAgents: [], initialMessage: '' });
    } catch (error) {
      console.error('Failed to create conversation:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAgentSelection = (agentId: string) => {
    setFormData(prev => ({
      ...prev,
      selectedAgents: prev.selectedAgents.includes(agentId)
        ? prev.selectedAgents.filter(id => id !== agentId)
        : [...prev.selectedAgents, agentId]
    }));
  };

  return (
    <div className="card">
      <h2>Create Conversation</h2>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="conversationName">Conversation Name</label>
          <input
            type="text"
            id="conversationName"
            value={formData.name}
            onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
            placeholder="e.g., Customer Support Session"
            required
          />
        </div>
        <div className="form-group">
          <label>Select Agents</label>
          <div className="agent-selector">
            {agents.map(agent => (
              <label key={agent.id} className="agent-checkbox">
                <input
                  type="checkbox"
                  checked={formData.selectedAgents.includes(agent.id)}
                  onChange={() => handleAgentSelection(agent.id)}
                />
                <span>{agent.label} ({agent.type})</span>
              </label>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="initialMessage">Initial Message (Optional)</label>
          <textarea
            id="initialMessage"
            value={formData.initialMessage}
            onChange={(e) => setFormData(prev => ({ ...prev, initialMessage: e.target.value }))}
            placeholder="Hello! How can I assist you today?"
          />
        </div>
        <button type="submit" className="btn" disabled={isLoading}>
          {isLoading ? 'Creating...' : 'Create Conversation'}
        </button>
      </form>
    </div>
  );
};

const AgentList: React.FC<{ agents: Agent[] }> = ({ agents }) => (
  <div className="card">
    <h2>Agents ({agents.length})</h2>
    <ul className="agent-list">
      {agents.map(agent => (
        <li key={agent.id} className="agent-item">
          <div className="agent-info">
            <h4>{agent.label}</h4>
            <p>ID: {agent.id} • Type: {agent.type}</p>
            {agent.description && <p>{agent.description}</p>}
          </div>
        </li>
      ))}
    </ul>
  </div>
);

const ConversationList: React.FC<{ conversations: Conversation[] }> = ({ conversations }) => (
  <div className="card">
    <h2>Conversations ({conversations.length})</h2>
    <ul className="conversation-list">
      {conversations.map(conversation => (
        <li key={conversation.id} className="conversation-item">
          <h4>{conversation.name}</h4>
          <div className="conversation-meta">
            <span>ID: {conversation.id}</span>
            <span>Agents: {conversation.agents.length}</span>
            <span>Created: {new Date(conversation.createdAt).toLocaleDateString()}</span>
          </div>
          <div className="conversation-actions">
            <span className={`status ${conversation.status}`}>{conversation.status}</span>
            <button className="btn btn-small" onClick={() => window.open(`http://localhost:3000/trace-viewer/?conversation=${conversation.id}`, '_blank')}>
              View Trace
            </button>
          </div>
        </li>
      ))}
    </ul>
  </div>
);

const TokenModal: React.FC<{
  isOpen: boolean;
  tokens: Record<string, string>;
  onClose: () => void;
}> = ({ isOpen, tokens, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="modal show">
      <div className="modal-content">
        <div className="modal-header">
          <h3>Agent Tokens</h3>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>
        <p>Your conversation has been created! Here are the agent tokens:</p>
        <div className="token-list">
          {Object.entries(tokens).map(([agentId, token]) => (
            <div key={agentId} className="token-item">
              <strong>{agentId}:</strong>
              <div className="token-display">{token}</div>
            </div>
          ))}
        </div>
        <p style={{ color: '#f59e0b', fontSize: '0.875rem' }}>
          ⚠️ Save these tokens securely. They won't be shown again.
        </p>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
};

// ============= Main Dashboard Component =============

const Dashboard: React.FC = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [stats, setStats] = useState<DashboardStats>({
    totalAgents: 0,
    totalConversations: 0,
    activeConversations: 0
  });
  const [tokenModal, setTokenModal] = useState<{
    isOpen: boolean;
    tokens: Record<string, string>;
  }>({ isOpen: false, tokens: {} });

  const handleAgentCreated = (agent: Agent) => {
    setAgents(prev => [...prev, agent]);
  };

  const handleConversationCreated = (conversation: Conversation, tokens: Record<string, string>) => {
    setConversations(prev => [...prev, conversation]);
    setTokenModal({ isOpen: true, tokens });
  };

  const closeTokenModal = () => {
    setTokenModal({ isOpen: false, tokens: {} });
  };

  // Update stats when data changes
  useEffect(() => {
    setStats({
      totalAgents: agents.length,
      totalConversations: conversations.length,
      activeConversations: conversations.filter(c => c.status === 'active').length
    });
  }, [agents, conversations]);

  return (
    <>
      <div className="header">
        <h1>Agent Dashboard</h1>
      </div>

      <div className="container">
        <div className="stats-grid">
          <StatCard value={stats.totalAgents} label="Agents" />
          <StatCard value={stats.totalConversations} label="Conversations" />
          <StatCard value={stats.activeConversations} label="Active" />
        </div>

        <div className="grid">
          <AgentForm onAgentCreated={handleAgentCreated} />
          <ConversationForm agents={agents} onConversationCreated={handleConversationCreated} />
        </div>

        <div className="grid">
          <AgentList agents={agents} />
          <ConversationList conversations={conversations} />
        </div>
      </div>

      <TokenModal
        isOpen={tokenModal.isOpen}
        tokens={tokenModal.tokens}
        onClose={closeTokenModal}
      />

      <style jsx>{`
        .header {
          background: #1a1a1a;
          padding: 1rem 2rem;
          border-bottom: 1px solid #333;
        }

        .header h1 {
          font-size: 1.5rem;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          margin: 0;
        }

        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 2rem;
        }

        .grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 2rem;
          margin-bottom: 2rem;
        }

        .card {
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 8px;
          padding: 1.5rem;
        }

        .card h2 {
          margin: 0 0 1rem 0;
          color: #667eea;
        }

        .form-group {
          margin-bottom: 1rem;
        }

        .form-group label {
          display: block;
          margin-bottom: 0.5rem;
          color: #ccc;
          font-weight: 500;
        }

        .form-group input,
        .form-group textarea,
        .form-group select {
          width: 100%;
          padding: 0.75rem;
          background: #2a2a2a;
          border: 1px solid #444;
          border-radius: 4px;
          color: #e0e0e0;
          font-family: inherit;
        }

        .form-group textarea {
          min-height: 100px;
          resize: vertical;
        }

        .btn {
          background: #667eea;
          color: white;
          border: none;
          padding: 0.75rem 1.5rem;
          border-radius: 4px;
          cursor: pointer;
          font-family: inherit;
          font-weight: 500;
          transition: background 0.2s;
        }

        .btn:hover:not(:disabled) {
          background: #5a67d8;
        }

        .btn:disabled {
          background: #444;
          cursor: not-allowed;
        }

        .btn-small {
          padding: 0.25rem 0.75rem;
          font-size: 0.875rem;
        }

        .agent-selector {
          max-height: 150px;
          overflow-y: auto;
          border: 1px solid #444;
          border-radius: 4px;
          padding: 0.5rem;
          background: #2a2a2a;
        }

        .agent-checkbox {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.25rem 0;
          cursor: pointer;
        }

        .agent-checkbox input {
          width: auto;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 1rem;
          margin-bottom: 2rem;
        }

        .stat-card {
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 8px;
          padding: 1rem;
          text-align: center;
        }

        .stat-value {
          font-size: 2rem;
          font-weight: bold;
          color: #667eea;
        }

        .stat-label {
          color: #888;
          font-size: 0.875rem;
          margin-top: 0.25rem;
        }

        .agent-list,
        .conversation-list {
          list-style: none;
          padding: 0;
          margin: 0;
        }

        .agent-item,
        .conversation-item {
          background: #2a2a2a;
          border: 1px solid #444;
          border-radius: 4px;
          padding: 1rem;
          margin-bottom: 0.5rem;
        }

        .agent-info h4,
        .conversation-item h4 {
          color: #667eea;
          margin: 0 0 0.25rem 0;
        }

        .agent-info p {
          color: #888;
          font-size: 0.875rem;
          margin: 0;
        }

        .conversation-meta {
          display: flex;
          gap: 1rem;
          font-size: 0.875rem;
          color: #888;
          margin: 0.5rem 0;
        }

        .conversation-actions {
          display: flex;
          gap: 0.5rem;
          align-items: center;
        }

        .status {
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-size: 0.75rem;
          font-weight: 500;
        }

        .status.active {
          background: #065f46;
          color: #10b981;
        }

        .status.completed {
          background: #374151;
          color: #9ca3af;
        }

        .modal {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.8);
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .modal-content {
          background: #1a1a1a;
          border: 1px solid #333;
          border-radius: 8px;
          padding: 2rem;
          max-width: 500px;
          width: 90%;
          max-height: 80vh;
          overflow-y: auto;
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }

        .modal-header h3 {
          color: #667eea;
          margin: 0;
        }

        .close-btn {
          background: none;
          border: none;
          color: #888;
          font-size: 1.5rem;
          cursor: pointer;
        }

        .close-btn:hover {
          color: #ccc;
        }

        .token-display {
          background: #2a2a2a;
          border: 1px solid #444;
          border-radius: 4px;
          padding: 0.75rem;
          font-family: monospace;
          font-size: 0.875rem;
          word-break: break-all;
          margin: 0.5rem 0 1rem 0;
        }

        .token-item {
          margin-bottom: 1rem;
        }
      `}</style>
    </>
  );
};

// ============= Bootstrap =============

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<Dashboard />);
}