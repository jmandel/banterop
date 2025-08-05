import { CreateConversationRequest } from '$lib/types.js';

/**
 * Encodes a CreateConversationRequest to a Base64URL-safe string
 * @param config The conversation configuration to encode
 * @returns Base64URL-encoded string
 */
export function encodeConfigToBase64URL(config: CreateConversationRequest): string {
  // Convert to JSON string
  const jsonString = JSON.stringify(config);
  
  // Convert to base64
  const base64 = btoa(jsonString);
  
  // Make URL-safe: replace + with -, / with _, and remove trailing =
  const base64url = base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
    
  return base64url;
}

/**
 * Decodes a Base64URL-safe string back to a CreateConversationRequest
 * @param segment The Base64URL-encoded string
 * @returns The decoded conversation configuration
 * @throws Error if decoding fails or JSON is invalid
 */
export function decodeConfigFromBase64URL(segment: string): CreateConversationRequest {
  // Restore base64 padding if needed
  const padded = segment + '==='.substring(0, (4 - segment.length % 4) % 4);
  
  // Restore base64 characters: replace - with +, _ with /
  const base64 = padded
    .replace(/-/g, '+')
    .replace(/_/g, '/');
    
  // Decode from base64
  const jsonString = atob(base64);
  
  // Parse JSON
  try {
    const config = JSON.parse(jsonString) as CreateConversationRequest;
    return config;
  } catch (error) {
    throw new Error(`Failed to parse configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}