import type { ConversationDatabase } from './database.js';
import type { ScenarioConfiguration } from '$lib/types.js';

/**
 * Seeds the database with initial scenarios from the design docs
 * Only seeds if scenarios are missing, avoiding unnecessary work
 */
export function seedDatabase(db: ConversationDatabase): void {
  // Check if we already have scenarios seeded
  const existingScenarios = db.listScenarios();
  if (existingScenarios.length >= 2) {
    console.log('[Seed] Database already contains scenarios, skipping seed');
    return;
  }
  
  console.log('[Seed] Seeding database with initial scenarios...');
  
  const kneeMriConfig: ScenarioConfiguration = {
    metadata: {
      id: "scen_knee_mri_01",
      title: "Knee MRI Prior Auth",
      description: "Tests prior auth negotiation for knee MRI with conservative therapy and network constraints.",
      tags: ["prior-auth", "orthopedics"]
    },
    scenario: {
      background: "Jordan Alvarez, a 38-year-old amateur soccer player, sustained an acute right knee injury. After 16 days of conservative therapy with persistent instability, his PCP has ordered an MRI.",
      challenges: [
        "The insurer's policy requires ≥14 days of conservative therapy, which has been met, but documentation must be clear.",
        "The insurer gives expedited processing for in-network providers, which must be verified."
      ]
    },
    agents: [
      {
        agentId: { id: "patient-agent", label: "Patient Agent", role: "PatientAgent" },
        principal: {
          type: "individual",
          name: "Jordan Alvarez",
          description: "A 38-year-old amateur soccer player with an acute right knee injury."
        },
        situation: "You are preparing to contact the insurance company to get prior authorization for a right knee MRI for your client, Jordan Alvarez.",
        systemPrompt: "You are an AI agent representing Jordan Alvarez. Your instructions are to obtain prior authorization for a right knee MRI. Communicate clearly, provide necessary documentation when requested, and aim for a swift approval.",
        goals: ["Obtain MRI authorization", "Minimize delays", "Understand next steps"],
        tools: [
          {
            toolName: "search_ehr_clinical_notes",
            description: "Search EHR for patient's clinical notes and visit summaries.",
            inputSchema: { type: "object", properties: { dateRange: { type: "string" }, searchTerms: { type: "string" } } },
            synthesisGuidance: "Return relevant clinical notes related to knee injury, physical exam findings, and treatment history from the knowledgeBase."
          },
          {
            toolName: "retrieve_imaging_reports",
            description: "Retrieve radiology and imaging reports from the EHR.",
            inputSchema: { type: "object", properties: { imagingType: { type: "string" }, bodyPart: { type: "string" } } },
            synthesisGuidance: "Return X-ray reports showing no fracture and mild joint effusion as documented in the knowledgeBase."
          },
          {
            toolName: "get_therapy_documentation",
            description: "Retrieve physical therapy notes and progress reports.",
            inputSchema: { type: "object", properties: { therapyType: { type: "string" }, dateRange: { type: "string" } } },
            synthesisGuidance: "Return PT notes documenting daily sessions and persistent anterior instability from the knowledgeBase timeline."
          },
          {
            toolName: "lookup_provider_network_status",
            description: "Check if a provider or facility is in the patient's insurance network.",
            inputSchema: { type: "object", properties: { providerName: { type: "string" }, providerType: { type: "string" } } },
            synthesisGuidance: "Verify network status of the imaging facility or provider."
          }
        ],
        knowledgeBase: {
        overview: "Acute right knee injury with suspected ACL tear after a pivot injury during soccer. Persistent instability despite PT.",
        timeline: [
          { date: "2024-06-01", event: "Pivot injury to right knee during soccer; swelling within hours" },
          { date: "2024-06-02", event: "Urgent care visit; x-ray negative for fracture; knee immobilizer provided" },
          { date: "2024-06-10", event: "PCP exam positive Lachman; MRI ordered if instability persists after PT" },
          { date: "2024-06-15", event: "Physical therapy started (HSS PT)" },
          { date: "2024-06-27", event: "Continued instability with stairs and pivoting; PT notes document limited improvement" },
          { date: "2024-07-01", event: "PCP ordered right knee MRI without contrast" }
        ],
        clinicalNotes: [
          "X-ray 6/2/24: Negative for fracture, mild joint effusion",
          "PT notes 6/15-6/27: Daily sessions, persistent anterior instability with functional activities",
          "Lachman test: Positive (Grade 2) with soft endpoint",
          "McMurray test: Negative for meniscal involvement"
        ],
        labsAndImaging: [
            { date: "2024-06-10", event: "PCP exam positive Lachman; MRI ordered if instability persists." }
          ]
        },
        messageToUseWhenInitiatingConversation: "Hello, I'm following up on the prior authorization request for my right knee MRI."
      },
      {
        agentId: { id: "supplier-agent", label: "Supplier Agent", role: "SupplierAgent" },
        principal: {
          type: "organization",
          name: "HealthFirst Insurance",
          description: "A national health insurance provider."
        },
        situation: "You are a prior authorization specialist at HealthFirst Insurance, waiting for the next case in your queue.",
        systemPrompt: "You are a prior authorization specialist. Review requests against the official medical policy. Be thorough but efficient.",
        goals: ["Ensure medical necessity is met", "Adhere to company policy", "Provide clear decisions"],
        tools: [
          {
            toolName: "mri_authorization_Success",
            description: "Terminal tool: Approve the MRI authorization request.",
            inputSchema: { type: "object", properties: { reason: { type: "string" } } },
            synthesisGuidance: "Generate a final authorization number and approval confirmation.",
            endsConversation: true
          },
          {
            toolName: "mri_authorization_Denial",
            description: "Terminal tool: Deny the MRI authorization request.",
            inputSchema: { type: "object", properties: { reason: { type: "string" } } },
            synthesisGuidance: "Generate a final denial with a clear, policy-based rationale.",
            endsConversation: true
          }
        ],
        knowledgeBase: {
        workflowSteps: [
          { step: "Initial request triage", decision: "Route to appropriate reviewer" },
          { step: "Clinical documentation review", decision: "Assess conservative therapy compliance" },
          { step: "Network provider verification", decision: "Expedite if in-network" },
          { step: "Final authorization decision", decision: "Approve/deny with clear reasoning" }
        ],
          policy_id: "HF-MRI-KNEE-2024",
          criteria: [ "Knee MRI requires ≥14 days of documented conservative therapy." ]
        },
        messageToUseWhenInitiatingConversation: "Hello, this is HealthFirst Insurance calling regarding the prior authorization request for Jordan Alvarez. Is the PA Specialist available?"
      }
    ]
  };

  const cardioConfig: ScenarioConfiguration = {
    metadata: {
      id: "scen_cardio_sched_01",
      title: "Cardiology Consult Scheduling",
      description: "Tests appointment scheduling for cardiology consultation with referral management and triage protocols.",
      tags: ["scheduling", "cardiology"]
    },
    scenario: {
      background: "Maria Santos, a 52-year-old teacher with stable chest pain, has been referred by her PCP for cardiology consultation and stress testing.",
      challenges: [
        "The patient prefers morning appointments due to work schedule.",
        "The practice must triage based on clinical urgency while managing limited appointment slots."
      ]
    },
    agents: [
      {
        agentId: { id: "patient-scheduling", label: "Patient Representative", role: "PatientAgent" },
        principal: {
          type: "individual",
          name: "Maria Santos",
          description: "A 52-year-old teacher with stable chest pain needing cardiology consultation."
        },
        situation: "You are calling to schedule a cardiology consultation appointment for Maria Santos.",
        systemPrompt: "You are representing Maria Santos. Schedule an appropriate appointment while providing necessary clinical information when requested.",
        goals: ["Schedule timely consultation", "Understand what to expect", "Coordinate with work schedule"],
        tools: [
          {
            toolName: "retrieve_referral_details",
            description: "Retrieve the cardiology referral details from the EHR.",
            inputSchema: { type: "object", properties: { referralId: { type: "string" }, includeClinicalnotes: { type: "boolean" } } },
            synthesisGuidance: "Return referral information including reason for referral, referring provider, and clinical urgency from the knowledgeBase."
          },
          {
            toolName: "get_recent_vitals",
            description: "Retrieve recent vital signs and cardiac-related test results.",
            inputSchema: { type: "object", properties: { dateRange: { type: "string" }, includeEkg: { type: "boolean" } } },
            synthesisGuidance: "Return normal EKG results and stable vital signs as documented in the timeline."
          },
          {
            toolName: "search_medical_history",
            description: "Search patient's medical history for cardiac risk factors and family history.",
            inputSchema: { type: "object", properties: { categoryFilter: { type: "string" } } },
            synthesisGuidance: "Return family history of CAD and hypertension from the knowledgeBase risk factors."
          },
          {
            toolName: "retrieve_medication_list",
            description: "Get current medication list from the EHR.",
            inputSchema: { type: "object", properties: { includeDiscontinued: { type: "boolean" } } },
            synthesisGuidance: "Return any cardiac-related medications if applicable."
          },
        ],
        knowledgeBase: {
          overview: "Stable chest pain with family history of CAD, referred by PCP for cardiology evaluation and stress testing.",
          timeline: [
            { date: "2024-06-15", event: "Onset of intermittent chest discomfort with exertion" },
            { date: "2024-06-22", event: "PCP visit; normal EKG, stable vital signs" },
            { date: "2024-06-25", event: "Cardiology referral placed due to family history" },
            { date: "2024-07-01", event: "Calling for appointment scheduling" }
          ],
          referral_info: {
            date: "2024-06-25",
            symptoms: "Stable chest pain with exertion",
            risk_factors: ["Family history of CAD", "Hypertension"]
          }
        },
        messageToUseWhenInitiatingConversation: "Hello, I'm calling to schedule a cardiology consultation for Maria Santos. Her PCP referred her for evaluation of chest pain symptoms."
      },
      {
        agentId: { id: "scheduling-coordinator", label: "Scheduling Coordinator", role: "SupplierAgent" },
        principal: {
          type: "organization",
          name: "Metropolitan Cardiology Group",
          description: "A specialty cardiology practice."
        },
        situation: "You are a scheduling coordinator handling incoming appointment requests.",
        systemPrompt: "You are a scheduling coordinator. Triage referrals based on clinical urgency and available slots.",
        goals: ["Efficiently triage and schedule", "Ensure proper authorization", "Provide clear instructions"],
        tools: [
          {
            toolName: "lookup_triage_policy",
            description: "Retrieve triage guidelines for cardiology referrals based on symptoms and urgency.",
            inputSchema: { type: "object", properties: { symptoms: { type: "string" }, referralReason: { type: "string" } } },
            synthesisGuidance: "Use the knowledgeBase triage_protocols to return the appropriate urgency level and scheduling timeframe. Be specific about which symptoms map to which urgency levels."
          },
          {
            toolName: "retrieve_scheduling_requirements",
            description: "Get required pre-appointment information and documentation needed for specific visit types.",
            inputSchema: { type: "object", properties: { visitType: { type: "string" }, insurance: { type: "string" } } },
            synthesisGuidance: "Return the scheduling requirements from knowledgeBase including required documents, pre-visit testing, insurance authorization needs, and patient preparation instructions."
          },
          {
            toolName: "check_availability",
            description: "Check available appointment slots based on urgency level and provider preferences.",
            inputSchema: { type: "object", properties: { urgencyLevel: { type: "string" }, dateRange: { type: "string" }, timePreference: { type: "string" } } },
            synthesisGuidance: "Return realistic appointment availability based on the urgency level from triage. Morning slots are limited. Consider the practice's scheduling patterns in the knowledgeBase."
          },
          {
            toolName: "assess_insurance_requirements",
            description: "Check if referral or prior authorization is needed for the appointment.",
            inputSchema: { type: "object", properties: { insurancePlan: { type: "string" }, visitType: { type: "string" } } },
            synthesisGuidance: "Use knowledgeBase insurance_requirements to determine if the patient's insurance requires referral or prior auth for cardiology consultation."
          },
          {
            toolName: "confirm_appointment",
            description: "Terminal tool: Confirm and book the appointment.",
            inputSchema: { type: "object", properties: { dateTime: { type: "string" }, providerName: { type: "string" }, visitType: { type: "string" }, preparationInstructions: { type: "string" } } },
            synthesisGuidance: "Generate a comprehensive appointment confirmation including date/time, provider, location, preparation instructions, and what to bring.",
            endsConversation: true
          },
          {
            toolName: "no_availability",
            description: "Terminal tool: No appointments available within requested timeframe.",
            inputSchema: { type: "object", properties: { reason: { type: "string" }, alternativeOptions: { type: "string" }, waitlistOption: { type: "boolean" } } },
            synthesisGuidance: "Explain lack of availability and provide alternative options such as waitlist, different timeframes, or urgent care options if clinically appropriate.",
            endsConversation: true
          }
        ],
        knowledgeBase: {
          triage_protocols: {
            chest_pain: {
              unstable: { urgency: "emergent", timeframe: "immediate ED referral", symptoms: ["crushing chest pain", "radiation to arm/jaw", "shortness of breath", "diaphoresis"] },
              accelerated: { urgency: "urgent", timeframe: "24-48 hours", symptoms: ["new onset angina", "crescendo pattern", "rest pain"] },
              stable: { urgency: "routine", timeframe: "2-4 weeks", symptoms: ["stable exertional chest pain", "atypical chest pain", "chest pain with risk factors"] }
            },
            arrhythmia: {
              symptomatic: { urgency: "urgent", timeframe: "1-3 days", symptoms: ["syncope", "near-syncope", "sustained palpitations"] },
              asymptomatic: { urgency: "routine", timeframe: "2-6 weeks", symptoms: ["incidental finding", "occasional palpitations"] }
            }
          },
          scheduling_requirements: {
            new_patient_consultation: {
              documents_needed: ["referral letter", "recent EKG", "relevant imaging", "medication list"],
              preparation: "No caffeine 24 hours before if stress test ordered",
              duration: "60-90 minutes",
              insurance_check: "Most plans require PCP referral"
            },
            stress_test: {
              documents_needed: ["physician order", "recent EKG"],
              preparation: "NPO 4 hours, no caffeine 24 hours, comfortable shoes",
              duration: "2-3 hours",
              contraindications: ["recent MI", "unstable angina", "severe aortic stenosis"]
            }
          },
          insurance_requirements: {
            medicare: { referral_required: false, prior_auth_required: false },
            commercial_hmo: { referral_required: true, prior_auth_required: "varies by plan" },
            commercial_ppo: { referral_required: false, prior_auth_required: "for procedures only" }
          },
          appointment_patterns: {
            morning_slots: "Limited - typically 2-3 new patient slots",
            afternoon_slots: "More availability - 4-5 new patient slots",
            provider_schedules: {
              dr_chen: "Mon/Wed/Fri - interventional focus",
              dr_patel: "Tue/Thu - general and preventive",
              dr_williams: "Mon-Thu - electrophysiology"
            }
          }
        },
        messageToUseWhenInitiatingConversation: "Good morning, this is Metropolitan Cardiology Group. We received a referral for Maria Santos. I'm calling to help schedule her consultation appointment."
      }
    ]
  };

  try {
    const now = Date.now();
    
    db.insertScenario({
      id: kneeMriConfig.metadata.id,
      name: kneeMriConfig.metadata.title,
      config: kneeMriConfig,
      created: now,
      modified: now,
      history: []
    });
    
    console.log(`[Seed] Created Knee MRI scenario`);

    db.insertScenario({
      id: cardioConfig.metadata.id,
      name: cardioConfig.metadata.title,
      config: cardioConfig,
      created: now,
      modified: now,
      history: []
    });
    
    console.log(`[Seed] Created Cardiology scenario`);
    console.log('[Seed] Database seeding completed successfully');
    
  } catch (error) {
    console.error('[Seed] Error during database seeding:', error);
    throw error;
  }
}