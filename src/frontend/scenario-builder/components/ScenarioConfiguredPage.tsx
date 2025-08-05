import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { CreateConversationRequest, ConversationEvent } from '$lib/types.js';
import { decodeConfigFromBase64URL } from '$lib/utils/config-encoding.js';
import { WebSocketJsonRpcClient } from '$client/impl/websocket.client.js';
import { api } from '../utils/api.js';

// SHA256 utility function
async function sha256(str: string): Promise<string> {
  const bytes = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
}

interface ConversationRecord {
  id: string;
  title: string;
  startTime: number;
  status: 'active' | 'completed' | 'failed';
  turnCount: number;
  endStatus?: 'success' | 'failure' | 'neutral';
  isNew?: boolean; // For showing "New" badge
}

export function ScenarioConfiguredPage() {
  const { config64 } = useParams<{ config64: string }>();
  const navigate = useNavigate();
  
  const [config, setConfig] = useState<CreateConversationRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [copied, setCopied] = useState(false);
  const [configHash, setConfigHash] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const wsClientRef = useRef<WebSocketJsonRpcClient | null>(null);
  const subscriptionIdRef = useRef<string | null>(null);
  
  // Decode configuration and compute hash on mount
  useEffect(() => {
    if (!config64) {
      setError('No configuration provided');
      return;
    }
    
    try {
      const decoded = decodeConfigFromBase64URL(config64);
      setConfig(decoded);
      
      // Compute config hash
      sha256(config64).then(hash => {
        setConfigHash(hash);
      });
    } catch (err) {
      setError('Invalid configuration: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  }, [config64]);
  
  // Subscribe to all conversations when component mounts
  useEffect(() => {
    const connectWebSocket = async () => {
      try {
        // Use the same base URL as API calls, but with ws:// protocol
        const apiBaseUrl = api.getBaseUrl();
        const wsUrl = apiBaseUrl.replace(/^http/, 'ws') + '/api/ws';
        const client = new WebSocketJsonRpcClient(wsUrl);
        
        client.on('event', (event: ConversationEvent) => {
          handleConversationEvent(event);
        });
        
        client.on('error', (error: Error) => {
          console.error('WebSocket error:', error);
          setError('WebSocket connection error: ' + error.message);
        });
        
        await client.connect();
        wsClientRef.current = client;
        
        // Subscribe to all conversations
        const subId = await client.subscribe('*');
        subscriptionIdRef.current = subId;
        
      } catch (err) {
        console.error('Failed to connect WebSocket:', err);
        setError('Failed to connect to conversation monitoring');
      }
    };
    
    connectWebSocket();
    
    return () => {
      // Cleanup
      if (subscriptionIdRef.current && wsClientRef.current) {
        wsClientRef.current.unsubscribe(subscriptionIdRef.current).catch(console.error);
      }
      if (wsClientRef.current) {
        wsClientRef.current.disconnect();
      }
    };
  }, []);
  
  const handleConversationEvent = (event: ConversationEvent) => {
    // Check if this conversation is relevant (matches our config)
    if (!isRelevantConversation(event)) return;
    
    switch (event.type) {
      case 'conversation_created':
        const newConvo: ConversationRecord = {
          id: event.conversationId,
          title: event.data.conversation.metadata.conversationTitle || 'Untitled',
          startTime: Date.now(),
          status: 'active',
          turnCount: 0,
          isNew: true
        };
        setConversations(prev => {
          // Mark older conversations as not new
          const updated = prev.map(c => ({ ...c, isNew: false }));
          return [newConvo, ...updated];
        });
        
        // Auto-select if auto-follow is enabled
        if (autoFollow) {
          setSelectedId(event.conversationId);
        }
        
        // Remove "New" badge after 10 seconds
        setTimeout(() => {
          setConversations(prev => prev.map(c => 
            c.id === event.conversationId ? { ...c, isNew: false } : c
          ));
        }, 10000);
        break;
        
      case 'turn_completed':
        setConversations(prev => prev.map(c => 
          c.id === event.conversationId 
            ? { ...c, turnCount: c.turnCount + 1 }
            : c
        ));
        break;
        
      case 'conversation_ended':
        setConversations(prev => prev.map(c => 
          c.id === event.conversationId 
            ? { 
                ...c, 
                status: 'completed',
                endStatus: event.data.endStatus
              }
            : c
        ));
        break;
        
      case 'conversation_failed':
        setConversations(prev => prev.map(c => 
          c.id === event.conversationId 
            ? { ...c, status: 'failed' }
            : c
        ));
        break;
    }
  };
  
  const isRelevantConversation = (event: ConversationEvent): boolean => {
    if (!configHash || !event.data?.conversation?.metadata) return false;
    
    const metadata = event.data.conversation.metadata;
    
    // Primary match: configHash
    if (metadata.configHash === configHash) {
      return true;
    }
    
    // Fallback match: scenarioId + agent IDs
    if (config && metadata.scenarioId === config.metadata?.scenarioId) {
      // Check if agent IDs match
      const eventAgentIds = event.data.conversation.agents?.map((a: any) => a.id).sort();
      const configAgentIds = config.agents.map(a => a.id).sort();
      
      if (JSON.stringify(eventAgentIds) === JSON.stringify(configAgentIds)) {
        return true;
      }
    }
    
    return false;
  };
  
  const handleRunInternal = async () => {
    if (!config || !configHash || !config64) return;
    
    setIsCreating(true);
    setError(null);
    
    try {
      // Add configHash and encodedConfig64 to metadata
      const enrichedConfig: CreateConversationRequest = {
        ...config,
        metadata: {
          ...config.metadata,
          configHash,
          encodedConfig64: config64
        }
      };
      
      const response = await api.createConversation(enrichedConfig);
      if (response.success && response.data) {
        // Start the conversation only for internal simulations
        if (!isPluginMode) {
          await api.startConversation(response.data.conversation.id);
          console.log('Conversation created and started:', response.data.conversation.id);
        } else {
          console.log('Conversation created, waiting for MCP client to start:', response.data.conversation.id);
        }
        // The conversation will appear in our list via the event subscription
      } else {
        throw new Error(response.error || 'Failed to create conversation');
      }
    } catch (err) {
      setError('Failed to create conversation: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setIsCreating(false);
    }
  };
  
  const isPluginMode = config?.agents.some(a => a.strategyType === 'bridge_to_external_mcp_server');
  const mcpEndpoint = isPluginMode ? `${api.getBaseUrl()}/api/bridge/${config64}/mcp` : null;
  
  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-700">{error}</p>
        </div>
      </div>
    );
  }
  
  if (!config) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="text-gray-600">Loading configuration...</div>
      </div>
    );
  }
  
  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          {config.metadata?.conversationTitle || 'Configured Scenario'}
        </h1>
        <p className="text-gray-600">
          {config.metadata?.conversationDescription || (isPluginMode ? 'External MCP Bridge' : 'Internal Simulation')}
        </p>
      </div>
      
      {/* Configuration Details */}
      <div className="mb-6 bg-gray-50 rounded-lg p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Configuration Details</h2>
        <div className="space-y-2 text-sm">
          <div>
            <span className="font-medium text-gray-700">Scenario:</span>{' '}
            <a 
              href={`/scenario-builder#/scenarios/${config?.metadata?.scenarioId}`}
              className="text-blue-600 hover:text-blue-700 hover:underline"
            >
              {config?.metadata?.scenarioId}
            </a>
          </div>
          <div>
            <span className="font-medium text-gray-700">Agents:</span>
            <ul className="mt-1 ml-4 space-y-1">
              {config?.agents.map(agent => (
                <li key={agent.id} className="text-gray-900">
                  • {agent.id} ({agent.strategyType})
                  {agent.shouldInitiateConversation && (
                    <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">initiator</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <span className="font-medium text-gray-700">Config Hash:</span>{' '}
            <span className="font-mono text-xs text-gray-600">{configHash?.substring(0, 12)}...</span>
          </div>
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-blue-600 hover:text-blue-700">
            View Full Configuration
          </summary>
          <pre className="mt-2 p-3 bg-white rounded border border-gray-200 text-xs overflow-x-auto">
{JSON.stringify(config, null, 2)}
          </pre>
        </details>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Panel - Action */}
        <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
          {isPluginMode ? (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-gray-900">MCP Integration</h2>
              
              <div className="space-y-3">
                <div>
                  <span className="block text-sm font-medium text-gray-700 mb-1">MCP Endpoint:</span>
                  <div className="bg-gray-50 p-3 rounded-lg">
                    <code className="text-sm break-all">
                      {mcpEndpoint}
                    </code>
                  </div>
                </div>
                
                <div>
                  <span className="block text-sm font-medium text-gray-700 mb-1">Configuration Token:</span>
                  <div className="bg-gray-50 p-3 rounded-lg">
                    <code className="text-sm">
                      {config64?.substring(0, 20)}...
                    </code>
                  </div>
                </div>
              </div>
              
              <div className="pt-4">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(mcpEndpoint!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="w-full px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
                >
                  {copied ? '✓ Copied!' : 'Copy MCP Endpoint URL'}
                </button>
              </div>
              
              <div className="pt-4 border-t">
                <h3 className="font-medium text-gray-900 mb-2">How to Connect</h3>
                <ol className="list-decimal list-inside text-sm text-gray-700 space-y-1">
                  <li>Copy the MCP endpoint URL above</li>
                  <li>Configure your MCP client to connect to this endpoint</li>
                  <li>The conversation will appear in the list on the right</li>
                </ol>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-gray-900">Run Configuration</h2>
              
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-sm font-medium text-gray-700">Mode:</span>
                  <span className="text-sm text-gray-900">Internal Simulation</span>
                </div>
                
                <div className="flex justify-between">
                  <span className="text-sm font-medium text-gray-700">Agents:</span>
                  <span className="text-sm text-gray-900">
                    {config.agents.map(a => a.id).join(' ↔ ')}
                  </span>
                </div>
                
                <div className="flex justify-between">
                  <span className="text-sm font-medium text-gray-700">Initiator:</span>
                  <span className="text-sm text-gray-900">
                    {config.agents.find(a => a.shouldInitiateConversation)?.id || 'Not specified'}
                  </span>
                </div>
              </div>
              
              <div className="pt-4">
                <button
                  onClick={handleRunInternal}
                  disabled={isCreating}
                  className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  {isCreating ? 'Creating...' : 'Run Conversation'}
                </button>
              </div>
            </div>
          )}
        </div>
        
        {/* Right Panel - Conversations */}
        <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Conversations Based on This Configuration</h2>
          
          <div className="mb-4 flex items-center justify-between">
            <label className="flex items-center text-sm text-gray-600">
              <input
                type="checkbox"
                checked={autoFollow}
                onChange={(e) => setAutoFollow(e.target.checked)}
                className="mr-2"
              />
              Auto-follow newest conversation
            </label>
          </div>
          
          {conversations.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-gray-600 mb-2">No conversations yet</p>
              <p className="text-sm text-gray-500">
                {isPluginMode 
                  ? 'Connect your MCP client to start a conversation'
                  : 'Click "Run Conversation" to start'}
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {conversations.map(conv => {
                const shortId = conv.id.slice(0, 8);
                const timeStr = new Date(conv.startTime).toLocaleTimeString('en-US', { 
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                });
                
                return (
                  <li key={conv.id} className="flex items-center gap-2 text-sm">
                    <span className="text-gray-500">•</span>
                    <span className="font-mono text-xs text-gray-600">[{timeStr}]</span>
                    <span className={`px-1.5 py-0.5 text-xs rounded ${
                      conv.status === 'active' ? 'bg-blue-100 text-blue-700' :
                      conv.status === 'completed' ? 'bg-green-100 text-green-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {conv.status}
                    </span>
                    <span className="text-gray-600">{conv.turnCount} turns</span>
                    <a 
                      href={`/trace-viewer#/conversations/${conv.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => {
                        setSelectedId(conv.id);
                        setConversations(prev => prev.map(c => 
                          c.id === conv.id ? { ...c, isNew: false } : c
                        ));
                      }}
                      className={`font-mono text-xs hover:underline ${
                        selectedId === conv.id ? 'text-blue-600 font-semibold' : 'text-blue-500'
                      }`}
                    >
                      {shortId}
                    </a>
                    {conv.isNew && (
                      <span className="px-1.5 py-0.5 text-xs bg-yellow-100 text-yellow-700 rounded font-semibold">
                        New
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}