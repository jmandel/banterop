import React from "react";
import { Button, Badge } from "../../../ui";
import type { AttachmentVault } from "../../attachments-vault";

interface AttachmentBarProps {
  vault: AttachmentVault;
  onFilesSelect: (files: FileList | null) => void;
  onAnalyze: (name: string) => void;
  onOpenAttachment?: (name: string, mimeType: string, bytes?: string, uri?: string) => void;
  summarizeOnUpload: boolean;
  onToggleSummarize: (value: boolean) => void;
  summarizerModel: string;
  onSummarizerModelChange: (model: string) => void;
  providers: Array<{ name: string; models: string[] }>;
}

export const AttachmentBar: React.FC<AttachmentBarProps> = ({
  vault,
  onFilesSelect,
  onAnalyze,
  onOpenAttachment,
  summarizeOnUpload,
  onToggleSummarize,
  summarizerModel,
  onSummarizerModelChange,
  providers,
}) => {
  const localAttachments = vault.listBySource("local");
  const agentAttachments = vault.listBySource("agent");
  const [forceUpdate, setForceUpdate] = React.useState(0);

  const fileIcon = (mime: string): string => {
    const m = (mime || "").toLowerCase();
    if (m.startsWith("image/")) return "🖼️";
    if (m.includes("pdf")) return "📄";
    if (m.startsWith("text/")) return "📃";
    if (m.includes("word") || m.includes("msword") || m.includes("officedocument")) return "📄";
    if (m.includes("sheet") || m.includes("excel")) return "📊";
    return "📎";
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFilesSelect(e.target.files);
    e.target.value = ""; // Reset input
  };

  const updateAttachment = (name: string, updates: any) => {
    if (updates.private !== undefined) {
      vault.updateFlags(name, { private: updates.private });
    }
    if (updates.priority !== undefined) {
      vault.updateFlags(name, { priority: updates.priority });
    }
    if (updates.summary !== undefined || updates.keywords !== undefined) {
      const att = vault.listBySource("local").find(a => a.name === name);
      if (att) {
        vault.updateSummary(name, updates.summary ?? att.summary ?? "", updates.keywords ?? att.keywords ?? []);
      }
    }
    setForceUpdate(prev => prev + 1); // Force re-render
  };

  const removeAttachment = (name: string) => {
    vault.remove(name);
    setForceUpdate(prev => prev + 1);
  };

  return (
    <div className="space-y-4">
      {/* Upload Section */}
      <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center gap-4">
          <label className="cursor-pointer">
            <input
              type="file"
              multiple
              onChange={handleFileInput}
              className="hidden"
            />
            <Button variant="primary" as="span">
              Upload Files
            </Button>
          </label>
          <div className="flex-1">
            <label className="text-sm font-medium text-gray-700">Upload files for the planner to reference</label>
          </div>
        </div>

        {/* Settings Row */}
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={summarizeOnUpload}
              onChange={(e) => onToggleSummarize(e.target.checked)}
              className="rounded border-gray-300"
            />
            <span>Auto-summarize on upload</span>
          </label>
          
          <div className="flex items-center gap-2 text-sm">
            <span className="text-gray-600">Summarizer:</span>
            <select
              value={summarizerModel}
              onChange={(e) => onSummarizerModelChange(e.target.value)}
              className="px-2 py-1 border border-gray-300 rounded text-sm"
            >
              {providers.map((p) => (
                <optgroup key={p.name} label={p.name}>
                  {p.models.map((m) => (
                    <option key={`${p.name}:${m}`} value={m}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Local Attachments */}
      {localAttachments.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-gray-700">Your Files</h4>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (confirm('Remove all local attachments?')) {
                  localAttachments.forEach(att => vault.remove(att.name));
                  setForceUpdate(prev => prev + 1);
                }
              }}
              className="text-red-600 hover:text-red-700"
            >
              Clear All
            </Button>
          </div>
          <div className="grid gap-2">
            {localAttachments.map((att) => (
              <div
                key={`${att.name}:${att.digest}`}
                className="p-3 bg-white rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => {
                          if (onOpenAttachment && att.bytes) {
                            onOpenAttachment(att.name, att.mimeType, att.bytes, undefined);
                          }
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 rounded-lg border border-gray-200 hover:bg-gray-200 text-xs font-medium text-gray-700 cursor-pointer transition-colors"
                        title={`Open ${att.name} (${att.mimeType})`}
                      >
                        <span>{fileIcon(att.mimeType)}</span>
                        <span>{att.name}</span>
                      </button>
                      {att.private && <span title="Private">🔒</span>}
                      {att.priority && <span title="Priority">⭐</span>}
                      {att.analysisPending && (
                        <span className="text-xs text-gray-500">Analyzing...</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {att.mimeType} • {att.size.toLocaleString()} bytes
                      {att.last_inspected && (
                        <> • Last inspected: {att.last_inspected}</>
                      )}
                    </div>
                    
                    {/* Summary - single line */}
                    <div className="mt-2">
                      <input
                        type="text"
                        value={att.summary || ""}
                        onChange={(e) => updateAttachment(att.name, { summary: e.target.value })}
                        placeholder={att.private ? "Private - no summary" : "Add a one-line summary..."}
                        disabled={att.private}
                        className="w-full px-2 py-1 text-xs border border-gray-200 rounded disabled:bg-gray-50 disabled:text-gray-400"
                      />
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => updateAttachment(att.name, { private: !att.private })}
                      title={att.private ? "Make public" : "Make private"}
                    >
                      {att.private ? "🔓" : "🔒"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => updateAttachment(att.name, { priority: !att.priority })}
                      title={att.priority ? "Remove priority" : "Set priority"}
                    >
                      {att.priority ? "☆" : "⭐"}
                    </Button>
                    {!att.private && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onAnalyze(att.name)}
                        title="Analyze with AI"
                      >
                        🤖
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeAttachment(att.name)}
                      title="Remove"
                    >
                      ✕
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent Attachments */}
      {agentAttachments.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700">From Agent</h4>
          <div className="grid gap-2">
            {agentAttachments.map((att) => (
              <div
                key={`agent:${att.name}:${att.digest}`}
                className="p-3 bg-blue-50 rounded-lg border border-blue-200"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => {
                          if (onOpenAttachment) {
                            onOpenAttachment(att.name, att.mimeType, att.bytes, undefined);
                          }
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-white rounded-lg border border-blue-200 hover:bg-blue-50 text-xs font-medium text-blue-700 cursor-pointer transition-colors"
                        title={`Open ${att.name} (${att.mimeType})`}
                      >
                        <span>{fileIcon(att.mimeType)}</span>
                        <span>{att.name}</span>
                      </button>
                      <span className="text-xs text-blue-600">from agent</span>
                      {att.analysisPending && (
                        <span className="text-xs text-gray-500">Analyzing...</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {att.mimeType} • {att.size.toLocaleString()} bytes
                      {att.last_inspected && (
                        <> • Analyzed: {new Date(att.last_inspected).toLocaleDateString()}</>
                      )}
                    </div>
                    
                    {/* Summary - single line */}
                    <div className="mt-2">
                      <input
                        type="text"
                        value={att.summary || ""}
                        onChange={(e) => updateAttachment(att.name, { summary: e.target.value })}
                        placeholder="Add a one-line summary..."
                        className="w-full px-2 py-1 text-xs border border-gray-200 rounded"
                      />
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onAnalyze(att.name)}
                      title="Analyze with AI"
                    >
                      🤖
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeAttachment(att.name)}
                      title="Remove"
                    >
                      ✕
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
