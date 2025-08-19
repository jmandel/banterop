# Inline Error Reporting Design

## Overview
Currently, when a scenario-driven agent encounters an error, it sends a generic message like "I encountered an unexpected error and need to end this turn." This provides no visibility into what went wrong, making debugging difficult. This design proposes embedding detailed error information directly in message events using the existing `outcome` field.

## Problem Statement
- Generic error messages provide no debugging information
- Error logs are only visible server-side, not in the UI
- Users and developers can't understand why conversations failed
- No way to distinguish between different types of failures

## Current State

### Error Handling in ScenarioDrivenAgent
```typescript
// Current error handling
catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logLine(ctx.agentId, 'error', `Error in _processAndRespondToTurn: ${errorMessage}`);
  try {
    await this.completeTurn(ctx, "I encountered an unexpected error and need to end this turn.", timeToConcludeConversation);
  } catch (completeError) {
    // ...
  }
}
```

### MessagePayload Structure
```typescript
interface MessagePayload {
  text: string;
  attachments?: Array<{...}>;
  outcome?: {
    status: 'success' | 'failure' | 'neutral' | 'completed' | 'canceled' | 'errored';
    reason?: string;
    codes?: string[];
  };
  clientRequestId?: string;
}
```

## Proposed Design

### 1. Enhanced Error Reporting in Agents

#### Extended Outcome for Errors
When an error occurs, include detailed information in the outcome field:

```typescript
interface ErrorOutcome {
  status: 'errored';
  reason: string;           // Human-readable error summary
  codes?: string[];         // Error codes for categorization
  details?: {
    errorType?: string;     // Error class name (e.g., "TypeError", "NetworkError")
    errorMessage?: string;  // Full error message
    errorStack?: string;    // Stack trace (in development mode only)
    context?: {             // Contextual information
      agentId?: string;
      turn?: number;
      step?: number;
      tool?: string;        // Tool that failed
      llmProvider?: string; // If LLM-related
    };
    timestamp?: string;     // ISO timestamp of error
  };
}
```

#### Modified Error Handling
```typescript
private async handleError(
  ctx: TurnContext,
  error: unknown,
  location: string,
  timeToConcludeConversation: boolean
): Promise<void> {
  const errorInfo = this.extractErrorInfo(error, location);
  
  // Log server-side as before
  logLine(ctx.agentId, 'error', `${location}: ${errorInfo.message}`);
  
  // Create user-facing message with embedded error details
  const userMessage = this.formatErrorMessage(errorInfo);
  
  // Send message with detailed outcome
  await ctx.transport.postMessage({
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    text: userMessage,
    finality: timeToConcludeConversation ? 'conversation' : 'turn',
    outcome: {
      status: 'errored',
      reason: errorInfo.reason,
      codes: errorInfo.codes,
      details: {
        errorType: errorInfo.type,
        errorMessage: errorInfo.message,
        errorStack: this.includeStackTrace ? errorInfo.stack : undefined,
        context: {
          agentId: ctx.agentId,
          turn: ctx.turn,
          step: this.currentStep,
          tool: errorInfo.tool,
          llmProvider: this.llmProvider
        },
        timestamp: new Date().toISOString()
      }
    }
  });
}

private extractErrorInfo(error: unknown, location: string): ErrorInfo {
  if (error instanceof Error) {
    // Special handling for known error types
    if (error.name === 'AgentStoppedError') {
      return {
        type: 'AgentStopped',
        reason: 'Agent was stopped',
        message: error.message,
        codes: ['AGENT_STOPPED'],
        stack: error.stack
      };
    }
    
    if (error.message.includes('LLM')) {
      return {
        type: 'LLMError',
        reason: 'Language model request failed',
        message: error.message,
        codes: ['LLM_ERROR'],
        stack: error.stack
      };
    }
    
    // Generic error
    return {
      type: error.name || 'Error',
      reason: `Error in ${location}`,
      message: error.message,
      codes: ['RUNTIME_ERROR'],
      stack: error.stack
    };
  }
  
  // Non-Error thrown
  return {
    type: 'UnknownError',
    reason: `Unexpected error in ${location}`,
    message: String(error),
    codes: ['UNKNOWN_ERROR']
  };
}

private formatErrorMessage(errorInfo: ErrorInfo): string {
  // In production: user-friendly message
  if (this.isProduction) {
    return "I encountered a technical issue and need to end this turn. Please try again.";
  }
  
  // In development: include error details
  return `I encountered an error: ${errorInfo.reason}\n\nError type: ${errorInfo.type}\nDetails: ${errorInfo.message}`;
}
```

