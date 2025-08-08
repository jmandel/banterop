import { describe, it, expect } from 'bun:test';
import { StrictAlternationPolicy } from './strict-alternation-policy';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';
import type { UnifiedEvent } from '$src/types/event.types';

describe('StrictAlternationPolicy', () => {
  const policy = new StrictAlternationPolicy();
  
  const createSnapshot = (agents: Array<{ id: string; kind: 'internal' | 'external' }>): ConversationSnapshot => ({
    conversation: 1,
    status: 'active',
    metadata: {
      agents,
    },
    events: [],
    lastClosedSeq: 0,
  });
  
  const createMessageEvent = (agentId: string, finality: 'none' | 'turn' | 'conversation'): UnifiedEvent => ({
    conversation: 1,
    turn: 1,
    event: 1,
    type: 'message',
    payload: { text: 'test' },
    finality,
    ts: new Date().toISOString(),
    agentId,
    seq: 1,
  });
  
  const createTraceEvent = (agentId: string): UnifiedEvent => ({
    conversation: 1,
    turn: 1,
    event: 1,
    type: 'trace',
    payload: { thought: 'thinking' },
    finality: 'none',
    ts: new Date().toISOString(),
    agentId,
    seq: 1,
  });
  
  describe('scheduling decisions', () => {
    it('should return none when no last event', () => {
      const snapshot = createSnapshot([
        { id: 'agent-a', kind: 'internal' },
        { id: 'agent-b', kind: 'internal' },
      ]);
      
      const decision = policy.decide({ snapshot });
      expect(decision.kind).toBe('none');
    });
    
    it('should return none for non-message events', () => {
      const snapshot = createSnapshot([
        { id: 'agent-a', kind: 'internal' },
        { id: 'agent-b', kind: 'internal' },
      ]);
      
      const decision = policy.decide({ 
        snapshot, 
        lastEvent: createTraceEvent('agent-a')
      });
      expect(decision.kind).toBe('none');
    });
    
    it('should return none for message without turn finality', () => {
      const snapshot = createSnapshot([
        { id: 'agent-a', kind: 'internal' },
        { id: 'agent-b', kind: 'internal' },
      ]);
      
      const decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-a', 'none')
      });
      expect(decision.kind).toBe('none');
    });
    
    it('should schedule next internal agent after turn finality', () => {
      const snapshot = createSnapshot([
        { id: 'agent-a', kind: 'internal' },
        { id: 'agent-b', kind: 'internal' },
      ]);
      
      const decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-a', 'turn')
      });
      
      expect(decision.kind).toBe('internal');
      expect((decision as any).agentId).toBe('agent-b');
    });
    
    it('should schedule external agent after internal turn finality', () => {
      const snapshot = createSnapshot([
        { id: 'agent-a', kind: 'internal' },
        { id: 'agent-b', kind: 'external' },
      ]);
      
      const decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-a', 'turn')
      });
      
      expect(decision.kind).toBe('external');
      expect((decision as any).candidates).toEqual(['agent-b']);
      expect((decision as any).note).toContain('agent-b');
    });
    
    it('should wrap around to first agent after last agent', () => {
      const snapshot = createSnapshot([
        { id: 'agent-a', kind: 'internal' },
        { id: 'agent-b', kind: 'internal' },
        { id: 'agent-c', kind: 'internal' },
      ]);
      
      const decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-c', 'turn')
      });
      
      expect(decision.kind).toBe('internal');
      expect((decision as any).agentId).toBe('agent-a');
    });
    
    it('should handle conversation finality', () => {
      const snapshot = createSnapshot([
        { id: 'agent-a', kind: 'internal' },
        { id: 'agent-b', kind: 'internal' },
      ]);
      
      const decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-a', 'conversation')
      });
      
      expect(decision.kind).toBe('internal');
      expect((decision as any).agentId).toBe('agent-b');
    });
    
    it('should return none when less than 2 agents', () => {
      const snapshot = createSnapshot([
        { id: 'agent-a', kind: 'internal' },
      ]);
      
      const decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-a', 'turn')
      });
      
      expect(decision.kind).toBe('none');
    });
    
    it('should return none when speaker not in agent list', () => {
      const snapshot = createSnapshot([
        { id: 'agent-a', kind: 'internal' },
        { id: 'agent-b', kind: 'internal' },
      ]);
      
      const decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('unknown-agent', 'turn')
      });
      
      expect(decision.kind).toBe('none');
    });
  });
  
  describe('multi-agent scenarios', () => {
    it('should handle 3 internal agents', () => {
      const snapshot = createSnapshot([
        { id: 'agent-a', kind: 'internal' },
        { id: 'agent-b', kind: 'internal' },
        { id: 'agent-c', kind: 'internal' },
      ]);
      
      // A -> B
      let decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-a', 'turn')
      });
      expect(decision.kind).toBe('internal');
      expect((decision as any).agentId).toBe('agent-b');
      
      // B -> C
      decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-b', 'turn')
      });
      expect(decision.kind).toBe('internal');
      expect((decision as any).agentId).toBe('agent-c');
      
      // C -> A (wrap around)
      decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-c', 'turn')
      });
      expect(decision.kind).toBe('internal');
      expect((decision as any).agentId).toBe('agent-a');
    });
    
    it('should handle mixed internal and external agents', () => {
      const snapshot = createSnapshot([
        { id: 'agent-a', kind: 'internal' },
        { id: 'agent-b', kind: 'external' },
        { id: 'agent-c', kind: 'internal' },
        { id: 'agent-d', kind: 'external' },
      ]);
      
      // A (internal) -> B (external)
      let decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-a', 'turn')
      });
      expect(decision.kind).toBe('external');
      expect((decision as any).candidates).toEqual(['agent-b']);
      
      // B (external) -> C (internal)
      decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-b', 'turn')
      });
      expect(decision.kind).toBe('internal');
      expect((decision as any).agentId).toBe('agent-c');
      
      // C (internal) -> D (external)
      decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-c', 'turn')
      });
      expect(decision.kind).toBe('external');
      expect((decision as any).candidates).toEqual(['agent-d']);
      
      // D (external) -> A (internal, wrap around)
      decision = policy.decide({ 
        snapshot, 
        lastEvent: createMessageEvent('agent-d', 'turn')
      });
      expect(decision.kind).toBe('internal');
      expect((decision as any).agentId).toBe('agent-a');
    });
  });
});