/**
 * ===================================================================================
 *   Welcome to the Scenario Builder's Guide!
 * ===================================================================================
 *
 * This file defines the "ScenarioConfiguration" for creating rich, realistic, and
 * emergent multi-agent simulations. To build great scenarios, it's essential to
 * understand the architecture that brings them to life.
 *
 * --- Architectural Overview ---
 *
 * Your scenario will be run by an Orchestrator that manages three key components:
 *
 * 1.  **The Conversational Agents (The "Actors"):**
 *     These are LLMs whose only job is to talk, reason, and decide which tool to use.
 *     They are "blissfully ignorant" of the simulation's ground truth. They only know
 *     their own persona, goals, and available tools. They must discover everything
 *     else through conversation and action.
 *
 * 2.  **The Tool-Executing Oracle (The "World Simulator" / "Dungeon Master"):**
 *     This is another, more powerful LLM. Its critical feature is that it is **omniscient**:
 *     it sees the *entire* `ScenarioConfiguration`, including both agents' private
 *     `knowledgeBase`s and the overall `scenario` context. Its job is to use this
 *     omniscient view to craft tool responses that are realistic, in-character, and
 *     drive the simulation forward in interesting ways. It only reveals what is
 *     plausible for that specific tool to know.
 *
 * 3.  **The Orchestrator (The "Conductor"):**
 *     This system passes messages between the two Actors and routes tool calls to the
 *     Oracle for execution.
 *
 * --- A Phased Approach to Scenario Authoring ---
 *
 * We recommend collaborating with a Scenario Building Assistant (an LLM) and tackling
 * it in these phases:
 *
 *   **Phase 1: The Narrative Foundation (The "What")**
 *   - Fill out `metadata` to define the interaction's purpose.
 *   - Write the `scenario.background` and `challenges` to define the story and its core conflict.
 *
 *   **Phase 2: Defining the Participants (The "Who")**
 *   - For each agent, define the `principal`, `systemPrompt`, `goals`, and `situation`.
 *
 *   **Phase 3: Crafting the World and Tools (The "How")**
 *   - Populate each agent's `knowledgeBase` with their private, ground-truth data.
 *   - Define the `tools`. For each tool, write a clear `description` for the Actor and
 *     an evocative, intent-driven `synthesisGuidance` (a "director's note") for the Oracle.
 *
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
   * 
   * **CRITICAL: Agent Role Semantics**
   * The systemPrompt must frame the LLM as an *agent representing* the principal, 
   * not the principal themselves. This maintains proper conversational boundaries.
   * 
   * ✅ GOOD Examples:
   * - "You are an agent representing Dr. Chen. Relay her clinical intent..."
   * - "You are an AI assistant working on behalf of Memorial Hospital..."
   * - "You represent Acme Insurance's prior authorization team..."
   * 
   * ❌ BAD Examples:
   * - "You are Dr. Chen..." (agent should not claim to BE the principal)
   * - "You are Memorial Hospital..." (AI cannot be an institution)
   * - "You are the insurance company..." (inappropriate identity claim)
   */
  systemPrompt: string;

  /** FOR THE CONVERSATIONAL AGENT: The agent's high-level objectives. */
  goals: string[];

  /**
   * The list of tools available to the agent.
   * 
   * **🔥 CONVERSATION AS MEDIUM PRINCIPLE:**
   * In conversational interoperability, agents negotiate outcomes through dialogue. 
   * Tools do not submit requests—they reveal data. Decisions emerge from conversation, 
   * not tool execution. The conversation itself IS the medium of exchange.
   * 
   * **NON-TERMINAL TOOLS (Information Retrieval & Computation Only):**
   * These tools are strictly for gathering information or performing calculations.
   * They should NEVER make recommendations, decisions, or suggest actions.
   * 
   * ✅ GOOD Examples (proper naming with prefixes):
   * - retrieve_patient_clinical_notes: Get patient's medical documentation
   * - lookup_insurance_policy_requirements: Access coverage criteria and rules
   * - check_lab_results: Fetch specific test values from EHR
   * - calculate_treatment_duration: Compute therapy timeframe from records
   * - search_formulary_alternatives: Find equivalent medication options
   * - get_appointment_availability: Check scheduling system for open slots
   * 
   * ❌ BAD Examples (decision-making anti-patterns):
   * - recommend_alternative_therapy: NO! Use "retrieve_alternative_therapy_options"
   * - suggest_precautions: NO! Use "lookup_precaution_guidelines" 
   * - advise_next_step: NO! Use "get_next_step_options"
   * - submit_prior_auth_request: NO! The conversation IS the request
   * - fill_out_claim_form: NO! Discuss claim details in conversation
   * - send_referral_form: NO! Express referral need through dialogue
   * 
   * **TERMINAL TOOLS (Final Authoritative Decisions):**
   * These represent conclusive outcomes that end the interaction.
   * Use outcome-focused names only for these final decision points.
   * 
   * ✅ GOOD Examples:
   * - approve_authorization: Grant the requested approval
   * - deny_request: Reject the application with reasoning
   * - confirm_appointment: Finalize the scheduled time
   * - contraindicate_medication: Medical determination against use
   * - no_appointments_available: Definitive scheduling unavailability
   * 
   * ❌ BAD Examples (not truly terminal):
   * - request_more_information: NO! Just ask in conversation
   * - put_on_hold: NO! This expects further interaction
   * - ask_for_clarification: NO! Continue the dialogue instead
   */
  tools: Tool[];

  /**
   * FOR THE TOOL-EXECUTING ORACLE: The private "database" for this agent.
   * This is the agent's primary source of truth for its tools.
   */
  knowledgeBase: Record<string, unknown>;

  /**
   * An optional message this agent will use if it is designated as the conversation initiator.
   * This allows scenarios to be started from different perspectives without modifying the core configuration.
   */
  messageToUseWhenInitiatingConversation?: string;
}

