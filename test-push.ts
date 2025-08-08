#!/usr/bin/env bun
// Simple test to verify push events are working

import { WsJsonRpcClient } from './src/agents/clients/ws.client';

const port = 3000; // Assume server is running
const wsUrl = `ws://localhost:${port}/api/ws`;

async function test() {
  console.log('Creating client...');
  
  let eventCount = 0;
  const client = new WsJsonRpcClient({
    url: wsUrl,
    onEvent: (e) => {
      console.log('RECEIVED PUSH EVENT:', e);
      eventCount++;
    },
    reconnect: false,
  });
  
  // Create conversation via HTTP
  const resp = await fetch(`http://localhost:${port}/api/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Push Test' }),
  });
  const convo = await resp.json();
  const conversationId = convo.conversation as number;
  
  console.log(`Created conversation ${conversationId}`);
  
  // Subscribe
  await client.ensureSubscribed(conversationId);
  console.log('Subscribed');
  
  // Post a message
  console.log('Posting message...');
  await client.postMessage({
    conversationId,
    agentId: 'test-agent',
    text: 'Test message',
    finality: 'turn',
  });
  
  // Wait a bit to see if we get push event
  await new Promise(r => setTimeout(r, 1000));
  
  console.log(`Received ${eventCount} push events`);
  
  client.close();
}

test().catch(console.error);