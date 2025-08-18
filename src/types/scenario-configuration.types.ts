/**
 * ===================================================================================
 *                     SCENARIO CONFIGURATION - DESIGN PHILOSOPHY
 * ===================================================================================
 *
 * CORE PRINCIPLE: In these interop scenarios, all official proceedings happen through
 * the conversation itself (messages and attachments). No out-of-band communication
 * is needed or allowed. The conversation carries the full transaction.
 *
 * --- HOW IT WORKS ---
 *
 * 1. **Agents** (LLMs) represent principals, conversing to achieve goals
 * 2. **Tools** let agents query THEIR OWN organization's data (not for sharing with others)
 * 3. **Information exchange happens through CONVERSATION, not tools**  
 * 4. **The Oracle** (omniscient LLM) executes tools using the knowledgeBase
 * 5. **Terminal tools** record final decisions and end the conversation
 *
 * --- CRITICAL DESIGN RULES ---
 *
 * 1. **Frame agents as representatives, not principals**
 *    ✅ "You are an agent representing Dr. Chen..."
 *    ❌ "You are Dr. Chen..."
 *
 * 2. **Tools access the agent's OWN systems, not other agents'**
 *    ✅ search_patient_records, lookup_policy, escalate_to_supervisor
 *    ❌ share_with_partner, send_to_other_agent, submit_to_insurer
 *    
 *    Each agent's tools access that agent's own organization's systems.
 *    Tool results can become attachments on the agent's messages.
 *    Tools don't directly communicate with the OTHER agent in the conversation.
 *
 * 3. **Make tools flexible with natural language inputs**
 *    ✅ { query: "knee therapy notes from June 2024 for patient MRN-445892" }
 *    ❌ { startDate, endDate, patientId, recordType, bodyPart, provider... }
 *
 * 4. **Terminal tools formalize outcomes and end the conversation**
 *    Terminal tools generate artifacts (approval letters, auth numbers, JSON records)
 *    that memorialize the decision and signal conversation end.
 *
 * 5. **Synthesis guidance shapes presentation, not content**
 *    knowledgeBase: Contains the actual data, detailed enough to sketch out a realistic rich scenario
 *    synthesisGuidance: Describes HOW to format/present that data
 *
 * --- AUTHORING CHECKLIST (POSITIVE BEHAVIORS) ---
 *
 * 1) Initiation message: be brief and purposeful
 *    - Identify representation and objective: "I am an agent representing [principal], seeking to [goal]."
 *    - Defer details to the conversation and tools; do not include a full clinical narrative.
 *
 * 2) System prompt: minimal entry point + use tools for details
 *    - Include only tiny entry info when needed (e.g., patient name/DOB/MRN).
 *    - Explicitly rely on tools to retrieve all clinical/policy data; do not embed those details in the system prompt.
 *
 * 3) Tool design: flexible inputs and clear synthesis outputs
 *    - Prefer natural-language inputs over rigid parameter lists; invite free-text queries.
 *    - Use synthesisGuidance to steer outputs to either:
 *        a) a human-readable document (e.g., markdown), or
 *        b) a rich, well-structured JSON object.
 *      Be explicit about the top-level choice; avoid mixing formats at the top level.
 *
 * Remember: Agents don't know they're in a simulation. Design tools as plausible
 * interfaces to real systems they would actually use.
 */

// AgentId is now just a string

/**
 * The root configuration for a complete conversational simulation.
 */
export interface ScenarioConfiguration {
  metadata: {
    id: string; // snake_case_descriptive_unique
    title: string;
    tags?: string[]; // for easy searching and categorization during connectathon testing
    /** A description of the core human or business problem this simulation models. */
    description: string;
    /** More detailed background on the scenario */
    background?: string;
    /** Moved from scenario.challenges */
    challenges?: string[];
  };


  /** An array of the agents participating in the conversation. */
  agents: ScenarioConfigAgentDetails[];
}

/**
 * Defines an agent's complete configuration, separating the conversational persona
 * from the underlying knowledge base used by its tools.
 */
export interface ScenarioConfigAgentDetails {
  agentId: string; // Simple string ID
  principal: {
    type: 'individual' | 'organization';
    name: string;
    description: string;
  };

  /** FOR THE CONVERSATIONAL AGENT: The agent's pre-interaction internal state. */
  situation: string;

  /** 
   * FOR THE CONVERSATIONAL AGENT: The agent's core persona and mandate.
   * Frame as an agent representing the principal, not as the principal themselves.
   * ✅ "You are an agent representing Dr. Chen..."
   * ❌ "You are Dr. Chen..."
   */
  systemPrompt: string;

  /** FOR THE CONVERSATIONAL AGENT: The agent's high-level objectives. */
  goals: string[];

  /**
   * The list of tools available to the agent.
   * See Tool interface below for detailed design principles.
   */
  tools: Tool[];