/**
 * Defines a single capability available to an agent.
 * 
 * **Remember:** Tools retrieve information from systems or make final decisions. 
 * In conversational interoperability, the dialogue itself carries the request.
 * Non-terminal tools should use prefixes like retrieve_, lookup_, check_, calculate_.
 */
export interface Tool {
  toolName: string;
  
  /**
   * FOR THE CONVERSATIONAL AGENT: What this tool does.
   * Should describe information retrieval, computation, or final decision-making.
   * Use proper naming conventions with prefixes for clarity.
   * 
   * ✅ GOOD Examples:
   * - "retrieve_patient_medication_history: Get complete medication list from EHR"
   * - "lookup_formulary_coverage: Check if medication is covered by insurance"
   * - "calculate_dosage_adjustment: Compute dose based on patient weight and kidney function"
   * - "approve_prior_authorization: Grant approval for the requested treatment" (terminal)
   * 
   * ❌ BAD Examples:
   * - "submit_prior_authorization_request: Send request to insurer" (conversation IS the request)
   * - "recommend_alternatives: Suggest other treatment options" (tools don't recommend, they retrieve options)
   */
  description: string;
  
  inputSchema: { type: 'object', properties?: Record<string, any>, required?: string[] };

  /**
   * **CREATIVE BRIEF FOR THE OMNISCIENT TOOL-EXECUTING ORACLE**
   * This is a "director's note," not code. Guide the Oracle's performance using its omniscience.
   *
   * The Oracle can see the ENTIRE scenario including all agents' private knowledgeBase data.
   * Your job is to tell it what character to play and what information to reveal (or withhold) 
   * to create realistic, context-aware responses that advance the story.
   *
   * **🎯 KEY PRINCIPLE: Leverage Omniscience for Specificity**
   * Instead of generic responses, use cross-agent knowledge to be hyper-specific.
   *
   * ✅ EXCELLENT Examples (showing omniscient cross-referencing):
   * 
   * Example 1 - Prior Authorization Tool:
   * "Act as the insurer's policy engine accessing their knowledgeBase. Because you can also 
   * see the Provider's knowledgeBase, make your audit findings hyper-specific. Instead of 
   * saying 'trial duration not met,' say: 'Policy requires 6-month trial; provider's EHR 
   * shows patient received only 5 months of therapy (Jan 15 - June 10).' Reference specific 
   * dates, values, and criteria from both knowledge bases."
   * 
   * Example 2 - Appointment Scheduling:
   * "You see both the patient's preference (mornings) and the provider's actual schedule. 
   * When showing available slots, you can say: 'I see you prefer morning appointments. 
   * Dr. Martinez has Tuesday 9:30 AM and Friday 10:15 AM open, which aligns with your 
   * stated preference for early appointments.'"
   * 
   * Example 3 - Lab Results Check:
   * "Because you see the provider's eGFR concern (knowledgeBase) and the institution's 
   * contrast safety threshold (knowledgeBase), you can say: 'Patient's eGFR is 48 mL/min, 
   * which meets your institution's ≥45 threshold for safe contrast administration.'"
   * 
   * ❌ BAD Examples (missing omniscient opportunity):
   * - "Check if the trial duration was adequate" (too vague, doesn't use cross-agent knowledge)
   * - "Policy requires 6-month trial" (misses chance to reference provider's specific records)
   * - "Patient has appointments available" (doesn't leverage preference matching)
   */
  synthesisGuidance: string;

