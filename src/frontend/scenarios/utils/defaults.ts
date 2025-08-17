export function createDefaultScenario() {
  // Generate a unique ID for new scenarios to help with logging
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const tempId = `new-${timestamp}-${random}`;
  
  return {
    metadata: { id: tempId, title: 'New Scenario', background: '', challenges: [] },
    agents: []
  };
}

export function createBlankScenario() {
  // Generate a unique ID for new scenarios to help with logging
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const tempId = `new-${timestamp}-${random}`;
  
  return {
    metadata: { id: tempId, title: 'New Scenario', background: '', challenges: [] },
    agents: []
  };
}
