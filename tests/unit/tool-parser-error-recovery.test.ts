import { test, expect, describe } from 'bun:test';
import { parseToolsFromResponse } from '../../src/lib/utils/tool-parser.js';

describe('Tool Parser Error Recovery', () => {
  
  test('should handle real-world case with missing closing brace', () => {
    // This is the exact case from the user's example
    const output = `<scratchpad>
I have successfully retrieved the full medical policy for an MRI of the knee (docId: policy_HF-MRI-KNEE-2024). The provider/patient requested both the required documentation list and a copy of the policy. I will reply with a detailed list of required documentation as outlined in the policy and attach the policy document. No further internal lookups are needed at this point.
</scratchpad>
\`\`\`json
{
  "name": "send_message_to_agent_conversation",
  "args": {
    "text": "Hello Jordan Alvarez (Member ID: HF8901234567) and provider team,\\n\\nThank you for your inquiry regarding the prior authorization request for a right knee MRI. Attached you will find the full HealthFirst policy that governs MRI authorization for the knee (Policy ID: HF-MRI-KNEE-2024).\\n\\n**Documentation required to process this prior authorization (as per the policy):**\\n1. **Physician Order** for the MRI (including CPT code 73721, laterality, and diagnosis code).\\n2. **Initial Injury Report** – date of injury, mechanism (e.g., sports‑related pivot or impact), and initial clinical findings.\\n3. **Physical Therapy Progress Notes** for at least 14 consecutive days of documented conservative therapy. Each PT note must include:\\n   - Date of service and therapist's NPI.\\n   - Specific functional limitations (e.g., inability to bear weight, instability on stairs, etc.).\\n   - Objective measures (range‑of‑motion, strength grades, gait assessment).\\n4. **Clinical Examination Summary** (physician‑signed) documenting:\\n   - Positive exam findings (e.g., Lachman test grade, endpoint quality, pivot‑shift, valgus stress, etc.).\\n   - Statement that conservative therapy has failed to restore stability or function.\\n5. **Previous Imaging Reports** (if any) with findings referenced.\\n6. **Provider Network Confirmation** – name of the imaging facility, its NPI, and confirmation that the facility is **in‑network** for the member (or request for verification if not yet confirmed).\\n\\n**Common clarifications we often need:**\\n- Exact start and end dates of the conservative therapy.\\n- Detailed description of functional limitations beyond generic \\"pain.\\"\\n- Confirmation whether a home‑exercise program was used in addition to formal PT.\\n- Confirmation of the imaging facility's in‑network status (NPI number).\\n\\nPlease submit all the above‑listed documents within this conversation thread. Once we have the complete set, we will verify the network status and, if the facility is in‑network, proceed with expedited review.\\n\\nIf you have any questions or need further clarification, please let me know.\\n\\nRegards,\\n[Your Name]\\nPrior Authorization Specialist, HealthFirst Insurance",
    "attachments_to_include": [
      "policy_HF-MRI-KNEE-2024"
    ]
  }
\`\`\``;
    
    const result = parseToolsFromResponse(output);
    
    // Should successfully parse despite missing closing brace
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('send_message_to_agent_conversation');
    expect(result.tools[0].args.text).toContain('Hello Jordan Alvarez');
    expect(result.tools[0].args.attachments_to_include).toEqual(['policy_HF-MRI-KNEE-2024']);
    
    // Should extract scratchpad content as the message
    expect(result.message).toContain('successfully retrieved the full medical policy');
  });

  test('should handle case without newline between scratchpad and json', () => {
    const output = `<scratchpad>
I need to send a message with attachments.
</scratchpad>\`\`\`json
{
  "name": "send_message_to_agent_conversation",
  "args": {
    "text": "Here is the information.",
    "attachments_to_include": ["doc1"]
  }
\`\`\``;
    
    const result = parseToolsFromResponse(output);
    
    expect(result.message).toBe('I need to send a message with attachments.');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('send_message_to_agent_conversation');
  });

  test('should handle deeply nested objects with missing braces', () => {
    const output = `\`\`\`json
{
  "name": "complex_tool",
  "args": {
    "level1": {
      "level2": {
        "level3": {
          "value": "deep"
        }
      }
    }
\`\`\``;
    
    const result = parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('complex_tool');
    expect(result.tools[0].args.level1.level2.level3.value).toBe('deep');
  });
});