import type { UnifiedEvent } from '$src/types/event.types';

/**
 * Client-side helper to coalesce events for clean presentation after abort/restart.
 * For each turn, hides events before the last abort marker.
 */
export function coalesceEvents(events: UnifiedEvent[]): UnifiedEvent[] {
  const turnGroups = new Map<number, UnifiedEvent[]>();
  
  // Group events by turn
  for (const event of events) {
    const turn = event.turn;
    if (!turnGroups.has(turn)) {
      turnGroups.set(turn, []);
    }
    turnGroups.get(turn)!.push(event);
  }
  
  const result: UnifiedEvent[] = [];
  
  // Process each turn
  for (const [turn, turnEvents] of turnGroups) {
    // Skip turn 0 (system events) - no coalescing
    if (turn === 0) {
      result.push(...turnEvents);
      continue;
    }
    
    // Find the last abort marker in this turn
    let lastAbortIndex = -1;
    for (let i = turnEvents.length - 1; i >= 0; i--) {
      const event = turnEvents[i];
      if (
        event &&
        event.type === 'trace' &&
        event.payload &&
        typeof event.payload === 'object' &&
        'type' in event.payload &&
        event.payload.type === 'turn_aborted'
      ) {
        lastAbortIndex = i;
        break;
      }
    }
    
    // If an abort marker was found, only include events from that point onward
    if (lastAbortIndex >= 0) {
      result.push(...turnEvents.slice(lastAbortIndex));
    } else {
      // No abort marker, include all events
      result.push(...turnEvents);
    }
  }
  
  // Sort by sequence to maintain order
  result.sort((a, b) => a.seq - b.seq);
  
  return result;
}

/**
 * Helper to get a clean turn narrative for UI presentation.
 * Returns turns as arrays of events, with pre-abort events hidden.
 */
export function coalesceTurns(events: UnifiedEvent[]): Map<number, UnifiedEvent[]> {
  const coalesced = coalesceEvents(events);
  const turns = new Map<number, UnifiedEvent[]>();
  
  for (const event of coalesced) {
    const turn = event.turn;
    if (!turns.has(turn)) {
      turns.set(turn, []);
    }
    turns.get(turn)!.push(event);
  }
  
  return turns;
}