### 2. Frontend Display Enhancement

#### Watch UI Updates
Modify the ConversationView component to detect and display error outcomes:

```typescript
// In app.tsx around line 930 (message rendering)
{t.messages.map((m) => {
  const text = (m.payload as any)?.text;
  const outcome = (m.payload as any)?.outcome;
  const html = typeof text === 'string' ? marked.parse(text) : undefined;
  const isAbortedSegment = typeof t.abortSeq === 'number' && m.seq <= (t.abortSeq as number);
  const atts: Array<{ id?: string; name: string; contentType: string; docId?: string }> | undefined = 
    (m.payload as any)?.attachments;
  
  // Check for error outcome
  const isError = outcome?.status === 'errored';
  const errorDetails = outcome?.details;
  
  return (
    <div 
      key={m.seq} 
      data-block 
      className={`
        ${isError ? 'bg-rose-50 border-rose-200' : 'bg-white'} 
        rounded px-3 py-2 mb-1 shadow-sm 
        ${isAbortedSegment ? 'opacity-50' : ''}
      `}
    >
      <div className="text-gray-500 text-[0.7rem] mb-1">
        {m.type}/{m.finality}
        {isError && (
          <span className="ml-2 text-rose-600 font-semibold">ERROR</span>
        )}
      </div>
      
      {html ? (
        <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: html as string }} />
      ) : (
        <div className="whitespace-pre-wrap font-sans text-sm">
          {text ?? JSON.stringify(m.payload)}
        </div>
      )}
      
      {/* Error details panel */}
      {isError && errorDetails && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-rose-700 hover:text-rose-800 font-medium">
            Error Details: {outcome.reason || 'Unknown error'}
          </summary>
          <div className="mt-1 p-2 bg-rose-100 rounded border border-rose-200">
            {errorDetails.errorType && (
              <div><span className="font-semibold">Type:</span> {errorDetails.errorType}</div>
            )}
            {errorDetails.errorMessage && (
              <div className="mt-1">
                <span className="font-semibold">Message:</span> 
                <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[0.7rem]">
                  {errorDetails.errorMessage}
                </pre>
              </div>
            )}
            {errorDetails.context && (
              <div className="mt-1">
                <span className="font-semibold">Context:</span>
                <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[0.7rem]">
                  {JSON.stringify(errorDetails.context, null, 2)}
                </pre>
              </div>
            )}
            {errorDetails.errorStack && (
              <details className="mt-1">
                <summary className="cursor-pointer font-semibold">Stack Trace</summary>
                <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[0.65rem] text-gray-700">
                  {errorDetails.errorStack}
                </pre>
              </details>
            )}
            {errorDetails.timestamp && (
              <div className="mt-1 text-gray-600">
                <span className="font-semibold">Time:</span> {new Date(errorDetails.timestamp).toLocaleString()}
              </div>
            )}
          </div>
        </details>
      )}
      
      {/* Existing attachments rendering */}
      {Array.isArray(atts) && atts.length > 0 && (
        // ... existing attachment code ...
      )}
    </div>
  );
})}
```

### 3. Configuration

Add configuration to control error detail verbosity:

