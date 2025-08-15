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
    id: string;
    title: string;
    /** A description of the core human or business problem this simulation models. */
    description: string;
    tags?: string[];
    /** Moved from scenario.background */
    background?: string;
    /** Moved from scenario.challenges */
    challenges?: string[];
  };

  /**
   * SIMULATION METADATA: The objective "God's-eye view" of the interaction.
   * As described in the guide, this is for the designer and the Oracle, not the Actors.
   */
  scenario?: {
    interactionNotes?: Record<string, unknown>;
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

  /** FOR THE CONVERSATIONAL AGENT: The agent's core persona and mandate. */
  systemPrompt: string;

  /** FOR THE CONVERSATIONAL AGENT: The agent's high-level objectives. */
  goals: string[];

  /**
   * The list of tools available to the agent.
   * 
   * IMPORTANT: In conversational interoperability, tools should retrieve or process 
   * information, NOT submit forms or requests. The conversation itself IS the medium 
   * of exchange - agents communicate their needs directly through dialogue.
   * 
   * GOOD tool examples (information retrieval):
   * - search_ehr_clinical_notes: Retrieve patient's clinical documentation
   * - lookup_insurance_policy: Access policy requirements and criteria
   * - check_lab_results: Get specific test results from the EHR
   * - calculate_treatment_duration: Compute how long a therapy was tried
   * 
   * BAD tool examples (form submission anti-patterns):
   * - submit_prior_auth_request: NO! The conversation IS the request
   * - fill_out_claim_form: NO! Discuss the claim details in conversation
   * - send_referral_form: NO! Express the referral need through dialogue
   * 
   * Terminal tools (endsConversation: true) should represent final DECISIONS,
   * not form submissions. Examples: approve_authorization, deny_request,
   * no_appointments_available.
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
 * Remember: Tools retrieve information from systems, they don't submit forms.
 * In conversational interoperability, the dialogue itself carries the request.
 */
export interface Tool {
  toolName: string;
  
  /**
   * FOR THE CONVERSATIONAL AGENT: What this tool does.
   * Should describe information retrieval or computation, not form submission.
   * 
   * GOOD: "Retrieve patient's medication history from the EHR"
   * BAD: "Submit prior authorization request to insurer"
   */
  description: string;
  
  inputSchema: { type: 'object', properties?: Record<string, any>, required?: string[] };

  /**
   * A CREATIVE BRIEF FOR THE OMNISCIENT TOOL-EXECUTING ORACLE.
   * This is a "director's note," not code. Guide the Oracle's performance.
   *
   * PROMPT: Assume the Oracle can see the ENTIRE scenario. Your job is to tell it
   * what character to play and what information to reveal (or withhold) to be
   * realistic and to advance the story.
   *
   * GOOD EXAMPLE (Leveraging omniscience):
   * "Act as the insurer's policy engine. Your source of truth is the Payer's `knowledgeBase`.
   *  Because you can also see the Provider's `knowledgeBase`, you can make your audit
   *  findings hyper-specific. Instead of saying 'trial duration not met,' say 'Policy
   *  requires 6-month trial; provider's record confirms a 5-month trial was administered.'
   *  This specificity is key to a realistic interaction."
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