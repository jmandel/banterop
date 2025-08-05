import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { CreateConversationRequest, ConversationEvent } from '$lib/types.js';
import { decodeConfigFromBase64URL } from '$lib/utils/config-encoding.js';
import { WebSocketJsonRpcClient } from '$client/impl/websocket.client.js';
import { api } from '../utils/api.js';

interface ConversationRecord {
  id: string;
  title: string;
  startTime: number;
  status: 'active' | 'completed' | 'failed';
  turnCount: number;
  endStatus?: 'success' | 'failure' | 'neutral';
}

export function ScenarioConfiguredPage() {
  const { config64 } = useParams<{ config64: string }>();
  const navigate = useNavigate();
  
  const [config, setConfig] = useState<CreateConversationRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [copied, setCopied] = useState(false);
  const wsClientRef = useRef<WebSocketJsonRpcClient | null>(null);
  const subscriptionIdRef = useRef<string | null>(null);
  
  // Decode configuration on mount
  useEffect(() => {
    if (!config64) {
      setError('No configuration provided');
      return;
    }
    
    try {
      const decoded = decodeConfigFromBase64URL(config64);
      setConfig(decoded);
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
          turnCount: 0
        };
        setConversations(prev => [newConvo, ...prev]);
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
    // Check if this event is for a conversation using our configuration
    // This would need to be implemented based on how we track config usage
    return true; // For now, show all conversations
  };
  
  const handleRunInternal = async () => {
    if (!config) return;
    
    setIsCreating(true);
    setError(null);
    
    try {
      const response = await api.createConversation(config);
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
  const mcpEndpoint = isPluginMode ? `${window.location.origin}/api/bridge/${config64}/mcp` : null;
  
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
            <div className="space-y-3">
              {conversations.map(conv => (
                <a 
                  key={conv.id} 
                  href={`/trace-viewer#/conversations/${conv.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`block p-4 rounded-lg border transition-all hover:shadow-sm ${
                    conv.status === 'active' ? 'border-blue-200 bg-blue-50' :
                    conv.status === 'completed' ? 'border-green-200 bg-green-50' :
                    'border-red-200 bg-red-50'
                  }`}
                >
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="font-medium text-gray-900">{conv.title}</h3>
                    <span className={`px-2 py-1 text-xs rounded-full ${
                      conv.status === 'active' ? 'bg-blue-100 text-blue-700' :
                      conv.status === 'completed' ? 'bg-green-100 text-green-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {conv.status}
                    </span>
                  </div>
                  
                  <div className="flex gap-4 text-sm text-gray-600">
                    <span>
                      {new Date(conv.startTime).toLocaleTimeString()}
                    </span>
                    <span>
                      {conv.turnCount} turns
                    </span>
                    {conv.endStatus && (
                      <span className={`font-medium ${
                        conv.endStatus === 'success' ? 'text-green-700' :
                        conv.endStatus === 'failure' ? 'text-red-700' :
                        'text-gray-700'
                      }`}>
                        {conv.endStatus}
                      </span>
                    )}
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}