  /**
   * Indicates whether this tool's execution should end the conversation.
   * 
   * When true, the agent will use this tool call result to help conclude the conversation.
   * 
   * IMPORTANT: Only use this for FINAL DECISIONS that complete the interaction.
   * Do NOT use this for:
   * - Requesting more information (just ask in the conversation)
   * - Temporary pauses or holds
   * - Any action that expects a response from the other party
   * 
   * Good examples: approve_authorization, deny_request, no_appointments_available
   * Bad examples: request_more_info, put_on_hold, ask_for_clarification
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
 * ===================================================================================
 *   🚨 COMMON PITFALLS TO AVOID
 * ===================================================================================
 * 
 * Based on frequent errors observed during scenario development, here are the most 
 * common mistakes and how to avoid them:
 * 
 * **1. IDENTITY CONFUSION (Agent vs Principal)**
 * ❌ Problem: systemPrompt says "You are Dr. Smith..."
 * ✅ Solution: "You are an agent representing Dr. Smith..."
 * 
 * **2. TOOL SUBMISSION ANTI-PATTERNS**
 * ❌ Problem: Tools named "submit_request", "send_form", "file_claim"
 * ✅ Solution: The conversation IS the submission. Use "retrieve_", "lookup_", "check_"
 * 
 * **3. RECOMMENDATION TOOLS (Non-terminal tools making decisions)**
 * ❌ Problem: "recommend_treatment", "suggest_alternatives", "advise_patient"
 * ✅ Solution: "retrieve_treatment_options", "lookup_alternatives", "get_patient_guidelines"
 * 
 * **4. PSEUDO-TERMINAL TOOLS (Using terminal for intermediate steps)**
 * ❌ Problem: endsConversation=true for "request_more_info", "put_on_hold"
 * ✅ Solution: Only use terminal for FINAL decisions: "approve", "deny", "confirm"
 * 
 * **5. VAGUE SYNTHESIS GUIDANCE (Missing omniscient opportunities)**
 * ❌ Problem: "Check the policy requirements"
 * ✅ Solution: "Because you see both the provider's specific request AND the payer's 
 *     exact policy criteria, respond with: 'Your request for Drug X requires 6-month 
 *     trial of Drug Y. Patient records show only 4 months completed.'"
 * 
 * **6. WEAK CONVERSATION MEDIUM UNDERSTANDING**
 * ❌ Problem: Creating tools to "communicate" or "negotiate"
 * ✅ Solution: Remember that talking IS the tool. Tools reveal data; conversation decides.
 * 
 * **7. GENERIC TOOL DESCRIPTIONS**
 * ❌ Problem: "Get patient information"
 * ✅ Solution: "retrieve_patient_allergy_history: Get documented allergic reactions from EHR"
 * 
 * These improvements make scenarios more self-explanatory and reduce iterative corrections.
 */