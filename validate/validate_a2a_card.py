#!/usr/bin/env python3
"""
A2A Agent Card Validator

Usage: python validate_a2a_card.py <agent-card-url>
Example: python validate_a2a_card.py http://localhost:3003/rooms/abc/agent-card.json
"""

import sys
import json
import requests
from a2a.types import AgentCard
from pydantic import ValidationError


def validate_agent_card_from_url(url: str):
    """Fetch and validate an A2A agent card from the given URL."""
    print("=" * 60)
    print("A2A SDK Agent Card Validator")
    print("=" * 60)
    print(f"\nFetching agent card from: {url}\n")
    
    try:
        # Fetch the agent card
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        agent_card_data = response.json()
        
        print("✓ Successfully fetched agent card")
        print(f"  Response status: {response.status_code}")
        print(f"  Content size: {len(response.text)} bytes\n")
        
        # Validate using the A2A SDK
        try:
            agent_card = AgentCard.model_validate(agent_card_data)
            
            print("✅ VALIDATION PASSED\n")
            print("Agent Card Details (validated by a2a-sdk):")
            print("-" * 40)
            print(f"  Name: {agent_card.name}")
            print(f"  Protocol Version: {agent_card.protocol_version}")
            print(f"  Description: {agent_card.description[:80]}...")
            print(f"  URL: {agent_card.url}")
            print(f"  Version: {agent_card.version}")
            print(f"  Preferred Transport: {agent_card.preferred_transport}")
            
            # Provider information
            if agent_card.provider:
                print(f"\nProvider:")
                print(f"  Organization: {agent_card.provider.organization}")
                if agent_card.provider.url:
                    print(f"  URL: {agent_card.provider.url}")
            
            # Capabilities
            if agent_card.capabilities:
                print(f"\nCapabilities:")
                print(f"  Streaming: {agent_card.capabilities.streaming}")
                print(f"  Push Notifications: {agent_card.capabilities.push_notifications}")
                print(f"  State Transition History: {agent_card.capabilities.state_transition_history}")
                
                if agent_card.capabilities.extensions:
                    print(f"\nExtensions ({len(agent_card.capabilities.extensions)}):")
                    for ext in agent_card.capabilities.extensions:
                        print(f"  - URI: {ext.uri}")
                        print(f"    Description: {ext.description[:60]}...")
                        print(f"    Required: {ext.required}")
            
            # Skills
            if agent_card.skills:
                print(f"\nSkills ({len(agent_card.skills)}):")
                for skill in agent_card.skills:
                    print(f"  - {skill.name} (id: {skill.id})")
                    print(f"    Description: {skill.description[:60]}...")
                    if skill.tags:
                        print(f"    Tags: {', '.join(skill.tags)}")
            
            # Additional interfaces
            if agent_card.additional_interfaces:
                print(f"\nAdditional Interfaces ({len(agent_card.additional_interfaces)}):")
                for interface in agent_card.additional_interfaces:
                    print(f"  - URL: {interface.url}")
                    print(f"    Transport: {interface.transport}")
            
            # Input/Output modes
            if agent_card.default_input_modes:
                print(f"\nDefault Input Modes: {', '.join(agent_card.default_input_modes)}")
            if agent_card.default_output_modes:
                print(f"Default Output Modes: {', '.join(agent_card.default_output_modes)}")
            
            print("\n" + "=" * 60)
            print("Full Validated Model (as JSON):")
            print("=" * 60)
            print(json.dumps(agent_card.model_dump(mode='json', exclude_none=True), indent=2))
            
        except ValidationError as e:
            print("❌ VALIDATION FAILED\n")
            print("Validation errors from a2a-sdk:")
            print("-" * 40)
            for idx, error in enumerate(e.errors(), 1):
                field_path = " → ".join(str(loc) for loc in error['loc'])
                print(f"\n{idx}. Field: {field_path}")
                print(f"   Error: {error['msg']}")
                if 'input' in error:
                    print(f"   Input value: {error['input']}")
                if 'ctx' in error:
                    print(f"   Context: {error['ctx']}")
            
            print("\n" + "=" * 60)
            print("Raw JSON received:")
            print("=" * 60)
            print(json.dumps(agent_card_data, indent=2))
            sys.exit(1)
            
    except requests.exceptions.Timeout:
        print(f"❌ ERROR: Request timed out after 10 seconds")
        sys.exit(1)
    except requests.exceptions.ConnectionError as e:
        print(f"❌ ERROR: Failed to connect to {url}")
        print(f"   Details: {e}")
        sys.exit(1)
    except requests.exceptions.HTTPError as e:
        print(f"❌ ERROR: HTTP error occurred")
        print(f"   Status code: {e.response.status_code}")
        print(f"   Response: {e.response.text}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"❌ ERROR: Invalid JSON response")
        print(f"   Details: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ ERROR: Unexpected error occurred")
        print(f"   Type: {type(e).__name__}")
        print(f"   Details: {e}")
        sys.exit(1)


def main():
    if len(sys.argv) != 2:
        print("Usage: python validate_a2a_card.py <agent-card-url>")
        print("Example: python validate_a2a_card.py http://localhost:3003/rooms/abc/agent-card.json")
        sys.exit(1)
    
    url = sys.argv[1]
    
    # Basic URL validation
    if not url.startswith(('http://', 'https://')):
        print(f"❌ ERROR: Invalid URL format. URL must start with http:// or https://")
        print(f"   Provided: {url}")
        sys.exit(1)
    
    validate_agent_card_from_url(url)


if __name__ == "__main__":
    main()