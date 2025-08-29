# A2A Protocol Validation Tools

This directory contains tools for validating and testing A2A (Agent-to-Agent) Protocol implementations.

## Quick Start

```bash
# Run the setup script (creates venv and installs dependencies)
./setup.sh

# Activate the environment
source .venv/bin/activate

# Run the interactive client
./run_client.sh
```

## Manual Setup

If you prefer to set up manually:

```bash
# Using uv (recommended)
uv venv
source .venv/bin/activate
uv pip install a2a-sdk httpx

# Or using pip
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Tools

### 1. Agent Card Validator (`validate_a2a_card.py`)

Validates A2A agent cards against the protocol specification.

```bash
python validate_a2a_card.py <agent-card-url>

# Example
python validate_a2a_card.py http://localhost:3003/rooms/xyz/agent-card.json
```

### 2. Interactive A2A Client (`a2a_client.py`)

Interactive client for testing A2A server implementations.

```bash
# Connect to a specific server
python a2a_client.py <a2a-server-url>

# Use the chitchat.fhir.me test server
python a2a_client.py --chitchat

# Interactive launcher with menu
./run_client.sh
```

**Commands:**
- `/new` - Start a new conversation
- `/end` - End the current conversation
- `/quit` - Exit the client
- Any other text - Send as message to the agent

## Tested Servers

1. **localhost:3003** - FlipProxy local server
   - Requires active room ID
   - URL format: `http://localhost:3003/api/rooms/{room-id}/a2a`

2. **chitchat.fhir.me** - A2A test scenarios
   - Knee MRI Prior Auth scenario
   - Protocol v0.3.0 compatible

## Protocol Notes

The A2A SDK uses:
- Snake_case field names (e.g., `message_id`, not `messageId`)
- Lowercase enum values (e.g., `Role.user`, not `Role.USER`)
- `TransportProtocol.jsonrpc` for JSON-RPC transport
- Required fields: `message_id` for Message, `version` for AgentCard

## Features

- **Agent Card Validation**: Validate A2A agent cards against the protocol specification
- **Interactive Client**: Send messages to A2A servers and receive agent responses
- **Multiple Server Support**: Works with localhost development servers and remote A2A servers
- **Proper Polling**: Manual polling implementation to receive agent responses
- **Conversation Management**: Start new conversations, end active ones

## Requirements

- Python 3.10+
- uv (recommended) or pip
- Dependencies:
  - a2a-sdk
  - httpx