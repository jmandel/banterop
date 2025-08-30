#!/usr/bin/env python3
"""
Simple A2A Client v2 - Corrected version with proper SDK usage
"""

import asyncio
import sys
import httpx
import uuid
import time
from typing import Optional
from a2a.client import ClientFactory, ClientConfig
from a2a.types import (
    AgentCard, 
    Message, 
    TextPart, 
    Role,
    TransportProtocol,
    Task,
    TaskState,
    TaskStatusUpdateEvent,
    TaskArtifactUpdateEvent
)
from a2a.utils import get_message_text


class SimpleA2AClient:
    def __init__(self, agent_url: str):
        self.agent_url = agent_url
        self.client = None
        self.http_client = None
        self.current_task: Optional[Task] = None
        
    def _get_agent_card_urls(self, agent_url: str) -> list[str]:
        """Get possible agent card URLs."""
        urls = []
        
        # Standard .well-known path
        if '/a2a' in agent_url:
            urls.append(agent_url.replace('/a2a', '/.well-known/agent-card.json'))
        
        # For localhost:3003 pattern
        if 'localhost:3003' in agent_url:
            urls.append(agent_url.replace('/api/rooms/', '/rooms/').replace('/a2a', '/agent-card.json'))
        
        # Direct .well-known at the end
        urls.append(agent_url + '/.well-known/agent-card.json')
        
        return urls
    
    async def connect(self):
        """Connect to the A2A server."""
        print(f"🔌 Connecting to: {self.agent_url}")
        
        try:
            # Create HTTP client with longer timeout
            self.http_client = httpx.AsyncClient(timeout=60.0)
            
            # Try different agent card URL patterns
            agent_card_data = None
            card_urls = self._get_agent_card_urls(self.agent_url)
            
            for url in card_urls:
                try:
                    print(f"   Trying: {url}")
                    response = await self.http_client.get(url)
                    if response.status_code == 200:
                        agent_card_data = response.json()
                        print(f"   ✅ Found agent card at: {url}")
                        break
                except Exception as e:
                    continue
            
            if not agent_card_data:
                print("❌ Could not fetch agent card from any URL pattern")
                return False
            
            # Parse and validate agent card
            # Add missing required 'version' field if not present (for compatibility)
            if 'version' not in agent_card_data:
                agent_card_data['version'] = '1.0.0'
            
            agent_card = AgentCard.model_validate(agent_card_data)
            print(f"✅ Connected to: {agent_card.name}")
            print(f"   Protocol: v{agent_card.protocol_version}")
            print(f"   Transport: {agent_card.preferred_transport}")
            
            # Create client using ClientFactory with correct configuration
            # Note: Streaming seems to have issues with multiple messages, so keeping it disabled
            config = ClientConfig(
                httpx_client=self.http_client,
                streaming=False,  # Disabled - causes issues with multiple responses
                polling=True,  # Enable polling to receive responses!
                supported_transports=[TransportProtocol.jsonrpc],
                use_client_preference=False,
                accepted_output_modes=["text/plain", "application/json"]
            )
            
            factory = ClientFactory(config)
            self.client = factory.create(agent_card)
            
            print("✅ Client initialized successfully\n")
            return True
            
        except Exception as e:
            print(f"❌ Connection failed: {e}")
            if self.http_client:
                await self.http_client.aclose()
            return False
    
    async def poll_for_updates(self, max_polls: int = 10, interval: float = 2.0):
        """Manually poll for task updates and messages."""
        if not self.current_task:
            return
            
        from a2a.types import TaskQueryParams
        
        poll_count = 0
        last_state = None
        messages_received = []
        last_agent_message = None  # Store the agent message persistently
        
        while poll_count < max_polls:
            poll_count += 1
            print(f"\n   Poll #{poll_count} (waiting {interval}s)...")
            await asyncio.sleep(interval)
            
            try:
                # Create query params for the task
                params = TaskQueryParams(
                    id=self.current_task.id,
                    history_length=100  # Get full history
                )
                
                # Get task update
                print(f"   Checking task {self.current_task.id}...")
                task = await self.client.get_task(params)
                
                # Check for state change
                current_state = task.status.state if hasattr(task.status, 'state') else str(task.status)
                if current_state != last_state:
                    print(f"   ✓ State changed: {last_state} → {current_state}")
                    last_state = current_state
                else:
                    print(f"   State: {current_state}")
                
                # Check for message in task.status.message
                if hasattr(task.status, 'message') and task.status.message:
                    msg = task.status.message
                    
                    # Check if this is a new agent message we haven't seen
                    msg_id = msg.message_id if hasattr(msg, 'message_id') else str(id(msg))
                    if msg_id not in messages_received:
                        messages_received.append(msg_id)
                        if msg.role == Role.agent:
                            last_agent_message = msg  # Store the agent message
                
                # Also check for messages in history
                if task.history:
                    for item in task.history:
                        if isinstance(item, Message) and item.message_id not in messages_received:
                            messages_received.append(item.message_id)
                            if item.role == Role.agent:
                                last_agent_message = item  # Store the agent message
                
                # Check if we should stop polling
                if hasattr(task.status, 'state'):
                    # Stop on input_required (agent is waiting for user input)
                    if task.status.state == TaskState.input_required:
                        if last_agent_message:
                            print(f"\n   ✅ Agent responded. Stopping polls.\n")
                            # Display the agent's message using the SDK's helper function
                            print("🤖 Agent:")
                            message_text = get_message_text(last_agent_message)
                            if message_text:
                                print(f"{message_text}")
                            else:
                                print("[No text content in agent message]")
                        else:
                            print(f"\n   ℹ️ Reached input_required state. Stopping polls.")
                            print(f"   (No agent message found in status)")
                        self.current_task = task
                        break
                    
                    # Also stop on terminal states
                    if task.status.state in [TaskState.completed, TaskState.failed, TaskState.canceled]:
                        print(f"\n   Task {task.status.state}. Stopping polls.")
                        
                        # Display the agent's final message if available
                        if task.status.state == TaskState.completed and last_agent_message:
                            print("\n🤖 Agent (final message):")
                            message_text = get_message_text(last_agent_message)
                            if message_text:
                                print(f"{message_text}")
                            else:
                                print("[No text content in agent message]")
                        
                        self.current_task = task
                        break
                        
            except Exception as e:
                print(f"   Poll error: {e}")
                
        if poll_count >= max_polls:
            print(f"\n   Reached max polls ({max_polls}). Stopping.")
    
    async def send_message(self, text: str):
        """Send a message to the agent."""
        if not self.client:
            print("❌ Not connected")
            return
        
        try:
            # Create message with proper fields
            message = Message(
                message_id=str(uuid.uuid4()),
                role=Role.user,
                parts=[TextPart(text=text)]
            )
            
            # Add task_id if we have an ongoing conversation
            if self.current_task:
                message.task_id = self.current_task.id
            
            print("📤 Sending message...")
            
            # Send message and handle response stream
            response_count = 0
            message_count = 0
            print("   Waiting for responses...")
            print(f"   [Polling enabled: {self.client._config.polling}]")
            
            async for response in self.client.send_message(message):
                if isinstance(response, tuple):
                    # Task update
                    task, event = response
                    self.current_task = task
                    print(f"\n   📋 Task Update #{response_count + 1}:")
                    print(f"      Task ID: {task.id}")
                    print(f"      Context ID: {task.context_id if task.context_id else 'None'}")
                    if hasattr(task.status, 'state'):
                        print(f"      State: {task.status.state}")
                    if hasattr(task.status, 'message'):
                        # Status message is actually a Message object
                        msg = task.status.message
                        if hasattr(msg, 'parts'):
                            for part in msg.parts:
                                if hasattr(part, 'text'):
                                    print(f"      Last message: {part.text[:100]}...")
                    else:
                        print(f"      Status: {task.status}")
                    if task.metadata:
                        print(f"      Metadata: {task.metadata}")
                    if event:
                        print(f"      Event: {type(event).__name__}")
                    response_count += 1
                    
                elif isinstance(response, Message):
                    # Message response
                    message_count += 1
                    print(f"\n📨 Received message #{message_count} (role: {response.role})")
                    
                    if response.role == Role.agent:
                        print("🤖 Agent says:")
                        for part in response.parts:
                            if hasattr(part, 'text'):
                                print(f"   {part.text}")
                    elif response.role == Role.user:
                        print("👤 User echo:")
                        for part in response.parts:
                            if hasattr(part, 'text'):
                                print(f"   {part.text}")
                    
                    response_count += 1
                else:
                    print(f"   Unknown response type: {type(response)}")
                    response_count += 1
            
            if response_count == 0:
                print("   ⚠️ No responses received")
            else:
                print(f"   Total responses: {response_count} (messages: {message_count})")
            
            # If we only got a task update and no messages, start manual polling
            if self.current_task and message_count == 0:
                print("\n   🔄 Starting manual polling for updates...")
                await self.poll_for_updates()
            
            print()
            
        except Exception as e:
            print(f"❌ Error: {e}")
            import traceback
            traceback.print_exc()
    
    async def end_conversation(self):
        """End the current conversation by setting task to completed."""
        if not self.current_task:
            print("❌ No active conversation to end")
            return
        
        try:
            from a2a.types import TaskStatusUpdateEvent, TaskStatus
            
            print("📤 Ending conversation...")
            
            # Create a status update event to mark task as completed
            status_update = TaskStatusUpdateEvent(
                task_id=self.current_task.id,
                status=TaskStatus(state=TaskState.completed)
            )
            
            # Send the status update
            await self.client.send_task_status_update(status_update)
            
            print("✅ Conversation ended")
            self.current_task = None
            
        except Exception as e:
            print(f"❌ Error ending conversation: {e}")
            # If the SDK method doesn't exist or fails, just clear locally
            print("   Clearing conversation locally")
            self.current_task = None
    
    async def run_interactive(self):
        """Run interactive chat loop."""
        print("=" * 60)
        print("A2A Interactive Client v2")
        print("=" * 60)
        print("\nCommands:")
        print("  /new   - Start a new conversation")
        print("  /end   - End the current conversation")
        print("  /quit  - Exit")
        print("  (anything else) - Send to agent\n")
        print("=" * 60 + "\n")
        
        while True:
            try:
                user_input = input("You> ").strip()
                
                if not user_input:
                    continue
                
                if user_input.lower() == '/quit':
                    print("👋 Goodbye!")
                    break
                elif user_input.lower() == '/new':
                    self.current_task = None
                    print("🆕 Starting new conversation\n")
                elif user_input.lower() == '/end':
                    await self.end_conversation()
                    print()
                else:
                    await self.send_message(user_input)
                    
            except (KeyboardInterrupt, EOFError):
                print("\n👋 Goodbye!")
                break
    
    async def disconnect(self):
        """Clean up connections."""
        if self.http_client:
            await self.http_client.aclose()


