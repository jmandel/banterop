import { describe, it, expect, beforeEach, afterEach, mock, Mock } from 'bun:test';
import { ConversationWatchdog } from './conversation-watchdog';
import type { Storage } from '../orchestrator/storage';
import type { OrchestratorService } from '../orchestrator/orchestrator';
import type { ServerAgentLifecycleManager } from '../control/server-agent-lifecycle';
import type { Conversation } from '$src/db/conversation.store';

describe('ConversationWatchdog', () => {
  let mockStorage: Partial<Storage>;
  let mockOrchestrator: Partial<OrchestratorService>;
  let mockLifecycleManager: Partial<ServerAgentLifecycleManager>;
  let watchdog: ConversationWatchdog;

  beforeEach(() => {

    mockStorage = {
      conversations: {
        list: mock(() => []),
      },
      events: {
        getHead: mock(() => ({ lastTurn: 0, lastClosedSeq: 0, hasOpenTurn: false })),
        getEventBySeq: mock(() => null),
      }
    } as any;

    mockOrchestrator = {
      appendEvent: mock(() => ({
        conversation: 1,
        turn: 0,
        event: 1,
        seq: 1,
        ts: new Date().toISOString()
      })),
    };

    mockLifecycleManager = {
      stop: mock(() => Promise.resolve()),
    };

    watchdog = new ConversationWatchdog(
      mockStorage as Storage,
      mockOrchestrator as OrchestratorService,
      mockLifecycleManager as ServerAgentLifecycleManager,
      1000, // intervalMs
      5000  // stalledThresholdMs
    );
  });

  afterEach(() => {
    watchdog.stop();
  });

  describe('isStalled', () => {
    it('should not mark young conversations as stalled', async () => {
      const youngConvo: Conversation = {
        conversation: 1,
        status: 'active',
        metadata: { agents: [] },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      (mockStorage.conversations!.list as Mock<any>).mockReturnValue([youngConvo]);
      
      await (watchdog as any).checkStalled();
      
      expect(mockOrchestrator.appendEvent).not.toHaveBeenCalled();
    });

    it('should mark old conversations without events as stalled', async () => {
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const oldConvo: Conversation = {
        conversation: 1,
        status: 'active',
        metadata: { agents: [] },
        createdAt: oldTime,
        updatedAt: oldTime
      };

      (mockStorage.conversations!.list as Mock<any>).mockReturnValue([oldConvo]);
      (mockStorage.events!.getHead as Mock<any>).mockReturnValue({ 
        lastTurn: 0, 
        lastClosedSeq: 0, 
        hasOpenTurn: false 
      });
      
      await (watchdog as any).checkStalled();
      
      expect(mockLifecycleManager.stop).toHaveBeenCalledWith(1);
      expect(mockOrchestrator.appendEvent).toHaveBeenCalled();
    });

    it('should respect disabled flag in conversation metadata', async () => {
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const disabledConvo: Conversation = {
        conversation: 1,
        status: 'active',
        metadata: { 
          agents: [],
          watchdog: { disabled: true }
        },
        createdAt: oldTime,
        updatedAt: oldTime
      };

      (mockStorage.conversations!.list as Mock<any>).mockReturnValue([disabledConvo]);
      
      await (watchdog as any).checkStalled();
      
      expect(mockOrchestrator.appendEvent).not.toHaveBeenCalled();
    });

    it('should use custom threshold from conversation metadata', async () => {
      const oldTime = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const customConvo: Conversation = {
        conversation: 1,
        status: 'active',
        metadata: { 
          agents: [],
          watchdog: { stalledThresholdMs: 2 * 60 * 1000 }
        },
        createdAt: oldTime,
        updatedAt: oldTime
      };

      const lastEventTime = new Date(Date.now() - 2.5 * 60 * 1000).toISOString();
      
      (mockStorage.conversations!.list as Mock<any>).mockReturnValue([customConvo]);
      (mockStorage.events!.getHead as Mock<any>).mockReturnValue({ 
        lastTurn: 1, 
        lastClosedSeq: 1, 
        hasOpenTurn: false 
      });
      (mockStorage.events!.getEventBySeq as Mock<any>).mockReturnValue({
        ts: lastEventTime
      });
      
      await (watchdog as any).checkStalled();
      
      expect(mockOrchestrator.appendEvent).toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('should respect maxCancellationsPerRun', async () => {
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const conversations: Conversation[] = [];
      
      for (let i = 1; i <= 15; i++) {
        conversations.push({
          conversation: i,
          status: 'active',
          metadata: { agents: [] },
          createdAt: oldTime,
          updatedAt: oldTime
        });
      }

      (mockStorage.conversations!.list as Mock<any>).mockReturnValue(conversations);
      (mockStorage.events!.getHead as Mock<any>).mockReturnValue({ 
        lastTurn: 0, 
        lastClosedSeq: 0, 
        hasOpenTurn: false 
      });
      
      await (watchdog as any).checkStalled();
      
      expect(mockLifecycleManager.stop).toHaveBeenCalledTimes(10);
    });
  });

  describe('stats tracking', () => {
    it('should track checked and canceled conversations', async () => {
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const conversations: Conversation[] = [
        {
          conversation: 1,
          status: 'active',
          metadata: { agents: [] },
          createdAt: oldTime,
          updatedAt: oldTime
        },
        {
          conversation: 2,
          status: 'active',
          metadata: { agents: [] },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ];

      (mockStorage.conversations!.list as Mock<any>).mockReturnValue(conversations);
      (mockStorage.events!.getHead as Mock<any>).mockReturnValue({ 
        lastTurn: 0, 
        lastClosedSeq: 0, 
        hasOpenTurn: false 
      });
      
      await (watchdog as any).checkStalled();
      
      const stats = watchdog.getStats();
      expect(stats.conversationsChecked).toBe(2);
      expect(stats.conversationsCanceled).toBe(1);
      expect(stats.errors).toBe(0);
    });

    it('should track errors', async () => {
      (mockStorage.conversations!.list as Mock<any>).mockImplementation(() => {
        throw new Error('Database error');
      });
      
      await (watchdog as any).checkStalled();
      
      const stats = watchdog.getStats();
      expect(stats.errors).toBe(1);
    });
  });

  describe('lifecycle', () => {
    it('should prevent concurrent checks', async () => {
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const convo: Conversation = {
        conversation: 1,
        status: 'active',
        metadata: { agents: [] },
        createdAt: oldTime,
        updatedAt: oldTime
      };

      let callCount = 0;
      (mockStorage.conversations!.list as Mock<any>).mockImplementation(() => {
        callCount++;
        return [convo];
      });
      
      const promise1 = (watchdog as any).checkStalled();
      const promise2 = (watchdog as any).checkStalled();
      
      await Promise.all([promise1, promise2]);
      
      expect(callCount).toBe(1);
    });

    it('should start and stop cleanly', () => {
      expect(() => {
        watchdog.start();
        watchdog.stop();
      }).not.toThrow();
    });

    it('should handle multiple start calls gracefully', () => {
      watchdog.start();
      watchdog.start();
      
      const stats = watchdog.getStats();
      expect(stats).toBeDefined();
      
      watchdog.stop();
    });
  });
});