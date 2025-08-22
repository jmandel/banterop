# A2A Planner Client (Browser UI)

This is a lightweight browser client for Agent‑to‑Agent (A2A) conversations. It lets you:

- Connect to an A2A JSON‑RPC endpoint
- Run a local Planner that coordinates the conversation (passthrough or LLM‑assisted)
- Upload and summarize attachments for Planner context
- View a dual‑channel transcript: User ↔ Planner, and Planner ↔ Agent (task history)

## Quick Start

1) Start the backend API/WS server:

```
bun run dev
```

2) Open the A2A Planner client:

- Navigate to `http://localhost:3000/client/index.html` (served by the script above)

3) Enter the A2A endpoint URL:

- Format: `http://localhost:3000/api/bridge/<config64>/a2a`
- The `<config64>` is a base64‑url payload that encodes the conversation meta (agents, starting agent, etc.).
- The client auto‑fetches `/.well-known/agent-card.json` from that base URL for a friendly name/description.

5) Click “Begin Planner” to start the session.

## Planner Modes

- Passthrough: Directly relays your messages to the Agent, no LLM required.
- Autostart: Planner (LLM) can initiate and decide next steps.
- Approval: Planner waits for your approval before the first send.

Notes:
- Mode selection locks once the Planner starts; stop the Planner to change it.
- Model selection only appears for non‑passthrough modes.

## Attachments

- Upload files in the Attachments panel; they appear with MIME/type and size.
- Toggle:
  - 🔒 Private: keep file out of summarization (Planner sees name only).
  - ⭐ Priority: nudge summarizer to analyze earlier.
- Auto‑summarize on upload (optional):
  - Enable the checkbox under the Attachments panel.
  - Choose an Attachment Summarizer Model (independent from the Planner model).
  - Summaries and keywords are persisted locally per file digest and editable.

## Live Behavior

- Immediate echo: When the Planner (you) sends a message to the Agent, it appears instantly in the Planner ↔ Agent transcript (optimistic). The server echo replaces it when received.
- Streaming and resubscribe:
  - First send uses `message/stream` to create the task and start streaming frames.
  - After a task exists, sends use `message/send` on the same task id.
  - The client always ensures a live `tasks/resubscribe` stream after any send and automatically reconnects with exponential backoff if the stream ends or errors.
  - On every (re)subscribe, the client subscribes first, then fetches a full `tasks/get` snapshot in the background to cover any missed frames.

## JSON‑RPC Methods the UI Uses

- `message/send`, `message/stream`: create/continue a task with message parts (text/files)
- `tasks/get`: fetch a full snapshot (status, history, artifacts)
- `tasks/resubscribe`: stream follow‑up frames (messages, status updates)
- `tasks/cancel`: stop an in‑flight conversation

The server also exposes `/.well-known/agent-card.json` per config for display.

## Session Storage

The client saves non‑sensitive UI state (endpoint, Planner mode, models, goals/instructions, attachment summaries) in `sessionStorage` for convenience. No secrets are stored, and data clears with the browser session.

## Tips

- If you only need raw relaying, choose Passthrough and skip picking a model.
- Large first messages may briefly show a browser “network error” when the initial stream is aborted on purpose after the task id is established — the UI already flips to resubscribe and continues receiving.
- You can stop and re‑start the Planner at any time without losing the current task.
