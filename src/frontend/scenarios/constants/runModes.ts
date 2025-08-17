export const RUN_MODES = {
  internal: {
    value: 'internal',
    label: 'Simulate Full Conversation',
    description: 'All agents run by server',
    disabled: false
  },
  'mcp-client': {
    value: 'mcp-client',
    label: 'Plug in External MCP Client',
    description: 'We will host a simulated MCP server',
    disabled: false
  },
  'mcp-server': {
    value: 'mcp-server',
    label: 'Plug in External MCP Server',
    description: 'We will connect a simulated MCP client',
    disabled: true
  },
  'a2a-client': {
    value: 'a2a-client',
    label: 'Plug in External A2A Client',
    description: 'We will host a simulated A2A server',
    disabled: false
  },
  'a2a-server': {
    value: 'a2a-server',
    label: 'Plug in External A2A Server',
    description: 'We will connect a simulated A2A client',
    disabled: true
  }
} as const;

export type RunModeKey = keyof typeof RUN_MODES;