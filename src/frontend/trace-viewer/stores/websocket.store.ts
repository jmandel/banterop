import { create } from 'zustand';
import { WebSocketJsonRpcClient } from '$client/impl/websocket.client.js';
import type { ConversationEvent } from '$lib/types.js';
import { conversationStore } from './conversation.store.js';

interface WebSocketState {
  client: WebSocketJsonRpcClient | null;
  connected: boolean;
  subscriptions: Map<string, string>;
  
  connect: (endpoint: string) => Promise<void>;
  disconnect: () => Promise<void>;
  subscribe: (conversationId: string, options?: any) => Promise<string>;
  unsubscribe: (conversationId: string) => Promise<void>;
}

export const useWebSocketStore = create<WebSocketState>((set, get) => ({
  client: null,
  connected: false,
  subscriptions: new Map(),

  connect: async (endpoint: string) => {
    const { client: existingClient, disconnect } = get();
    
    if (existingClient) {
      await disconnect();
    }

    const client = new WebSocketJsonRpcClient(endpoint);
    
    client.on('error', (error: Error) => {
      console.error('WebSocket error:', error);
      conversationStore.getState().addEvent(`WebSocket error: ${error.message}`, 'error');
    });

    client.on('event', (event: ConversationEvent, subscriptionId: string) => {
      console.log('Received event:', event.type, 'subscription:', subscriptionId, 'conversation:', event.conversationId);
      
      // Always handle the event regardless of subscription type
      // The second parameter is just for determining if it's a global subscription
      const { subscriptions } = get();
      const isGlobalSubscription = subscriptionId === subscriptions.get('*');
      
      conversationStore.getState().handleEvent(event, isGlobalSubscription ? '*' : 'specific');
    });

    await client.connect();
    
    set({ client, connected: true });
    conversationStore.getState().addEvent('Connected to WebSocket server');
    
    await conversationStore.getState().loadConversations(client);
    
    const globalSubId = await get().subscribe('*');
    conversationStore.getState().setActiveTab('*');
  },

  disconnect: async () => {
    const { client, subscriptions } = get();
    
    if (!client) return;

    for (const subscriptionId of subscriptions.values()) {
      try {
        await client.unsubscribe(subscriptionId);
      } catch (error) {
        console.warn('Error during unsubscribe:', error);
      }
    }

    try {
      client.disconnect();
    } catch (error) {
      console.warn('Error during disconnect:', error);
    }

    set({ 
      client: null, 
      connected: false, 
      subscriptions: new Map() 
    });
    
    conversationStore.getState().addEvent('Disconnected from WebSocket server');
  },

  subscribe: async (conversationId: string, options?: any) => {
    const { client, subscriptions } = get();
    
    if (!client) {
      throw new Error('Not connected');
    }

    const subscriptionId = await client.subscribe(conversationId, options);
    
    set(state => ({
      subscriptions: new Map(state.subscriptions).set(conversationId, subscriptionId)
    }));

    return subscriptionId;
  },

  unsubscribe: async (conversationId: string) => {
    const { client, subscriptions } = get();
    
    if (!client) return;

    const subscriptionId = subscriptions.get(conversationId);
    if (!subscriptionId) return;

    await client.unsubscribe(subscriptionId);
    
    set(state => {
      const newSubs = new Map(state.subscriptions);
      newSubs.delete(conversationId);
      return { subscriptions: newSubs };
    });
  }
}));