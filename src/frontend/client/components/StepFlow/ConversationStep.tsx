import React from "react";
import { Button } from "../../../ui";

type FrontMsg = { id: string; role: "you" | "planner" | "system"; text: string };

interface ConversationStepProps {
  messages: FrontMsg[];
  input: string;
  onInputChange: (value: string) => void;
  onSendMessage: (text: string) => void;
  plannerStarted: boolean;
  connected: boolean;
  busy: boolean;
}

export const ConversationStep: React.FC<ConversationStepProps> = ({
  messages,
  input,
  onInputChange,
  onSendMessage,
  plannerStarted,
  connected,
  busy,
}) => {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (connected && plannerStarted && input.trim() && !busy) {
        onSendMessage(input);
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-gray-50 rounded-lg p-4">
        <p className="text-sm text-gray-700 mb-2">
          💬 Send messages to the planner to guide the conversation
        </p>
        
        <textarea
          rows={3}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!plannerStarted}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          placeholder={
            plannerStarted
              ? "Type to the planner… (constraints, preferences, confirmations)"
              : "Start the planner to begin conversation"
          }
        />
        
        <div className="flex items-center justify-between mt-2">
          <div className="text-xs text-gray-500">
            Shortcuts: <kbd className="px-1 py-0.5 bg-white rounded border">Enter</kbd> to send,{" "}
            <kbd className="px-1 py-0.5 bg-white rounded border">Shift+Enter</kbd> for newline
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => onInputChange("")}
            >
              Clear
            </Button>
            <Button
              variant="primary"
              disabled={!connected || !plannerStarted || !input.trim() || busy}
              onClick={() => onSendMessage(input)}
              title={
                !connected
                  ? "Not connected"
                  : !plannerStarted
                  ? "Start the planner"
                  : !input.trim()
                  ? "Enter a message"
                  : busy
                  ? "System busy"
                  : "Send message"
              }
            >
              Send
            </Button>
          </div>
        </div>
      </div>

      {!plannerStarted && (
        <div className="p-3 bg-yellow-50 rounded-lg">
          <p className="text-sm text-yellow-700 text-center">
            ⚠️ Planner is not running. Configure and start the planner in Step 2 to begin conversation.
          </p>
        </div>
      )}
    </div>
  );
};