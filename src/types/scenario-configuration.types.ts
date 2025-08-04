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
  };

  /**
   * SIMULATION METADATA: The objective "God's-eye view" of the interaction.
   * As described in the guide, this is for the designer and the Oracle, not the Actors.
   */
  scenario: {
    background: string;
    challenges: string[];
    interactionNotes?: Record<string, unknown>;
  };

  /** An array of the agents participating in the conversation. */
  agents: AgentConfiguration[];
}

/**
 * Defines an agent's complete configuration, separating the conversational persona
 * from the underlying knowledge base used by its tools.
 */
export interface AgentConfiguration {
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
   * The orchestrator uses this to determine when an agent has reached a
   * conclusive outcome (e.g., approval, denial, no slots available).
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
}


// ===================================================================================
//                            COMPLETE SCENARIO EXAMPLE
//    This example embodies the "Director's Note" philosophy for the Oracle.
// ===================================================================================

const infliximabScenarioFinal: ScenarioConfiguration = {
  // --- Phase 1: Narrative Foundation ---
  metadata: {
    id: "healthcare-prior-auth-infliximab-ra-06-final",
    title: "Prior Authorization for Infliximab for Rheumatoid Arthritis",
    description: "A rheumatologist's office seeks authorization for a high-cost biologic drug for a patient with treatment-resistant RA, requiring careful navigation of a detailed insurance policy.",
    tags: ["healthcare", "prior-authorization", "oracle-tools", "emergent-conversation"],
  },
  scenario: {
    background: "Sarah Jones, 48, has severe, progressive rheumatoid arthritis. After failing multiple standard therapies, her rheumatologist, Dr. Evans, has prescribed Infliximab to prevent irreversible joint damage. The PA Specialist from the clinic needs to discuss this treatment with the insurance company's clinical reviewer.",
    challenges: [
      "The insurer's policy requires a 6-month trial of Methotrexate. Sarah's record shows a 5-month trial before being stopped for documented side effects.",
      "The policy requires failure of a second conventional drug. The documentation for this is a sparse note from a previous doctor.",
      "The conversation needs to establish medical necessity through dialogue, not form submission.",
    ],
  },
  // --- Phases 2 & 3: Participants, World, and Tools ---
  agents: [
    {
      agentId: "pa-specialist-rheum-clinic",
      // --- Phase 2: Participant Definition ---
      principal: {
        type: "organization",
        name: "Rheumatology Associates of Springfield",
        description: "A specialty clinic dedicated to providing advanced care for patients with autoimmune diseases."
      },
      situation: "You are a PA Specialist at Rheumatology Associates. Sarah Jones is a patient who needs Infliximab for her severe rheumatoid arthritis. You have access to her complete medical record.",
      systemPrompt: "You are a Prior Authorization Specialist at a rheumatology clinic. Your role is to advocate for your patients by presenting their clinical information clearly and responding to the insurer's questions. You engage in professional conversations to help insurers understand why treatments are medically necessary.",
      goals: ["Present the patient's clinical case effectively", "Answer the reviewer's questions thoroughly", "Advocate for the patient's prescribed treatment"],
      // --- Phase 3: Tools & World ---
      tools: [
        {
          toolName: "lookup_patient_summary",
          description: "Retrieves the full clinical summary for the patient currently being discussed.",
          inputSchema: { type: 'object', properties: {} },
          synthesisGuidance: "Act as the clinic's Electronic Health Record system. Your source of inspiration is the `knowledgeBase.patientChart`, and you should stay consistent with that but not limited to it! Present the full chart as a clean, well-organized clinical summary. The output should be comprehensive and professional, as if for a healthcare provider to read."
        },
        {
          toolName: "search_clinical_notes",
          description: "Searches through detailed clinical notes for specific information requested by the reviewer.",
          inputSchema: { type: 'object', properties: { search_term: { type: 'string' } } },
          synthesisGuidance: "Act as a clinical notes search system. Use the search term to find relevant information in the `knowledgeBase.patientChart`. Return specific excerpts from doctor's notes, lab results, or treatment records that match the search. If the reviewer asks about liver enzymes, find the specific lab values and dates."
        },
        {
          toolName: "calculate_treatment_timeline",
          description: "Generates a detailed timeline of the patient's treatment history with specific dates and durations.",
          inputSchema: { type: 'object', properties: {} },
          synthesisGuidance: "Create a chronological timeline inspired by the `knowledgeBase.patientChart` showing when each treatment started, how long it lasted, why it was stopped, and any gaps between treatments. Be specific with dates and durations to help address policy requirements about trial lengths."
        }
      ],
      knowledgeBase: {
        patientChart: { // Simplified for clarity
            name: "Sarah Jones",
            diagnosis: "M05.79 - Rheumatoid arthritis",
            requestedTreatment: "J1745 - Infliximab",
            treatmentHistory: [
              { drug: "Methotrexate", duration: "5 months", outcome: "Stopped due to elevated liver enzymes (intolerance)." },
              { drug: "Sulfasalazine", duration: "6 months", outcome: "Patient reported no improvement (lack of efficacy)." }
            ]
        }
      }
    },
    {
      agentId: "pa-reviewer-healthfirst",
      // --- Phase 2: Participant Definition ---
      principal: {
        type: "organization",
        name: "HealthFirst National",
        description: "A national health insurer committed to evidence-based and cost-effective care."
      },
      situation: "You are a clinical reviewer at HealthFirst. You handle prior authorization requests for specialty medications, including biologics for rheumatoid arthritis.",
      systemPrompt: "You are a clinical pharmacist reviewer at HealthFirst. Your role is to evaluate treatment requests through conversation with healthcare providers, applying medical policies while considering the full clinical context. You ask clarifying questions and use your tools to verify information and make informed decisions.",
      goals: ["Understand the patient's clinical situation through conversation", "Apply medical policies appropriately while considering clinical context", "Make a fair determination based on policy and medical necessity"],
      // --- Phase 3: Tools & World ---
      tools: [
        {
          toolName: "lookup_medical_policy",
          description: "Retrieves the specific medical policy criteria for a given medication or treatment code.",
          inputSchema: { type: 'object', properties: { medication_code: { type: 'string' } } },
          synthesisGuidance: "Act as the HealthFirst policy database. Look up the medication in `knowledgeBase.medicalPolicies`. Return the full policy document including criteria, exceptions, and authorization requirements. Present it as a structured policy document that clinical reviewers would reference."
        },
        {
          toolName: "lookup_patient_insurance_history",
          description: "Retrieves the patient's insurance history including claims, prior authorizations, and benefit utilization.",
          inputSchema: { type: 'object', properties: { patient_id: { type: 'string' } } },
          synthesisGuidance: "Act as the member services database. Use the patient information from the Provider's request to look up their insurance history in `knowledgeBase.memberRecords`. Include their deductible progress, out-of-pocket maximum status, prior authorization history, and any relevant claims. Present as a member summary report."
        },
        {
          toolName: "check_deductible_status",
          description: "Checks the patient's current deductible and out-of-pocket maximum status for the plan year.",
          inputSchema: { type: 'object', properties: { patient_id: { type: 'string' } } },
          synthesisGuidance: "Act as the benefits calculator. Use `knowledgeBase.memberRecords` to find the patient's current benefit year status. Return specific amounts: deductible met/remaining, out-of-pocket maximum met/remaining, and how this impacts the requested treatment cost-sharing."
        },
        {
          toolName: "evaluate_request_against_policy",
          description: "Performs a detailed check of a submitted clinical summary against the relevant internal medical policy.",
          inputSchema: { type: 'object', properties: { clinical_summary: { type: 'string' } } },
          synthesisGuidance: "You are the HealthFirst policy engine, a strict but fair auditor. Your rulebook is the `knowledgeBase.medicalPolicy`. Compare the provided `clinical_summary` against your rules. Because you can see the *provider's* knowledge base too, you can be hyper-specific. Your output should be an internal audit report. For each policy rule, state if it is 'MET', 'NOT MET', or 'UNCLEAR'. For 'NOT MET' or 'UNCLEAR' findings, state the specific discrepancy you found. For example, if you see the note about the 5-month trial, your finding should be 'NOT MET: Policy requires 6-month trial of Methotrexate; provider's record confirms a 5-month trial was administered due to intolerance.'"
        },
        {
          toolName: "consult_policy_department",
          description: "Sends a query to the policy clarification department for complex cases requiring interpretation.",
          inputSchema: { type: 'object', properties: { case_summary: { type: 'string' }, specific_question: { type: 'string' } } },
          synthesisGuidance: "Act as the Policy Clarification Department. You have access to both the policy and the full scenario context. Provide a nuanced interpretation that considers policy intent, precedent, and the specific clinical circumstances. Your response should be professional but show some flexibility where the clinical situation warrants it."
        },
        {
          toolName: "approve_authorization",
          description: "Approves the prior authorization request. This is a final decision that concludes the conversation.",
          inputSchema: { type: 'object', properties: { authorization_number: { type: 'string' }, approval_details: { type: 'string' } } },
          synthesisGuidance: "Act as the authorization system. Generate a formal approval letter with the authorization number, effective dates, and any conditions. Include member cost-sharing information based on their benefit status.",
          endsConversation: true
        },
        {
          toolName: "deny_authorization",
          description: "Denies the prior authorization request with specific policy-based reasons. This is a final decision that concludes the conversation.",
          inputSchema: { type: 'object', properties: { denial_reasons: { type: 'string' }, appeal_rights: { type: 'string' } } },
          synthesisGuidance: "Act as the denial notification system. Generate a formal denial letter citing specific policy criteria not met. Include appeal rights and timelines as required by regulations.",
          endsConversation: true
        }
      ],
      knowledgeBase: {
        medicalPolicy: {
          id: "RX-BIO-RA-04",
          criteria: [
            "C1: Diagnosis of moderate to severe RA by a rheumatologist.",
            "C2: A trial of at least 6 months of Methotrexate that resulted in documented failure or intolerance.",
            "C3: Failure or intolerance of at least one other conventional DMARD, with supporting clinical notes.",
          ]
        },
        medicalPolicies: {
          "J1745": { // this is just a quick sketch, real scenarios would have more detail
            policyId: "RX-BIO-RA-04",
            drugName: "Infliximab",
            therapeuticClass: "Biologic DMARD",
            priorAuthRequired: true,
            stepTherapyRequired: true,
            coverageCriteria: [
              "Diagnosis of moderate to severe RA by rheumatologist",
              "Trial and failure of Methotrexate for 6 months",
              "Trial and failure of at least one other conventional DMARD"
            ],
            exceptions: [
              "Documented intolerance with specific adverse effects",
              "Contraindications to conventional DMARDs"
            ]
          }
        },
        memberRecords: {
          "JONES-SARAH-48": { // this is just a quick sketch, real scenarios would have more detail
            memberId: "HF123456789",
            planYear: 2023,
            deductible: { limit: 2000, met: 1850 },
            outOfPocketMax: { limit: 6000, met: 3200 },
            priorAuths: [
              { date: "2023-01-15", drug: "Methotrexate", status: "Approved" },
              { date: "2023-03-20", drug: "Sulfasalazine", status: "Approved" }
            ],
            claims: [
              { date: "2023-02-01", service: "Rheumatology consult", amount: 350 },
              { date: "2023-05-15", service: "Lab work - RA panel", amount: 280 }
            ]
          }
        }
      }
    }
  ]
};