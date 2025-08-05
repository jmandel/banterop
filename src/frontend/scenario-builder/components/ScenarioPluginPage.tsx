import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { CreateConversationRequest } from '$lib/types.js';
import { decodeConfigFromBase64URL } from '$lib/utils/config-encoding.js';
import { validateCreateConversationConfigV2 } from '$lib/utils/config-validation.js';

export function ScenarioPluginPage() {
  const { scenarioId, config64 } = useParams<{ scenarioId: string; config64: string }>();
  
  const [config, setConfig] = useState<CreateConversationRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ errors: string[]; warnings: string[] }>({
    errors: [],
    warnings: []
  });

  useEffect(() => {
    if (config64) {
      try {
        const decodedConfig = decodeConfigFromBase64URL(config64);
        setConfig(decodedConfig);
        
        const validationResult = validateCreateConversationConfigV2(decodedConfig);
        setValidation({
          errors: validationResult.errors,
          warnings: validationResult.warnings
        });
      } catch (err) {
        setError('Failed to decode configuration: ' + (err instanceof Error ? err.message : 'Unknown error'));
      }
    }
  }, [config64]);

  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <h2 className="text-xl font-semibold text-red-800 mb-2">Configuration Error</h2>
          <p className="text-red-700">{error}</p>
          <Link 
            to={`/scenarios/${scenarioId}/run`}
            className="inline-block mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Back to Configuration
          </Link>
        </div>
      </div>
    );
  }

  if (!config) {
    return <div className="p-8">Loading configuration...</div>;
  }

  const mcpEndpoint = `${window.location.origin}/api/bridge/${config64}/mcp`;
  const bridgedAgent = config.agents.find(a => 
    a.strategyType === 'bridge_to_external_mcp_server' || 
    a.strategyType === 'bridge_to_external_mcp_client'
  );

  return (
    <div className="max-w-6xl mx-auto p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">MCP Plugin Configuration</h1>
        <p className="text-gray-600">
          Connect your MCP client to participate in this conversation
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Configuration Details */}
        <div className="space-y-6">
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold mb-4">Configuration Details</h2>
            
            <div className="space-y-3">
              <div>
                <span className="font-medium">Scenario ID:</span>
                <span className="ml-2">{config.metadata.scenarioId}</span>
              </div>
              
              <div>
                <span className="font-medium">Title:</span>
                <span className="ml-2">{config.metadata.conversationTitle || 'Untitled'}</span>
              </div>

              {bridgedAgent && (
                <div>
                  <span className="font-medium">Your Role:</span>
                  <span className="ml-2 capitalize">{bridgedAgent.id}</span>
                </div>
              )}

              <div>
                <span className="font-medium">Number of Agents:</span>
                <span className="ml-2">{config.agents.length}</span>
              </div>
            </div>

            {/* Validation Status */}
            {validation.errors.length > 0 && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                <h4 className="font-medium text-red-800 mb-1">Configuration Errors:</h4>
                <ul className="list-disc list-inside text-sm text-red-700">
                  {validation.errors.map((error, i) => (
                    <li key={i}>{error}</li>
                  ))}
                </ul>
              </div>
            )}

            {validation.warnings.length > 0 && (
              <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <h4 className="font-medium text-yellow-800 mb-1">Warnings:</h4>
                <ul className="list-disc list-inside text-sm text-yellow-700">
                  {validation.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* MCP Connection Instructions */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold mb-4">How to Connect</h2>
            
            <div className="space-y-4">
              <div>
                <h3 className="font-medium mb-2">1. MCP Endpoint</h3>
                <div className="bg-gray-50 p-3 rounded">
                  <code className="text-sm break-all">{mcpEndpoint}</code>
                  <button
                    onClick={() => navigator.clipboard.writeText(mcpEndpoint)}
                    className="ml-2 text-blue-600 hover:text-blue-800 text-sm"
                  >
                    Copy
                  </button>
                </div>
              </div>

              <div>
                <h3 className="font-medium mb-2">2. Available Tools</h3>
                <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
                  <li><code>begin_chat_thread()</code> - Start a new conversation</li>
                  <li><code>send_message_to_chat_thread(conversationId, message, attachments?)</code> - Send a message</li>
                  <li><code>wait_for_reply(conversationId)</code> - Wait for response after timeout</li>
                </ul>
              </div>

              <div>
                <h3 className="font-medium mb-2">3. Example Usage</h3>
                <pre className="bg-gray-50 p-3 rounded text-xs overflow-x-auto">
{`// 1. Begin conversation
const { conversationId } = await mcp.call('begin_chat_thread');

// 2. Send a message
const response = await mcp.call('send_message_to_chat_thread', {
  conversationId,
  message: 'Hello, I need assistance',
  attachments: [{
    name: 'document.pdf',
    contentType: 'application/pdf',
    content: '<base64-content>'
  }]
});

// 3. Handle response or timeout
if (response.timeout) {
  // Wait for delayed response
  const reply = await mcp.call('wait_for_reply', { conversationId });
}`}</pre>
              </div>
            </div>
          </div>
        </div>

        {/* Full Configuration Preview */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold mb-4">Full Configuration</h2>
          
          <div className="mb-4">
            <button
              onClick={() => navigator.clipboard.writeText(JSON.stringify(config, null, 2))}
              className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
            >
              Copy JSON
            </button>
          </div>
          
          <pre className="bg-gray-50 p-4 rounded-lg overflow-x-auto text-sm">
            {JSON.stringify(config, null, 2)}
          </pre>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-8 flex gap-4">
        <Link
          to={`/scenarios/${scenarioId}/run`}
          className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
        >
          Back to Configuration
        </Link>
        
        <a
          href="/api/conversations"
          target="_blank"
          rel="noopener noreferrer"
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          View Active Conversations
        </a>
      </div>
    </div>
  );
}