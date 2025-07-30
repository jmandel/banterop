// Database seeding function - migrates initial scenarios from in-memory store to SQLite
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
  
  // Knee MRI Prior Auth scenario
  const kneeMriConfig: ScenarioConfiguration = {
    scenarioMetadata: {
      id: "scen_knee_mri_01",
      title: "Knee MRI Prior Auth",
      schemaVersion: "2.4",
      description: "Tests prior auth negotiation for knee MRI with conservative therapy and network constraints."
    },
    patientAgent: {
      principalIdentity: "Jordan Alvarez",
      systemPrompt: "You are an AI agent representing Jordan Alvarez, a 38-year-old amateur soccer player with acute right knee injury. Your instructions are to obtain prior authorization for a right knee MRI ordered by your PCP after 16 days of conservative therapy with persistent instability. Communicate clearly, ask for concrete next steps, and provide documentation (PT notes, negative x-ray) when requested.",
      clinicalSketch: {
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
          { type: "X-ray", date: "2024-06-02", result: "Negative for fracture", location: "Urgent care" },
          { type: "Physical therapy notes", date: "2024-06-15 to 2024-06-27", result: "Daily sessions documented", location: "HSS Physical Therapy" }
        ]
      },
      tools: [
        {
          toolName: "submit_mri_auth_request",
          description: "Submit MRI prior authorization request with supporting documentation",
          inputSchema: {
            type: "object",
            properties: {
              studyType: { type: "string", description: "Type of MRI study requested" },
              clinicalInfo: { type: "string", description: "Clinical justification" },
              attachments: { type: "array", description: "Supporting documents" }
            }
          },
          outputDescription: "Authorization request status and tracking information",
          synthesisGuidance: "Generate realistic auth request ID and processing timeline"
        },
        {
          toolName: "check_auth_status",
          description: "Check status of prior authorization request",
          inputSchema: {
            type: "object",
            properties: {
              authRequestId: { type: "string", description: "Authorization request ID" }
            }
          },
          outputDescription: "Current status and any additional requirements",
          synthesisGuidance: "Provide status updates based on submission timeline"
        },
        {
          toolName: "provide_additional_documentation",
          description: "Submit additional documentation requested by insurer",
          inputSchema: {
            type: "object",
            properties: {
              documentType: { type: "string", description: "Type of additional document" },
              content: { type: "string", description: "Document content or summary" }
            }
          },
          outputDescription: "Confirmation of document submission",
          synthesisGuidance: "Confirm receipt and update processing status"
        }
      ],
      behavioralParameters: {
        communicationStyle: "Direct but respectful",
        urgencyLevel: "Moderate - affecting daily activities",
        knowledgeLevel: "Basic healthcare literacy",
        goals: ["Obtain MRI authorization", "Minimize delays", "Understand next steps"]
      }
    },
    supplierAgent: {
      principalIdentity: "HealthFirst Insurance Prior Auth Specialist",
      systemPrompt: "You are a prior authorization specialist for HealthFirst Insurance. Review requests against MRI criteria requiring ≥14 days conservative therapy for non-traumatic knee pain, or immediate imaging for acute trauma with instability. Network providers get expedited processing. Be thorough but efficient in documentation review.",
      operationalContext: {
        workflowSteps: [
          { step: "Initial request triage", decision: "Route to appropriate reviewer" },
          { step: "Clinical documentation review", decision: "Assess conservative therapy compliance" },
          { step: "Network provider verification", decision: "Expedite if in-network" },
          { step: "Final authorization decision", decision: "Approve/deny with clear reasoning" }
        ],
        toolsAndSystems: [
          { name: "AuthReview System", purpose: "Case management and documentation" },
          { name: "ProviderNetwork DB", purpose: "Verify network status for expedited processing" },
          { name: "ClinicalCriteria DB", purpose: "MRI approval criteria and guidelines" }
        ],
        policies: [
          "Knee MRI requires ≥14 days conservative therapy OR acute trauma with instability",
          "Network providers receive expedited 24-48hr processing",
          "Complete documentation required: timeline, imaging, therapy notes"
        ]
      },
      tools: [
        {
          toolName: "review_auth_request",
          description: "Review prior authorization request against clinical criteria",
          inputSchema: {
            type: "object",
            properties: {
              requestId: { type: "string", description: "Authorization request ID" },
              clinicalJustification: { type: "string", description: "Clinical information provided" }
            }
          },
          outputDescription: "Review decision and rationale",
          synthesisGuidance: "Evaluate based on conservative therapy compliance and medical necessity"
        },
        {
          toolName: "request_additional_documentation",
          description: "Request additional documentation from provider",
          inputSchema: {
            type: "object",
            properties: {
              documentType: { type: "string", description: "Type of documentation needed" },
              reason: { type: "string", description: "Reason for additional documentation" }
            }
          },
          outputDescription: "Documentation request details",
          synthesisGuidance: "Generate realistic documentation requests based on policy requirements"
        },
        {
          toolName: "mri_authorization_Success",
          description: "Terminal tool: Successfully complete MRI authorization process",
          inputSchema: {
            type: "object",
            properties: {
              authNumber: { type: "string", description: "Final authorization number" }
            }
          },
          outputDescription: "Final authorization success confirmation",
          synthesisGuidance: "Generate final success confirmation"
        },
        {
          toolName: "mri_authorization_Denial",
          description: "Terminal tool: Deny MRI authorization request",
          inputSchema: {
            type: "object",
            properties: {
              reason: { type: "string", description: "Final denial reason" }
            }
          },
          outputDescription: "Final denial confirmation",
          synthesisGuidance: "Generate final denial with clear rationale"
        }
      ]
    },
    interactionDynamics: {
      startingPoints: {
        PatientAgent: { objective: "Obtain timely MRI authorization with minimal administrative burden" },
        SupplierAgent: { objective: "Ensure medical necessity while maintaining efficient processing" }
      },
      criticalNegotiationPoints: [
        {
          moment: "Documentation review phase",
          patientView: "All required documents provided, expect quick approval",
          supplierView: "Must verify conservative therapy timeline and medical necessity"
        },
        {
          moment: "Network provider verification",
          patientView: "Using in-network provider should expedite approval",
          supplierView: "Network status confirmed, can proceed with expedited timeline"
        }
      ]
    }
  };

  // Cardiology Consult scenario
  const cardioConfig: ScenarioConfiguration = {
    scenarioMetadata: {
      id: "scen_cardio_sched_01",
      title: "Cardiology Consult Scheduling",
      schemaVersion: "2.4",
      description: "Tests appointment scheduling for cardiology consultation with referral management and triage protocols."
    },
    patientAgent: {
      principalIdentity: "Maria Santos",
      systemPrompt: "You are an AI agent representing Maria Santos, a 52-year-old teacher with stable chest pain referred for cardiology consultation. Your goal is to schedule an appropriate appointment within reasonable timeframes while providing necessary clinical information when requested.",
      clinicalSketch: {
        overview: "Stable chest pain with family history of CAD, referred by PCP for cardiology evaluation and stress testing.",
        timeline: [
          { date: "2024-06-15", event: "Onset of intermittent chest discomfort with exertion" },
          { date: "2024-06-22", event: "PCP visit; normal EKG, stable vital signs" },
          { date: "2024-06-25", event: "Cardiology referral placed due to family history" },
          { date: "2024-07-01", event: "Calling for appointment scheduling" }
        ],
        clinicalNotes: [
          "Chest pain: Substernal, 4/10 intensity, triggered by stairs/exertion",
          "Family history: Father with MI at age 58, brother with CAD",
          "EKG 6/22/24: Normal sinus rhythm, no acute changes",
          "Risk factors: Hypertension, pre-diabetes, sedentary lifestyle"
        ],
        labsAndImaging: [
          { type: "EKG", date: "2024-06-22", result: "Normal sinus rhythm", location: "PCP office" },
          { type: "Basic metabolic panel", date: "2024-06-20", result: "Glucose 105, otherwise normal", location: "LabCorp" }
        ]
      },
      behavioralParameters: {
        communicationStyle: "Polite and patient",
        urgencyLevel: "Low-moderate - stable symptoms",
        knowledgeLevel: "Good healthcare literacy",
        goals: ["Schedule timely consultation", "Understand what to expect", "Coordinate with work schedule"]
      },
      tools: [
        {
          toolName: "schedule_appointment",
          description: "Schedule cardiology consultation appointment",
          inputSchema: {
            type: "object",
            properties: {
              preferredDate: { type: "string", description: "Preferred appointment date" },
              timeframe: { type: "string", description: "Preferred time of day" },
              urgency: { type: "string", description: "Clinical urgency level" }
            }
          },
          outputDescription: "Appointment confirmation details",
          synthesisGuidance: "Generate appointment based on clinical urgency and availability"
        },
        {
          toolName: "provide_clinical_information",
          description: "Provide additional clinical information for scheduling",
          inputSchema: {
            type: "object",
            properties: {
              symptoms: { type: "string", description: "Current symptoms description" },
              riskFactors: { type: "string", description: "Cardiovascular risk factors" }
            }
          },
          outputDescription: "Clinical information confirmation",
          synthesisGuidance: "Acknowledge receipt of clinical details"
        },
        {
          toolName: "cardiology_appointment_Success",
          description: "Terminal tool: Successfully schedule cardiology appointment",
          inputSchema: {
            type: "object",
            properties: {
              appointmentDate: { type: "string", description: "Confirmed appointment date and time" }
            }
          },
          outputDescription: "Final appointment confirmation",
          synthesisGuidance: "Generate final appointment confirmation"
        },
        {
          toolName: "cardiology_scheduling_NoSlots",
          description: "Terminal tool: No available slots for requested timeframe",
          inputSchema: {
            type: "object",
            properties: {
              alternativeOptions: { type: "string", description: "Alternative scheduling options" }
            }
          },
          outputDescription: "No slots available notice with alternatives",
          synthesisGuidance: "Provide realistic alternative scheduling options"
        }
      ]
    },
    supplierAgent: {
      principalIdentity: "Metropolitan Cardiology Scheduler",
      systemPrompt: "You are a scheduling coordinator for Metropolitan Cardiology Group. Triage referrals based on clinical urgency: emergent (same day), urgent (1-3 days), semi-urgent (1-2 weeks), routine (4-6 weeks). Verify referrals, collect insurance information, and provide clear pre-visit instructions.",
      operationalContext: {
        workflowSteps: [
          { step: "Referral verification", decision: "Confirm referral details and authorization status" },
          { step: "Clinical triage", decision: "Determine urgency level based on symptoms" },
          { step: "Appointment scheduling", decision: "Offer appropriate timeframe based on triage" },
          { step: "Pre-visit coordination", decision: "Provide instructions and confirm logistics" }
        ],
        toolsAndSystems: [
          { name: "SchedulingSystem", purpose: "Appointment management and provider calendars" },
          { name: "ReferralTracker", purpose: "Verify and track referral authorization" },
          { name: "TriageProtocol", purpose: "Clinical urgency assessment guidelines" }
        ],
        policies: [
          "Stable chest pain = routine scheduling (4-6 weeks)",
          "Active angina or concerning symptoms = urgent (1-3 days)",
          "Referral and insurance verification required before scheduling"
        ]
      },
      tools: [
        {
          toolName: "schedule_appointment",
          description: "Schedule cardiology consultation appointment",
          inputSchema: {
            type: "object",
            properties: {
              preferredDate: { type: "string", description: "Preferred appointment date" },
              timeframe: { type: "string", description: "Preferred time of day" },
              urgency: { type: "string", description: "Clinical urgency level" }
            }
          },
          outputDescription: "Appointment confirmation details",
          synthesisGuidance: "Generate appointment based on clinical urgency and availability"
        },
        {
          toolName: "provide_clinical_information",
          description: "Provide additional clinical information for scheduling",
          inputSchema: {
            type: "object",
            properties: {
              symptoms: { type: "string", description: "Current symptoms description" },
              riskFactors: { type: "string", description: "Cardiovascular risk factors" }
            }
          },
          outputDescription: "Clinical information confirmation",
          synthesisGuidance: "Acknowledge receipt of clinical details"
        },
        {
          toolName: "cardiology_appointment_Success",
          description: "Terminal tool: Successfully schedule cardiology appointment",
          inputSchema: {
            type: "object",
            properties: {
              appointmentDate: { type: "string", description: "Confirmed appointment date and time" }
            }
          },
          outputDescription: "Final appointment confirmation",
          synthesisGuidance: "Generate final appointment confirmation"
        },
        {
          toolName: "cardiology_scheduling_NoSlots",
          description: "Terminal tool: No available slots for requested timeframe",
          inputSchema: {
            type: "object",
            properties: {
              alternativeOptions: { type: "string", description: "Alternative scheduling options" }
            }
          },
          outputDescription: "No slots available notice with alternatives",
          synthesisGuidance: "Provide realistic alternative scheduling options"
        }
      ]
    },
    interactionDynamics: {
      startingPoints: {
        PatientAgent: { objective: "Secure appropriate cardiology appointment with clear expectations" },
        SupplierAgent: { objective: "Efficiently triage and schedule while ensuring proper authorization" }
      },
      criticalNegotiationPoints: [
        {
          moment: "Urgency assessment phase",
          patientView: "Symptoms stable but need evaluation soon",
          supplierView: "Must triage based on clinical criteria and provider availability"
        },
        {
          moment: "Scheduling coordination",
          patientView: "Need appointment that works with schedule",
          supplierView: "Must balance urgency with provider availability"
        }
      ]
    }
  };

  try {
    const now = Date.now();
    
    // Seed Knee MRI scenario
    db.insertScenario({
      id: kneeMriConfig.scenarioMetadata.id,
      name: kneeMriConfig.scenarioMetadata.title,
      config: kneeMriConfig,
      created: now,
      modified: now
    });
    
    console.log(`[Seed] Created Knee MRI scenario`);

    // Seed Cardiology scenario  
    db.insertScenario({
      id: cardioConfig.scenarioMetadata.id,
      name: cardioConfig.scenarioMetadata.title,
      config: cardioConfig,
      created: now,
      modified: now
    });
    
    console.log(`[Seed] Created Cardiology scenario`);
    console.log('[Seed] Database seeding completed successfully');
    
  } catch (error) {
    console.error('[Seed] Error during database seeding:', error);
    throw error;
  }
}