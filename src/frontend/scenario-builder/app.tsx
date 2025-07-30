import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPatch } from 'fast-json-patch';
import type { ScenarioConfiguration } from '$lib/types.js';

// Define UI-specific types
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface ScenarioItem {
  id: string;
  name: string;
  config: ScenarioConfiguration;
  history: ChatMessage[];
  created: number;
  modified: number;
}

// API base URL - configurable for development vs production
const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001';

// API client functions
const api = {
  async getScenarios() {
    const response = await fetch(`${API_BASE_URL}/api/scenarios`);
    return response.json();
  },
  
  async getScenario(id: string) {
    const response = await fetch(`${API_BASE_URL}/api/scenarios/${id}`);
    return response.json();
  },
  
  async createScenario(name: string, config: ScenarioConfiguration, history: ChatMessage[] = []) {
    const response = await fetch(`${API_BASE_URL}/api/scenarios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config, history })
    });
    return response.json();
  },
  
  async updateScenario(id: string, updates: Partial<ScenarioItem>) {
    const response = await fetch(`${API_BASE_URL}/api/scenarios/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    return response.json();
  },
  
  async updateScenarioConfig(id: string, config: ScenarioConfiguration) {
    const response = await fetch(`${API_BASE_URL}/api/scenarios/${id}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    return response.json();
  },
  
  async addMessage(id: string, role: string, content: string) {
    const response = await fetch(`${API_BASE_URL}/api/scenarios/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content })
    });
    return response.json();
  },
  
  async deleteScenario(id: string) {
    const response = await fetch(`${API_BASE_URL}/api/scenarios/${id}`, {
      method: 'DELETE'
    });
    return response.json();
  },
  
  async chatWithScenario(id: string, message: string, history: ChatMessage[]) {
    const response = await fetch(`${API_BASE_URL}/api/llm/scenario-chat/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The body no longer includes an apiKey
      body: JSON.stringify({ message, history })
    });
    return response.json();
  }
};

// Utility functions
const formatJSON = (obj: any) => JSON.stringify(obj, null, 2);

const randomId = (prefix = 'scen') => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const formatTime = (timestamp: number) => {
  return new Date(timestamp).toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
};

// Apply JSON Patch operations to a scenario configuration
const applyPatchesToScenario = (scenario: ScenarioConfiguration, patches: any[]): ScenarioConfiguration => {
  try {
    // Create a deep copy to avoid mutating the original
    const scenarioCopy = JSON.parse(JSON.stringify(scenario));
    
    // Apply patches
    const result = applyPatch(scenarioCopy, patches);
    
    // Return the patched scenario
    return result.newDocument;
  } catch (error) {
    console.error('Failed to apply patches:', error);
    throw new Error(`Patch application failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

// Component: Badge for displaying status/types
interface BadgeProps {
  children: React.ReactNode;
  color?: 'indigo' | 'emerald' | 'rose' | 'gray' | 'yellow';
}

function Badge({ children, color = 'indigo' }: BadgeProps) {
  const colorMap = {
    indigo: 'bg-indigo-100 text-indigo-700',
    emerald: 'bg-emerald-100 text-emerald-700',
    rose: 'bg-rose-100 text-rose-700',
    gray: 'bg-gray-100 text-gray-700',
    yellow: 'bg-yellow-100 text-yellow-700'
  };
  
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colorMap[color]}`}>
      {children}
    </span>
  );
}

// Component: Tool display with terminal classification
interface ToolChipProps {
  tool: {
    toolName: string;
    description: string;
    inputSchema: any;
    outputDescription: string;
    synthesisGuidance: string;
  };
}

function ToolChip({ tool }: ToolChipProps) {
  const isSuccess = /Approval$|Success$/.test(tool.toolName);
  const isFailure = /Denial$|Failure$|NoSlots$/.test(tool.toolName);
  
  return (
    <div className="flex items-start gap-3 p-3 bg-gray-50 border border-gray-200 rounded-md">
      <div className="mt-0.5">
        {isSuccess ? (
          <Badge color="emerald">Terminal Success</Badge>
        ) : isFailure ? (
          <Badge color="rose">Terminal Failure</Badge>
        ) : (
          <Badge color="gray">Ongoing</Badge>
        )}
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-gray-800">{tool.toolName}</p>
        </div>
        <p className="text-sm text-gray-700 mt-1">{tool.description}</p>
        <details className="mt-2">
          <summary className="text-xs text-gray-500 cursor-pointer">Details</summary>
          <div className="mt-1 space-y-1">
            <p className="text-xs text-gray-500">
              <span className="font-medium">Input Schema:</span> {JSON.stringify(tool.inputSchema)}
            </p>
            <p className="text-xs text-gray-500">
              <span className="font-medium">Output:</span> {tool.outputDescription}
            </p>
            <p className="text-xs text-gray-500">
              <span className="font-medium">Synthesis:</span> {tool.synthesisGuidance}
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}

// Component: Clean section card without collapse functionality
interface SectionCardProps {
  title: string;
  children: React.ReactNode;
  onEdit?: () => void;
  subtitle?: string;
}

function SectionCard({ title, children, onEdit, subtitle }: SectionCardProps) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
          {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
        </div>
        {onEdit && (
          <button 
            onClick={onEdit} 
            className="text-xs px-2 py-1 rounded-md bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
          >
            Edit JSON
          </button>
        )}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// Component: JSON display block
interface JSONBlockProps {
  value: any;
  editable?: boolean;
  onChange?: (value: any) => void;
}

function JSONBlock({ value, editable = false, onChange }: JSONBlockProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [error, setError] = useState('');
  
  const startEditing = () => {
    setEditContent(formatJSON(value));
    setError('');
    setIsEditing(true);
  };
  
  const saveEdit = () => {
    try {
      const parsed = JSON.parse(editContent);
      onChange?.(parsed);
      setIsEditing(false);
      setError('');
    } catch (err) {
      setError('Invalid JSON format');
    }
  };
  
  const cancelEdit = () => {
    setIsEditing(false);
    setError('');
  };
  
  if (isEditing) {
    return (
      <div className="space-y-2">
        <textarea
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          className="w-full h-64 bg-gray-50 border border-gray-200 rounded-md p-3 text-xs text-gray-800 font-mono"
          placeholder="Enter valid JSON..."
        />
        {error && (
          <p className="text-xs text-red-600">{error}</p>
        )}
        <div className="flex gap-2">
          <button
            onClick={saveEdit}
            className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
          >
            Save
          </button>
          <button
            onClick={cancelEdit}
            className="px-3 py-1 text-xs bg-gray-600 text-white rounded hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }
  
  return (
    <div className="relative">
      <pre className="bg-gray-50 border border-gray-200 rounded-md p-3 text-xs text-gray-800 overflow-auto json-editor">
        {formatJSON(value)}
      </pre>
      {editable && (
        <button
          onClick={startEditing}
          className="absolute top-2 right-2 px-2 py-1 text-xs bg-white border border-gray-300 rounded shadow hover:bg-gray-50"
        >
          Edit
        </button>
      )}
    </div>
  );
}

// Component: Field display for structured data
interface FieldProps {
  label: string;
  value: string | number;
  description?: string;
}

function Field({ label, value, description }: FieldProps) {
  return (
    <div>
      <p className="text-sm text-gray-600">{label}</p>
      <p className="text-sm font-medium text-gray-800">{value}</p>
      {description && <p className="text-xs text-gray-500 mt-1">{description}</p>}
    </div>
  );
}

// Component: Text content display
interface TextContentProps {
  label: string;
  value: string;
  description?: string;
}

function TextContent({ label, value, description }: TextContentProps) {
  return (
    <div>
      <p className="text-sm font-medium text-gray-800 mb-2">{label}</p>
      {description && <p className="text-xs text-gray-500 mb-3">{description}</p>}
      <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
        <p className="text-sm text-gray-700 whitespace-pre-wrap">{value}</p>
      </div>
    </div>
  );
}

// Component: Generic JSON field for flexible content
interface JSONFieldProps {
  label: string;
  value: any;
  description?: string;
  editable?: boolean;
  onChange?: (value: any) => void;
}

function JSONField({ label, value, description, editable = false, onChange }: JSONFieldProps) {
  return (
    <div>
      <p className="text-sm font-medium text-gray-800 mb-2">{label}</p>
      {description && <p className="text-xs text-gray-500 mb-3">{description}</p>}
      <JSONBlock value={value} editable={editable} onChange={onChange} />
    </div>
  );
}

// Component: Modal dialog
interface ModalProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}

function Modal({ open, title, children, onClose }: ModalProps) {
  if (!open) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-gray-900 opacity-40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-lg border border-gray-200 w-full max-w-3xl mx-4">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-gray-800">{title}</h4>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-sm">
            Close
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

// Main App Component
function App() {
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rightTab, setRightTab] = useState<'overview' | 'json'>('overview');
  const [chatInput, setChatInput] = useState('');
  const [pendingChanges, setPendingChanges] = useState<{[scenarioId: string]: ScenarioConfiguration}>({});
  const [sendingMessage, setSendingMessage] = useState(false);
  
  // Editor modal state
  const [editOpen, setEditOpen] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editError, setEditError] = useState('');
  const [editCallback, setEditCallback] = useState<((data: any) => Promise<void>) | null>(null);
  
  const chatBottomRef = useRef<HTMLDivElement>(null);
  
  // Load scenarios on mount
  useEffect(() => {
    loadScenarios();
  }, []);
  
  // Auto-scroll chat
  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [scenarios.find(s => s.id === activeId)?.history?.length]);
  
  const activeScenario = useMemo(() => {
    return scenarios.find(s => s.id === activeId) || null;
  }, [scenarios, activeId]);
  
  // Get the current config (pending changes or saved config)
  const currentConfig = useMemo(() => {
    if (!activeScenario) return null;
    return pendingChanges[activeScenario.id] || activeScenario.config;
  }, [activeScenario, pendingChanges]);
  
  // Check if there are pending changes for the active scenario
  const hasPendingChanges = useMemo(() => {
    return activeId ? Boolean(pendingChanges[activeId]) : false;
  }, [activeId, pendingChanges]);
  
  const loadScenarios = async () => {
    try {
      setLoading(true);
      const response = await api.getScenarios();
      if (response.success) {
        setScenarios(response.data.scenarios);
        if (response.data.scenarios.length > 0 && !activeId) {
          setActiveId(response.data.scenarios[0].id);
        }
      }
    } catch (error) {
      console.error('Failed to load scenarios:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const savePendingChanges = async () => {
    if (!activeId || !pendingChanges[activeId]) return;
    
    try {
      await api.updateScenarioConfig(activeId, pendingChanges[activeId]);
      
      // Clear pending changes for this scenario
      setPendingChanges(prev => {
        const updated = { ...prev };
        delete updated[activeId];
        return updated;
      });
      
      // Reload scenarios to get updated data
      loadScenarios();
    } catch (error) {
      console.error('Failed to save changes:', error);
    }
  };
  
  const discardPendingChanges = () => {
    if (!activeId) return;
    
    // Clear pending changes for this scenario
    setPendingChanges(prev => {
      const updated = { ...prev };
      delete updated[activeId];
      return updated;
    });
  };
  
  const updatePendingConfig = (newConfig: ScenarioConfiguration) => {
    if (!activeId) return;
    
    // Update pending changes for this scenario
    setPendingChanges(prev => ({
      ...prev,
      [activeId]: newConfig
    }));
  };
  
  const sendMessage = async () => {
    if (!chatInput.trim() || !activeId || sendingMessage) return;
    
    try {
      setSendingMessage(true);
      
      // Add user message to chat history
      await api.addMessage(activeId, 'user', chatInput.trim());
      
      const userMessage = chatInput.trim();
      setChatInput('');
      
      // Call the LLM endpoint with full chat history
      const llmResponse = await api.chatWithScenario(activeId, userMessage, activeScenario.history);
      
      if (llmResponse.success) {
        const { assistantMessage, patches = [], replaceEntireScenario } = llmResponse.data;
        
        // Add assistant message to chat history
        await api.addMessage(activeId, 'assistant', assistantMessage);
        
        // Apply changes to working copy (client-side only)
        if (patches.length > 0 || replaceEntireScenario) {
          const currentScenario = activeScenario;
          if (currentScenario) {
            let updatedConfig: ScenarioConfiguration;
            
            if (replaceEntireScenario) {
              // Complete replacement
              updatedConfig = replaceEntireScenario;
            } else {
              // Apply patches to current config (or pending changes if any)
              const baseConfig = pendingChanges[activeId] || currentScenario.config;
              updatedConfig = applyPatchesToScenario(baseConfig, patches);
            }
            
            // Store in pending changes (not saved to backend yet)
            setPendingChanges(prev => ({
              ...prev,
              [activeId]: updatedConfig
            }));
          }
        }
      } else {
        // Handle error response
        const errorMessage = llmResponse.error || 'Failed to process your request';
        await api.addMessage(activeId, 'assistant', `Sorry, I encountered an error: ${errorMessage}`);
      }
      
      // Reload scenarios to get updated chat history
      loadScenarios();
    } catch (error) {
      console.error('Failed to send message:', error);
      // Add error message to chat
      try {
        await api.addMessage(activeId, 'assistant', `I encountered an error processing your request: ${error instanceof Error ? error.message : 'Unknown error'}`);
        loadScenarios();
      } catch (addMessageError) {
        console.error('Failed to add error message:', addMessageError);
      }
    } finally {
      setSendingMessage(false);
    }
  };
  
  const openEditor = (title: string, content: any, callback: (data: any) => Promise<void>) => {
    setEditTitle(title);
    setEditContent(typeof content === 'string' ? content : formatJSON(content));
    setEditCallback(() => callback);
    setEditError('');
    setEditOpen(true);
  };
  
  const saveEditor = async () => {
    try {
      const parsed = JSON.parse(editContent);
      if (editCallback) {
        await editCallback(parsed);
      }
      setEditOpen(false);
      loadScenarios();
    } catch (error) {
      setEditError((error as Error).message || 'Invalid JSON');
    }
  };
  
  const createNewScenario = async () => {
    const newConfig: ScenarioConfiguration = {
      scenarioMetadata: {
        id: randomId('scen'),
        title: 'New Scenario',
        schemaVersion: '2.4',
        description: 'A new scenario ready for customization.'
      },
      patientAgent: {
        principalIdentity: 'Patient Agent',
        systemPrompt: 'You are a patient-side AI agent.',
        clinicalSketch: {},
        tools: []
      },
      supplierAgent: {
        principalIdentity: 'Supplier Agent',
        systemPrompt: 'You are a supplier-side AI agent.',
        operationalContext: {},
        tools: []
      },
      interactionDynamics: {
        startingPoints: {
          PatientAgent: { objective: 'Complete the scenario objective.' },
          SupplierAgent: { objective: 'Complete the scenario objective.' }
        }
      }
    };
    
    const history: ChatMessage[] = [{
      id: randomId('msg'),
      role: 'assistant',
      content: 'Created new scenario. Use chat commands or edit JSON directly to customize.',
      timestamp: Date.now()
    }];
    
    try {
      const response = await api.createScenario('New Scenario', newConfig, history);
      if (response.success) {
        setActiveId(response.data.id);
        loadScenarios();
      }
    } catch (error) {
      console.error('Failed to create scenario:', error);
    }
  };
  
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-2 text-gray-600">Loading scenarios...</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-gray-900">
                Scenario Builder for Language-First Interoperability
              </h1>
              <p className="text-sm text-gray-600">Schema v2.4 • Chat to refine, click to edit JSON.</p>
            </div>
            <div className="flex items-center gap-2">
              <select
                className="bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm"
                value={activeId || ''}
                onChange={(e) => setActiveId(e.target.value)}
              >
                <option value="">Select Scenario</option>
                {scenarios.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <button
                onClick={createNewScenario}
                className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-700"
              >
                Build New Scenario
              </button>
            </div>
          </div>
        </div>
      </header>

      {!activeScenario ? (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="text-center">
            <p className="text-gray-600">Select a scenario to get started, or create a new one.</p>
          </div>
        </div>
      ) : (
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {/* Pending Changes Bar */}
          {hasPendingChanges && (
            <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <div className="w-2 h-2 bg-yellow-400 rounded-full mr-3"></div>
                  <div>
                    <p className="text-sm font-medium text-yellow-800">Unsaved Changes</p>
                    <p className="text-xs text-yellow-600">The scenario has been modified but not saved to the backend.</p>
                  </div>
                </div>
                <div className="flex space-x-3">
                  <button
                    onClick={discardPendingChanges}
                    className="px-3 py-1 text-xs font-medium text-yellow-700 bg-white border border-yellow-300 rounded hover:bg-yellow-50"
                  >
                    Discard
                  </button>
                  <button
                    onClick={savePendingChanges}
                    className="px-3 py-1 text-xs font-medium text-white bg-yellow-600 rounded hover:bg-yellow-700"
                  >
                    Save Changes
                  </button>
                </div>
              </div>
            </div>
          )}
          
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Conversation Panel */}
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm flex flex-col">
              <div className="px-4 py-3 border-b border-gray-200">
                <h2 className="text-sm font-semibold text-gray-800">Conversation</h2>
                <p className="text-xs text-gray-500">Primary method to refine the scenario via chat commands.</p>
              </div>
              
              <div className="p-4 flex-1 conversation-panel">
                <div className="space-y-3">
                  {activeScenario.history.map(message => (
                    <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-full sm:max-w-md rounded-lg px-3 py-2 text-sm ${
                        message.role === 'user' 
                          ? 'bg-indigo-600 text-white' 
                          : 'bg-gray-100 text-gray-800'
                      }`}>
                        <p className="whitespace-pre-wrap">{message.content}</p>
                        <p className={`text-[10px] mt-1 ${
                          message.role === 'user' ? 'text-indigo-100' : 'text-gray-500'
                        }`}>
                          {formatTime(message.timestamp)}
                        </p>
                      </div>
                    </div>
                  ))}
                  <div ref={chatBottomRef} />
                </div>
              </div>
              
              <div className="px-4 py-3 border-t border-gray-200">
                <div className="flex items-center gap-2">
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    placeholder="Try: Set patient EF to 25% and add expedited criteria..."
                    className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <button 
                    onClick={sendMessage}
                    disabled={sendingMessage || !chatInput.trim()}
                    className={`px-4 py-2 rounded-md text-white text-sm ${
                      sendingMessage || !chatInput.trim()
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-indigo-600 hover:bg-indigo-700'
                    }`}
                  >
                    {sendingMessage ? 'Sending...' : 'Send'}
                  </button>
                </div>
                
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => setChatInput("Add timeline entry 2024-07-10: Follow-up appointment scheduled")}
                    className="px-2 py-1 rounded-md bg-gray-100 text-gray-800 text-xs hover:bg-gray-200"
                  >
                    + Timeline Entry
                  </button>
                  <button
                    onClick={() => setChatInput("Set EF to 25% and mark as expedited")}
                    className="px-2 py-1 rounded-md bg-gray-100 text-gray-800 text-xs hover:bg-gray-200"
                  >
                    + Set EF & Expedite
                  </button>
                  <button
                    onClick={() => setChatInput("Add records gap between 2018 and 2020")}
                    className="px-2 py-1 rounded-md bg-gray-100 text-gray-800 text-xs hover:bg-gray-200"
                  >
                    + Records Gap
                  </button>
                </div>
              </div>
            </div>

            {/* Structured View Panel */}
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                <div>
                  <h2 className="text-sm font-semibold text-gray-800">Structured View</h2>
                  <p className="text-xs text-gray-500">Live scaffold of the scenario JSON.</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="bg-gray-100 rounded-lg p-1">
                    <button
                      onClick={() => setRightTab('overview')}
                      className={`px-3 py-1 text-sm rounded-md ${
                        rightTab === 'overview' ? 'bg-white shadow text-gray-900' : 'text-gray-600'
                      }`}
                    >
                      Overview
                    </button>
                    <button
                      onClick={() => setRightTab('json')}
                      className={`px-3 py-1 text-sm rounded-md ${
                        rightTab === 'json' ? 'bg-white shadow text-gray-900' : 'text-gray-600'
                      }`}
                    >
                      JSON
                    </button>
                  </div>
                  {rightTab === 'json' && (
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(formatJSON(currentConfig));
                        alert('JSON copied to clipboard!');
                      }}
                      className="text-sm bg-gray-100 text-gray-800 px-3 py-1.5 rounded-md hover:bg-gray-200"
                    >
                      Copy JSON
                    </button>
                  )}
                </div>
              </div>

              <div className="p-4 structured-view">
                {rightTab === 'json' ? (
                  <JSONBlock 
                    value={currentConfig} 
                    editable={true} 
                    onChange={updatePendingConfig}
                  />
                ) : (
                  <div className="space-y-4">
                    {currentConfig && (
                      <>
                        {/* Scenario Metadata */}
                        <SectionCard
                          title="Scenario Metadata"
                          subtitle="Fixed structure; required by Agent Runtime."
                          onEdit={() => openEditor(
                            'Edit Scenario Metadata',
                            currentConfig.scenarioMetadata,
                            async (newMetadata) => {
                              const newConfig = { ...currentConfig, scenarioMetadata: newMetadata };
                              updatePendingConfig(newConfig);
                            }
                          )}
                        >
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <Field 
                              label="ID" 
                              value={currentConfig.scenarioMetadata.id}
                              description="Unique identifier for this scenario"
                            />
                            <Field 
                              label="Title" 
                              value={currentConfig.scenarioMetadata.title}
                            />
                            <Field 
                              label="Schema Version" 
                              value={currentConfig.scenarioMetadata.schemaVersion}
                              description="Schema version for compatibility"
                            />
                            <div className="md:col-span-2">
                              <Field 
                                label="Description" 
                                value={currentConfig.scenarioMetadata.description}
                              />
                            </div>
                          </div>
                        </SectionCard>

                        {/* Patient Agent */}
                        <SectionCard
                          title="Patient Agent"
                          subtitle="Identity, prompt, ground-truth clinicalSketch, tools and behavior."
                          onEdit={() => openEditor(
                            'Edit Patient Agent',
                            currentConfig.patientAgent,
                            async (newPatientAgent) => {
                              const newConfig = { ...currentConfig, patientAgent: newPatientAgent };
                              updatePendingConfig(newConfig);
                            }
                          )}
                        >
                          <div className="space-y-6">
                            <Field 
                              label="Principal Identity" 
                              value={currentConfig.patientAgent.principalIdentity}
                              description="The human this agent represents"
                            />
                            
                            <TextContent
                              label="System Prompt"
                              value={currentConfig.patientAgent.systemPrompt}
                              description="The prompt defining the AI assistant's role and goals"
                            />

                            <JSONField
                              label="Clinical Sketch (Ground Truth)"
                              value={currentConfig.patientAgent.clinicalSketch}
                              description="Patient's medical history and current condition - flexible payload"
                            />

                            {currentConfig.patientAgent.behavioralParameters && (
                              <JSONField
                                label="Behavioral Parameters"
                                value={currentConfig.patientAgent.behavioralParameters}
                                description="Optional behavioral settings - flexible payload"
                              />
                            )}

                            <div>
                              <div className="text-sm font-medium text-gray-800 mb-3">
                                Tools ({(currentConfig.patientAgent.tools || []).length})
                              </div>
                              <div className="space-y-3">
                                {(currentConfig.patientAgent.tools || []).map((tool, idx) => (
                                  <ToolChip key={idx} tool={tool} />
                                ))}
                              </div>
                            </div>
                          </div>
                        </SectionCard>

                        {/* Supplier Agent */}
                        <SectionCard
                          title="Supplier Agent"
                          subtitle="Identity, prompt, operational context, tools and decision framework."
                          onEdit={() => openEditor(
                            'Edit Supplier Agent',
                            currentConfig.supplierAgent,
                            async (newSupplierAgent) => {
                              const newConfig = { ...currentConfig, supplierAgent: newSupplierAgent };
                              updatePendingConfig(newConfig);
                            }
                          )}
                        >
                          <div className="space-y-6">
                            <Field 
                              label="Principal Identity" 
                              value={currentConfig.supplierAgent.principalIdentity}
                              description="The human this agent represents"
                            />
                            
                            <TextContent
                              label="System Prompt"
                              value={currentConfig.supplierAgent.systemPrompt}
                              description="The prompt defining the AI assistant's role and goals"
                            />

                            <JSONField
                              label="Operational Context"
                              value={currentConfig.supplierAgent.operationalContext}
                              description="Ground truth for the principal's environment - flexible payload"
                            />

                            {currentConfig.supplierAgent.decisionFramework && (
                              <JSONField
                                label="Decision Framework"
                                value={currentConfig.supplierAgent.decisionFramework}
                                description="Optional decision-making parameters - flexible payload"
                              />
                            )}

                            <div>
                              <div className="text-sm font-medium text-gray-800 mb-3">
                                Tools ({(currentConfig.supplierAgent.tools || []).length})
                              </div>
                              <div className="space-y-3">
                                {(currentConfig.supplierAgent.tools || []).map((tool, idx) => (
                                  <ToolChip key={idx} tool={tool} />
                                ))}
                              </div>
                            </div>
                          </div>
                        </SectionCard>

                        {/* Interaction Dynamics */}
                        <SectionCard
                          title="Interaction Dynamics"
                          subtitle="Starting points for both agents and negotiation hotspots."
                          onEdit={() => openEditor(
                            'Edit Interaction Dynamics',
                            currentConfig.interactionDynamics,
                            async (newDynamics) => {
                              const newConfig = { ...currentConfig, interactionDynamics: newDynamics };
                              updatePendingConfig(newConfig);
                            }
                          )}
                        >
                          <div className="space-y-6">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <Field
                                label="PatientAgent Starting Objective"
                                value={currentConfig.interactionDynamics?.startingPoints?.PatientAgent?.objective || 'Not specified'}
                                description="What the patient agent aims to achieve"
                              />
                              <Field
                                label="SupplierAgent Starting Objective"
                                value={currentConfig.interactionDynamics?.startingPoints?.SupplierAgent?.objective || 'Not specified'}
                                description="What the supplier agent aims to achieve"
                              />
                            </div>
                            
                            {currentConfig.interactionDynamics?.criticalNegotiationPoints && 
                             currentConfig.interactionDynamics.criticalNegotiationPoints.length > 0 && (
                              <div>
                                <div className="text-sm font-medium text-gray-800 mb-3">
                                  Critical Negotiation Points ({currentConfig.interactionDynamics.criticalNegotiationPoints.length})
                                </div>
                                <div className="space-y-3">
                                  {currentConfig.interactionDynamics.criticalNegotiationPoints.map((point, idx) => (
                                    <div key={idx} className="p-3 bg-gray-50 border border-gray-200 rounded-md">
                                      <p className="text-sm font-semibold text-gray-800">{point.moment}</p>
                                      <p className="text-xs text-gray-600 mt-1">
                                        <span className="font-medium">Patient view:</span> {point.patientView}
                                      </p>
                                      <p className="text-xs text-gray-600">
                                        <span className="font-medium">Supplier view:</span> {point.supplierView}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </SectionCard>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      )}

      {/* Editor Modal */}
      <Modal open={editOpen} title={editTitle} onClose={() => setEditOpen(false)}>
        <div className="space-y-3">
          <textarea
            value={editContent}
            onChange={(e) => {
              setEditContent(e.target.value);
              setEditError('');
            }}
            rows={16}
            className="w-full border border-gray-300 rounded-md p-3 text-sm font-mono text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {editError && (
            <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
              {editError}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button 
              onClick={() => setEditOpen(false)} 
              className="px-3 py-2 rounded-md bg-gray-100 text-gray-700 text-sm hover:bg-gray-200"
            >
              Cancel
            </button>
            <button 
              onClick={saveEditor} 
              className="px-3 py-2 rounded-md bg-indigo-600 text-white text-sm hover:bg-indigo-700"
            >
              Save
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// Render the app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}