async def main():
    # Parse arguments
    if len(sys.argv) > 1:
        url = sys.argv[1]
    else:
        # Default to localhost
        url = "http://localhost:3003/api/rooms/please-replace-this-placeholder-1756426027739-gvr0wy/a2a"
    
    # Override for banterop test
    if len(sys.argv) > 1 and sys.argv[1] == '--banterop':
        url = "https://banterop.fhir.me/api/bridge/eyJ0aXRsZSI6IlJ1bjogS25lZSBNUkkgUHJpb3IgQXV0aCIsInNjZW5hcmlvSWQiOiJzY2VuX2tuZWVfbXJpXzAxIiwiYWdlbnRzIjpbeyJpZCI6InBhdGllbnQtYWdlbnQifSx7ImlkIjoiaW5zdXJhbmNlLWF1dGgtc3BlY2lhbGlzdCIsImNvbmZpZyI6eyJtb2RlbCI6Im9wZW5haS9ncHQtb3NzLTEyMGI6bml0cm8ifX1dLCJzdGFydGluZ0FnZW50SWQiOiJwYXRpZW50LWFnZW50In0/a2a"
    
    # Create client
    client = SimpleA2AClient(url)
    
    # Connect
    if not await client.connect():
        return
    
    # Run interactive loop
    await client.run_interactive()
    
    # Disconnect
    await client.disconnect()


if __name__ == "__main__":
    print("Starting A2A Client v2...")
    asyncio.run(main())