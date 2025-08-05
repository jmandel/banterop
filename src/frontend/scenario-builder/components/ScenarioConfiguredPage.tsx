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
      <div className="run-container">
        <div className="error-banner">
          {error}
        </div>
      </div>
    );
  }
  
  if (!config) {
    return (
      <div className="run-container">
        <div className="loading">Loading configuration...</div>
      </div>
    );
  }
  
  return (
    <div className="run-container">
      <div className="run-header">
        <h1 className="run-title">
          {config.metadata?.conversationTitle || 'Configured Scenario'}
        </h1>
        <p className="run-description">
          {config.metadata?.conversationDescription || (isPluginMode ? 'External MCP Bridge' : 'Internal Simulation')}
        </p>
      </div>
      
      <div className="configured-content">
        {/* Left Panel - Action */}
        <div className="action-panel">
          {isPluginMode ? (
            <div className="plugin-info">
              <h2 className="panel-title">MCP Integration</h2>
              
              <div className="integration-details">
                <div className="integration-item">
                  <span className="integration-label">MCP Endpoint:</span>
                  <div className="integration-value-wrapper">
                    <code className="integration-value">
                      {mcpEndpoint}
                    </code>
                  </div>
                </div>
                
                <div className="integration-item">
                  <span className="integration-label">Configuration Token:</span>
                  <div className="integration-value-wrapper">
                    <code className="integration-value">
                      {config64?.substring(0, 20)}...
                    </code>
                  </div>
                </div>
              </div>
              
              <div className="action-buttons">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(mcpEndpoint!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="btn-full btn-secondary-full"
                >
                  {copied ? '✓ Copied!' : 'Copy MCP Endpoint URL'}
                </button>
              </div>
              
              <div className="integration-help">
                <h3>How to Connect</h3>
                <ol>
                  <li>Copy the MCP endpoint URL above</li>
                  <li>Configure your MCP client to connect to this endpoint</li>
                  <li>The conversation will appear in the list on the right</li>
                </ol>
              </div>
            </div>
          ) : (
            <div className="run-info">
              <h2 className="panel-title">Run Configuration</h2>
              
              <div className="config-summary">
                <div className="summary-item">
                  <span className="summary-label">Mode:</span>
                  <span className="summary-value">Internal Simulation</span>
                </div>
                
                <div className="summary-item">
                  <span className="summary-label">Agents:</span>
                  <span className="summary-value">
                    {config.agents.map(a => a.id).join(' ↔ ')}
                  </span>
                </div>
                
                <div className="summary-item">
                  <span className="summary-label">Initiator:</span>
                  <span className="summary-value">
                    {config.agents.find(a => a.shouldInitiateConversation)?.id || 'Not specified'}
                  </span>
                </div>
              </div>
              
              <div className="action-buttons">
                <button
                  onClick={handleRunInternal}
                  disabled={isCreating}
                  className="btn-full btn-primary-full"
                >
                  {isCreating ? 'Creating...' : 'Run Conversation'}
                </button>
              </div>
            </div>
          )}
        </div>
        
        {/* Right Panel - Conversations */}
        <div className="conversations-panel">
          <h2 className="panel-title">Conversations Based on This Configuration</h2>
          
          {conversations.length === 0 ? (
            <div className="empty-conversations">
              <p>No conversations yet</p>
              <p className="empty-hint">
                {isPluginMode 
                  ? 'Connect your MCP client to start a conversation'
                  : 'Click "Run Conversation" to start'}
              </p>
            </div>
          ) : (
            <div className="conversations-list">
              {conversations.map(conv => (
                <a 
                  key={conv.id} 
                  href={`/trace-viewer#/conversations/${conv.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`conversation-item conversation-${conv.status}`}
                >
                  <div className="conversation-header">
                    <h3 className="conversation-title">{conv.title}</h3>
                    <span className={`conversation-status status-${conv.status}`}>
                      {conv.status}
                    </span>
                  </div>
                  
                  <div className="conversation-meta">
                    <span className="conversation-time">
                      {new Date(conv.startTime).toLocaleTimeString()}
                    </span>
                    <span className="conversation-turns">
                      {conv.turnCount} turns
                    </span>
                    {conv.endStatus && (
                      <span className={`conversation-outcome outcome-${conv.endStatus}`}>
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