import React from 'react';
import { Card, CardHeader, Badge } from '../../ui';

export function StructuredView({ config }: { config: any; onConfigChange?: (c: any) => void; isReadOnly?: boolean; scenarioId?: string; isEditMode?: boolean }) {
  const renderJsonPreview = (data: any, label: string) => {
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
      return <div className="text-gray-500 italic">No {label} defined</div>;
    }
    return (
      <pre className="font-mono text-xs bg-slate-50 border rounded p-2 overflow-x-auto whitespace-pre">
        {JSON.stringify(data, null, 2)}
      </pre>
    );
  };

  const renderTools = (tools: any[]) => {
    if (!Array.isArray(tools) || tools.length === 0) {
      return <div className="text-gray-500 italic">No tools defined</div>;
    }
    return (
      <div className="space-y-2">
        {tools.map((tool, index) => {
          const isTerminal = !!tool.endsConversation;
          let toolType: 'success'|'failure'|'neutral'|'ongoing' = 'ongoing';
          let statusText = 'Ongoing';
          if (isTerminal) {
            if (tool.conversationEndStatus) {
              toolType = tool.conversationEndStatus;
              statusText = tool.conversationEndStatus.charAt(0).toUpperCase() + tool.conversationEndStatus.slice(1);
            } else {
              const n = String(tool.toolName || '').toLowerCase();
              if (n.includes('approve') || n.includes('success')) toolType = 'success';
              else if (n.includes('deny') || n.includes('fail')) toolType = 'failure';
              else toolType = 'neutral';
              statusText = toolType.charAt(0).toUpperCase() + toolType.slice(1);
            }
          }
          const toVariant = (t: string): 'success'|'danger'|'warning'|'neutral' => (
            t === 'success' ? 'success' : t === 'failure' ? 'danger' : t === 'neutral' ? 'warning' : 'neutral'
          );
          return (
            <div key={index} className="pb-2 border-b border-gray-100 last:border-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium">{tool.toolName}</span>
                <Badge variant={toVariant(toolType)}>{isTerminal ? `Terminal (${statusText})` : 'Ongoing'}</Badge>
              </div>
              {tool.description && (
                <div className="text-xs text-gray-600 leading-relaxed">{tool.description}</div>
              )}
              {tool.synthesisGuidance && (
                <div className="text-xs text-gray-500 italic mt-1">
                  <span className="font-medium">Synthesis:</span> {tool.synthesisGuidance}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const AgentCard = ({ agentConfig }: { agentConfig: any }) => (
    <Card className="p-4">
      <CardHeader title={`Agent: ${agentConfig.agentId}`} />
      <div className="space-y-3">
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">Principal</div>
          <div className="text-sm">{agentConfig.principal?.name} ({agentConfig.principal?.type})</div>
        </div>
        <div>
        <div className="text-xs font-medium text-muted mb-1">System Prompt</div>
        <div className="text-sm whitespace-pre-wrap bg-panel border border-border p-2 rounded">{agentConfig.systemPrompt}</div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">Situation</div>
          <div className="text-sm">{agentConfig.situation}</div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">Goals</div>
          <ul className="text-sm space-y-1">
            {(agentConfig.goals || []).map((g: string, i: number) => <li key={i} className="ml-4 list-disc">{g}</li>)}
          </ul>
        </div>
        {agentConfig.messageToUseWhenInitiatingConversation && (
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">Conversation Starter</div>
          <div className="text-sm italic bg-primary-50 p-2 rounded">
              "{agentConfig.messageToUseWhenInitiatingConversation}"
            </div>
          </div>
        )}
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">Knowledge Base</div>
          {renderJsonPreview(agentConfig.knowledgeBase, 'knowledge base')}
        </div>
        <div>
        <div className="text-xs font-medium text-muted mb-1">Tools</div>
          {renderTools(agentConfig.tools)}
        </div>
      </div>
    </Card>
  );

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <CardHeader title="Metadata" />
        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">Title</div>
            <div className="text-sm">{config?.metadata?.title}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">Description</div>
            <div className="text-sm">{config?.metadata?.description || <span className="text-gray-500 italic">No description</span>}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-muted mb-1">Tags</div>
            <div className="flex flex-wrap gap-2 items-center">
              {(config?.metadata?.tags || []).map((tag: string, i: number) => (
                <Badge key={i} variant="neutral">{tag}</Badge>
              ))}
              {(!config?.metadata?.tags || config?.metadata?.tags.length === 0) && (
                <span className="text-muted italic text-xs">No tags</span>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <CardHeader title="Narrative" />
        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">Background</div>
            <div className="text-sm whitespace-pre-wrap">{config?.metadata?.background}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">Challenges</div>
            <ul className="text-sm space-y-1">
              {(config?.metadata?.challenges || []).map((c: string, i: number) => <li key={i} className="ml-4 list-disc">{c}</li>)}
            </ul>
          </div>
        </div>
      </Card>

      {(config?.agents || []).map((agent: any) => <AgentCard key={agent.agentId} agentConfig={agent} />)}
    </div>
  );
}