```typescript
// In agent configuration
interface AgentConfig {
  // ... existing config ...
  errorReporting?: {
    includeStackTrace?: boolean;  // Include stack traces (default: false in production)
    includeContext?: boolean;     // Include contextual info (default: true)
    verbosity?: 'minimal' | 'standard' | 'detailed'; // Level of detail
  };
}
```

Environment variables:
```bash
# Control error reporting verbosity
ERROR_REPORTING_VERBOSITY=standard  # minimal | standard | detailed
ERROR_REPORTING_INCLUDE_STACK=false # Include stack traces
ERROR_REPORTING_INCLUDE_CONTEXT=true # Include context info
```

### 4. Error Categories and Codes

Standardize error codes for better categorization:

```typescript
enum ErrorCode {
  // Agent lifecycle
  AGENT_STOPPED = 'AGENT_STOPPED',
  AGENT_TIMEOUT = 'AGENT_TIMEOUT',
  
  // LLM errors
  LLM_ERROR = 'LLM_ERROR',
  LLM_RATE_LIMIT = 'LLM_RATE_LIMIT',
  LLM_INVALID_RESPONSE = 'LLM_INVALID_RESPONSE',
  
  // Tool errors
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  TOOL_EXECUTION_ERROR = 'TOOL_EXECUTION_ERROR',
  TOOL_INVALID_ARGS = 'TOOL_INVALID_ARGS',
  
  // Scenario errors
  SCENARIO_INVALID = 'SCENARIO_INVALID',
  SCENARIO_STATE_ERROR = 'SCENARIO_STATE_ERROR',
  
  // System errors
  MAX_STEPS_EXCEEDED = 'MAX_STEPS_EXCEEDED',
  RUNTIME_ERROR = 'RUNTIME_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}
```

## Implementation Plan

### Phase 1: Basic Error Embedding
1. ✅ Extend MessagePayload outcome field to include details
2. Modify ScenarioDrivenAgent error handling to include error details
3. Update completeTurn to accept outcome parameter
4. Test with development mode verbosity

### Phase 2: Frontend Display
1. Update Watch UI to detect error outcomes
2. Add collapsible error details panel
3. Style error messages distinctively
4. Add error icon/badge to turn header

### Phase 3: Enhanced Error Context
1. Add error categorization with codes
2. Include tool-specific context
3. Add LLM provider information for LLM errors
4. Track error patterns across turns

### Phase 4: Configuration & Polish
1. Add environment-based configuration
2. Implement verbosity levels
3. Add error filtering in UI
4. Create error summary view

## Benefits

1. **Improved Debugging**: Developers can see exactly what went wrong without checking server logs
2. **User Transparency**: Users understand when and why errors occur
3. **Better Support**: Support teams can diagnose issues from conversation history
4. **Error Tracking**: Systematic error codes enable metrics and monitoring
5. **Development Efficiency**: Faster iteration during development with detailed errors

## Security Considerations

1. **Stack Traces**: Only include in development mode to avoid leaking implementation details
2. **Error Messages**: Sanitize error messages to avoid exposing sensitive data
3. **Configuration**: Ensure production defaults are conservative
4. **PII**: Never include user data or credentials in error details

## Future Enhancements

1. **Error Recovery**: Add retry mechanisms for recoverable errors
2. **Error Analytics**: Track error patterns and frequencies
3. **Custom Error Handlers**: Allow scenario-specific error handling
4. **Error Notifications**: Alert on critical errors
5. **Error Correlation**: Link related errors across turns/conversations

## Example Error Display

```
Turn 3 — medical-assistant                    14:23:45
[ERROR]

I encountered a technical issue and need to end this turn.

▼ Error Details: Language model request failed
  Type: LLMError
  Message: Request to OpenRouter failed: 429 Too Many Requests
  Context: {
    "agentId": "medical-assistant",
    "turn": 3,
    "step": 2,
    "tool": "send_message_to_agent_conversation",
    "llmProvider": "openrouter"
  }
  Time: 2024-01-15 14:23:45
```

This design provides rich error information while maintaining user-friendly messages and respecting security boundaries.