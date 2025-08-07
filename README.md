# Language-First Interoperability Platform

A unified-event conversation platform implementing ground-up stateless, multi-agent conversational interoperability with append-only event logs, explicit finality, and transport-agnostic orchestration.

## Quick Start

```bash
# Install dependencies
bun install

# Run tests
bun test

# Start development server
bun run dev

# Type check
bun run typecheck
```

## Architecture

### Core Concepts

- **Unified Events**: All interactions (messages, traces, system events) in a single append-only log
- **Explicit Finality**: Messages declare when turns/conversations end
- **Stateless Workers**: Agents perform one turn and exit
- **Event-Driven**: No polling or timeouts, pure event subscriptions

### Database Schema

- `conversation_events`: Append-only event log with (conversation, turn, event) composite keys
- `attachments`: Content-addressed storage linked to message events
- `idempotency_keys`: Deduplication for retries

### Key Invariants

1. Only messages can set finality (turn/conversation)
2. No events after conversation finality
3. Traces must appear before turn-finalizing messages
4. Attachments stored atomically with events

## Testing

Tests use event-driven patterns without timeouts for deterministic results:

```bash
bun test                    # Run all tests
bun test src/db             # Database tests only
bun test src/server         # Server tests only
```

## Development

TypeScript configured with strict settings to catch errors early:
- No implicit any
- Strict null checks
- No unused variables
- Exact optional property types