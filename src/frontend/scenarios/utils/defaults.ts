export function createBlankScenario() {
  // Generate a unique ID for new scenarios to help with logging
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  // Use the explicit placeholder style for clarity
  const tempId = `please-replace-this-placeholder-${timestamp}-${random}`;
  
  return {
    metadata: { id: tempId, title: 'Please Replace This Title', description: '', background: '', challenges: [] },
    agents: []
  };
}
