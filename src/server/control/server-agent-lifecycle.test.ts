import { describe, it, expect, beforeEach, mock, Mock } from 'bun:test';
import { ServerAgentLifecycleManager } from './server-agent-lifecycle';

describe('ServerAgentLifecycleManager auto-shutdown subscription', () => {
  let manager: ServerAgentLifecycleManager;
  let registry: { register: Mock<any>; unregister: Mock<any>; listRegistered: Mock<any> };
  let host: { ensure: Mock<any>; stop: Mock<any>; list: Mock<any>; stopAll: Mock<any> };
  let savedListener: ((e: any) => any) | null = null;
  let orchestrator: { subscribeAll: Mock<any>; unsubscribe: Mock<any> };

  beforeEach(() => {
    registry = {
      register: mock(async () => {}),
      unregister: mock(async () => {}),
      listRegistered: mock(async () => []),
    } as any;

    host = {
      ensure: mock(async () => {}),
      stop: mock(async () => {}),
      list: mock(() => []),
      stopAll: mock(async () => {}),
    } as any;

    manager = new ServerAgentLifecycleManager(registry as any, host as any);

    savedListener = null;
    orchestrator = {
      subscribeAll: mock((listener: any, _includeGuidance: boolean) => {
        savedListener = listener;
        return 'sub-1';
      }),
      unsubscribe: mock((_subId: string) => {}),
    } as any;
  });

  it('stops agents when a conversation-final message is observed', async () => {
    await manager.initialize(orchestrator as any);
    expect(orchestrator.subscribeAll).toHaveBeenCalled();
    expect(typeof savedListener).toBe('function');

    // Simulate a terminal message event
    await (savedListener as any)({
      type: 'message',
      finality: 'conversation',
      conversation: 42,
    });

    expect(registry.unregister).toHaveBeenCalledWith(42, undefined);
    expect(host.stop).toHaveBeenCalledWith(42);
  });

  it('does not stop on non-terminal messages', async () => {
    await manager.initialize(orchestrator as any);
    await (savedListener as any)({
      type: 'message',
      finality: 'turn',
      conversation: 7,
    });

    expect(registry.unregister).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
  });

  it('unsubscribes on shutdown', async () => {
    await manager.initialize(orchestrator as any);
    await manager.shutdown();
    expect(orchestrator.unsubscribe).toHaveBeenCalledWith('sub-1');
  });
});

