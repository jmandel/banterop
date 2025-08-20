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
}

export const AttachmentBar: React.FC<AttachmentBarProps> = ({
  vault,
  onFilesSelect,
  onAnalyze,
  onOpenAttachment,
  summarizeOnUpload,
  onToggleSummarize,
}) => {
  const [forceUpdate, setForceUpdate] = React.useState(0);
  const allAttachments = React.useMemo(() => vault.listDetailed(), [vault, forceUpdate]);

  React.useEffect(() => {
    const off = vault.onChange(() => setForceUpdate((v) => v + 1));
    return () => { try { off(); } catch {} };
  }, [vault]);

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
      const att = vault.getByName(name);
      if (att) vault.updateSummary(name, updates.summary ?? att.summary ?? "", updates.keywords ?? att.keywords ?? []);
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
            <label className="text-sm font-medium text-gray-700">Upload files for your agent to reference</label>
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
        </div>
      </div>

      {/* Clear All placed close to file list */}
      {/* (moved) Clear All now appears under the Attachments header */}

      {/* Unified Attachments */}
      {allAttachments.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-gray-700">Attachments</h4>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                vault.clear();
                setForceUpdate(prev => prev + 1);
              }}
              className="text-red-600 hover:text-red-700"
            >
              Clear All
            </Button>
          </div>
          <div className="grid gap-2">
            {allAttachments.map((att) => (
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
                        <> • Last inspected: {new Date(att.last_inspected).toLocaleString()}</>
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

      
    </div>
  );
};