  /**
   * FOR THE TOOL-EXECUTING ORACLE: The private "database" for this agent.
   * This is the agent's primary source of truth for its tools.
   */
  knowledgeBase: Record<string, unknown>;

  /**
   * Message this agent uses when initiating conversation.
   * EVERY agent should have one - scenarios can be initiated from any perspective.
   * 
   * MUST include:
   * - Introduction as agent representing principal
   * - Purpose for initiating contact
   * 
   * ✅ "Hello, I'm an agent representing Dr. Chen from City Orthopedics. I'm reaching out 
   *     regarding prior authorization for an MRI for our mutual patient."
   * 
   * ❌ "I need to get an MRI approved"
   */
  messageToUseWhenInitiatingConversation: string;
}

/**
 * Defines a single capability available to an agent.
 * 
 * DESIGN PRINCIPLES:
 * - Mid-conversation (non-terminal) tools: Retrieve data, look up information, consult a supervisor, etc.
 * - Terminal tools: Generate formal artifacts (auth letters, JSON records) that reflect a conclusoin to the task at hand
 * - Prefer flexible natural language inputs over rigid parameters
 * - The conversation carries the transaction through messages and attachments; tools provide data to inform it
 */
export interface Tool {
  toolName: string;
  
  /**
   * FOR THE CONVERSATIONAL AGENT: What this tool does.
   * Describe the system capability, not an action.
   * 
   * ✅ "Search patient medical records using natural language"
   * ❌ "Submit prior authorization request"
   */
  description: string;
  
  inputSchema: { type: 'object', properties?: Record<string, any>, required?: string[] };

  /**
   * A CREATIVE BRIEF FOR THE OMNISCIENT TOOL-EXECUTING ORACLE.
   * 
   * Guide the Oracle's style and format, but give it creative freedom.
   * Don't use rigid templates - let the Oracle craft contextually appropriate responses.
   *
   * Examples:
   * - "Return clinical findings in professional medical language"
   * - "Format as JSON with relevant policy criteria from knowledgeBase"
   * - "Generate a formal approval letter - be creative but professional"
   * 
   * Avoid tools that just "document" things - in these scenarios, the conversation
   * itself is the documentation. Tools should retrieve or compute, not record.
   */
  synthesisGuidance: string;

  /**
   * Indicates whether this tool's execution should end the conversation.
   * 
   * When true, this tool generates formal artifacts (approval letters, auth numbers,
   * structured confirmations) that memorialize the outcome and signal conversation end.
   * 
   * ✅ approve_authorization, deny_request, confirm_appointment
   * ❌ suggest_alternative, request_more_info, put_on_hold
   */
  endsConversation?: boolean;

  /**
   * Specifies the outcome type when this tool ends the conversation.
   * Used in conjunction with endsConversation: true to indicate whether
   * the conversation ended with a successful outcome, failure, or neutral result.
   * 
   * - 'success': The request was approved, granted, or successfully completed
   *   Examples: authorization approved, appointment scheduled, coverage confirmed
   * 
   * - 'failure': The request was denied, rejected, or could not be fulfilled
   *   Examples: authorization denied, no appointments available, coverage denied
   * 
   * - 'neutral': The conversation ended without a clear success/failure outcome
   *   Examples: information provided, referral to another department, request withdrawn
   * 
   * This field should only be set when endsConversation is true.
   * If not specified for terminal tools, the outcome is considered neutral.
   */
  conversationEndStatus?: 'success' | 'failure' | 'neutral';
}

