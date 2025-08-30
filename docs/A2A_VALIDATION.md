# A2A JSON Schema Validation Integration

## Overview

This document describes the integration of A2A (Agent-to-Agent) protocol JSON schema validation into the Banterop server. The validation is implemented as a **non-breaking logging system** that monitors A2A protocol compliance without interrupting service operation.

## Architecture

### Key Components

1. **`src/server/core/a2a-validator.ts`**
   - Core validation module using AJV (Another JSON Schema Validator)
   - Loads official A2A JSON schemas from the submodule
   - Provides validation functions for Message, Task, and AgentCard types
   - Implements non-breaking validation with comprehensive logging

2. **Integration Points**
   - `src/server/routes/a2a.ts`: Validates incoming messages at API endpoints
   - `src/server/core/pairs.ts`: Validates messages during processing and task creation
   - `src/server/routes/wellKnown.ts`: Provides A2A-compliant Agent Card

## Validation Coverage

### Message Validation
- **Location**: `message/send` and `message/stream` endpoints
- **Schema**: A2A Message type
- **Fields validated**:
  - `role`: Must be "user" or "agent"
  - `parts`: Array of Part objects (text, file, or data)
  - `messageId`: Required string identifier
  - `kind`: Must be "message"
  - `metadata`: Optional object

### Task Validation
- **Location**: Task snapshot creation in `pairs.ts`
- **Schema**: A2A Task type
- **Fields validated**:
  - `id`: Task identifier
  - `contextId`: Context/room identifier
  - `status`: Object with state and optional message
  - `history`: Array of Message objects
  - `kind`: Must be "task"

### Agent Card Validation
- **Location**: `/.well-known/agent-card.json` endpoint
- **Schema**: A2A AgentCard type
- **Provides**: Full A2A-compliant agent manifest

## Non-Breaking Design

The validation system is designed to be completely non-breaking:

1. **Logging Only**: Validation failures are logged as warnings, never thrown as errors
2. **Service Continuity**: Invalid messages continue to be processed normally
3. **Monitoring**: Statistics endpoint tracks validation success/failure rates
4. **Debug Information**: Detailed error paths and context in logs for debugging

## Monitoring

### Validation Statistics Endpoint
```
GET /.well-known/a2a-validation-stats
```

Returns:
```json
{
  "status": "ok",
  "validationStats": {
    "totalValidations": 100,
    "failedValidations": 5,
    "byType": {
      "Message": { "total": 50, "failed": 3 },
      "Task": { "total": 40, "failed": 2 },
      "AgentCard": { "total": 10, "failed": 0 }
    }
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Log Format

Validation warnings appear in server logs as:
```
[A2A Validation Warning] 2024-01-01T00:00:00.000Z {
  type: "Message",
  context: { "pairId": "abc-123", "messageId": "msg-456" },
  errors: [
    {
      path: "/parts",
      message: "must be array",
      keyword: "type",
      params: { "type": "array" }
    }
  ],
  dataSample: "..."
}
```

## Testing

Run the test script to verify validation:
```bash
# Start the server
bun dev

# In another terminal
bun test-a2a-validation.js
```

## Future Enhancements

1. **Configurable Strictness**: Environment variable to switch between warning and error modes
2. **Metrics Export**: Prometheus/OpenTelemetry metrics for validation rates
3. **Schema Version Support**: Handle multiple A2A protocol versions
4. **Validation Reports**: Periodic reports of common validation issues
5. **Auto-correction**: Attempt to fix common validation issues automatically

## Benefits

- **Protocol Compliance**: Ensures messages conform to A2A specification
- **Debugging Aid**: Helps identify protocol implementation issues
- **Gradual Migration**: Allows transitioning to strict validation over time
- **Observability**: Provides insights into protocol usage patterns
- **Zero Downtime**: No service interruption from validation failures