/**
 * EXAMPLE SCENARIO following best practices (truncated for brevity):
 * 
 * const priorAuthScenario: ScenarioConfiguration = {
 *   metadata: {
 *     id: "knee_mri_prior_auth",
 *     title: "Knee MRI Prior Authorization",
 *     description: "Provider seeks prior auth for knee MRI after conservative therapy"
 *   },
 *   agents: [
 *     {
 *       agentId: "provider",
 *       principal: {
 *         type: "individual",
 *         name: "Dr. Sarah Chen",
 *         description: "Orthopedic specialist"
 *       },
 *       systemPrompt: "You are an agent representing Dr. Chen, seeking prior authorization for a knee MRI...",
 *       // ✅ Good: Framed as agent representing the doctor, not as the doctor
 *       goals: ["Obtain MRI authorization", "Provide clinical justification"],
 *       situation: "Patient has completed 6 weeks of physical therapy with limited improvement",
 *       
 *       tools: [
 *         {
 *           toolName: "search_patient_ehr",
 *           description: "Search the EHR system using natural language queries about a patient",
 *           inputSchema: { 
 *             type: "object", 
 *             properties: { 
 *               query: { 
 *                 type: "string", 
 *                 description: "Natural language search query (e.g., 'knee injury notes for patient MRN-445892 from June 2024')" 
 *               },
 *               patientId: { 
 *                 type: "string", 
 *                 description: "Optional: Patient MRN if not included in query" 
 *               }
 *             },
 *             required: ["query"]
 *           },
 *           synthesisGuidance: "Search knowledgeBase.clinicalRecords matching the query. Return as markdown with dates and findings.",
 *           // ✅ Good: Flexible natural language search that LLMs can easily use
 *         },
 *         {
 *           toolName: "retrieve_treatment_history", 
 *           description: "Retrieve comprehensive treatment history using natural language query",
 *           inputSchema: { 
 *             type: "object", 
 *             properties: {
 *               query: { 
 *                 type: "string", 
 *                 description: "Natural language query (e.g., 'physical therapy history for patient MRN-445892')" 
 *               }
 *             },
 *             required: ["query"]
 *           },
 *           synthesisGuidance: "Search knowledgeBase.treatments and return a comprehensive therapeutic history report with dates, durations, outcomes",
 *           // ✅ Good: Returns full information, agent can extract what they need
 *         }
 *       ],
 *       knowledgeBase: {
 *         patient: { mrn: "MRN-445892", name: "Jordan Lee", dob: "1985-03-14" },
 *         clinicalRecords: [
 *           { date: "2024-06-01", type: "injury", notes: "Knee pivot injury during soccer" },
 *           { date: "2024-06-15", type: "therapy_start", notes: "Begin PT 3x/week" }
 *         ],
 *         timeline: [
 *           { event: "injury", date: "2024-06-01" },
 *           { event: "therapy_start", date: "2024-06-15" }
 *         ]
 *         // <... more structured data for tools to reference ...>
 *       },
 *       messageToUseWhenInitiatingConversation: 
 *         "Hello, I'm an agent representing Dr. Sarah Chen from Regional Orthopedics. " +
 *         "I'm contacting you regarding prior authorization for a knee MRI for our mutual " +
 *         "patient Jordan Lee, DOB 1985-03-14. The patient has completed conservative therapy " + 
 *         "but continues to have significant instability."
 *     },
 *     {
 *       agentId: "insurer",
 *       // <... principal, systemPrompt, goals, situation snipped ...>
 *       tools: [
 *         {
 *           toolName: "lookup_medical_policy",
 *           description: "Look up coverage criteria for a specific CPT code in the medical policy database",
 *           inputSchema: { 
 *             type: "object", 
 *             properties: { 
 *               cptCode: { type: "string", description: "CPT procedure code (e.g., 73721 for knee MRI)" },
 *               planType: { type: "string", description: "Insurance plan type: PPO, HMO, EPO" },
 *               state: { type: "string", description: "State abbreviation for regional policies" }
 *             },
 *             required: ["cptCode", "planType"]
 *           },
 *           synthesisGuidance: "Lookup in knowledgeBase.policies. Return as JSON array with criteria, thresholds, and requirements.",
 *           // ✅ Good: Realistic tool that would exist in insurer's system
 *         },
 *         {
 *           toolName: "approve_prior_authorization",
 *           description: "Approve a prior authorization request and generate authorization number",
 *           inputSchema: { 
 *             type: "object", 
 *             properties: { 
 *               memberId: { type: "string", description: "Member ID number" },
 *               cptCode: { type: "string", description: "Approved CPT code" },
 *               approvalReason: { type: "string", description: "Clinical justification for approval" },
 *               validityDays: { type: "number", description: "Number of days authorization is valid" }
 *             },
 *             required: ["memberId", "cptCode", "approvalReason"]
 *           },
 *           synthesisGuidance: "Generate formal approval letter using knowledgeBase.templates.approval. Include auth number from knowledgeBase.authSequence.",
 *           endsConversation: true,
 *           conversationEndStatus: "success"
 *           // ✅ Good: Terminal tool with realistic parameters
 *         }
 *         // <... deny_authorization tool snipped ...>
 *       ],
 *       knowledgeBase: {
 *         policies: {
 *           "73721": { // CPT code for knee MRI - ABBREVIATED for example
 *             requirements: ["14 days conservative therapy", "documented instability"],
 *             thresholds: { therapy_days: 14, auth_validity_days: 90 }
 *             // In reality, this would have MUCH more detail:
 *             // - exclusions, age limits, frequency limits
 *             // - specific documentation requirements
 *             // - alternative criteria pathways
 *             // - cross-references to other policies
 *             // - 20+ additional fields...
 *           }
 *           // <... dozens more CPT codes with similar depth ...>
 *         },
 *         authSequence: "PA2024-03-",
 *         memberDatabase: {
 *           // <... thousands of members with full coverage details ...>
 *         },
 *         providerNetwork: {
 *           // <... provider contracts, rates, specialties ...>
 *         }
 *         // KnowledgeBases can be extremely detailed - this is just a sketch
 *       }
 *     }
 *   ]
 * };
 */
