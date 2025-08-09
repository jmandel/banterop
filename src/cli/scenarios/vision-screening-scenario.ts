import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';

export function createScenarioConfiguration(): ScenarioConfiguration {
  return {
    metadata: {
      id: "scen_vision_screen_01",
      title: "Pediatric Vision Screening",
      description: "Tests coordination between school nurse and pediatrician for vision screening referral and follow-up.",
      tags: ["pediatrics", "vision", "school-health"]
    },
    scenario: {
      background: "Emma Chen, a 7-year-old second grader, failed her routine school vision screening. The school nurse needs to coordinate with the family pediatrician for comprehensive eye exam and potential treatment.",
      challenges: [
        "The school uses a different screening protocol than the pediatric office expects.",
        "Insurance requires pediatrician referral before ophthalmology consultation.",
        "Parent work schedule makes appointment coordination challenging."
      ]
    },
    agents: [
      {
        agentId: "school-nurse",
        principal: {
          type: "individual",
          name: "Sarah Mitchell, RN",
          description: "School nurse at Lincoln Elementary School responsible for student health screenings."
        },
        situation: "You've completed vision screening for Emma Chen and need to report results to her pediatrician.",
        systemPrompt: "You are a school nurse reporting failed vision screening results. Emma failed the distance vision test (20/40 right eye, 20/50 left eye) using Snellen chart. You need to communicate results to the pediatrician and ensure appropriate follow-up. Be thorough in documenting screening methods and results. Emphasize the importance of timely follow-up.",
        goals: [
          "Report screening results accurately",
          "Ensure pediatrician understands urgency",
          "Coordinate follow-up plan",
          "Document communication"
        ],
        tools: [
          {
            toolName: "retrieve_screening_results",
            description: "Get detailed vision screening results and history",
            inputSchema: { 
              type: "object", 
              properties: { 
                studentId: { type: "string" },
                testType: { type: "string" }
              } 
            },
            synthesisGuidance: "Return screening results showing failed distance vision, normal color vision, normal stereopsis. Include previous year's results showing borderline pass."
          },
          {
            toolName: "get_school_protocol",
            description: "Retrieve school district vision screening protocols",
            inputSchema: { 
              type: "object", 
              properties: { 
                gradeLevel: { type: "string" }
              } 
            },
            synthesisGuidance: "Return protocol requiring Snellen chart at 20 feet, referral threshold of 20/40 or worse, and parent notification requirements."
          },
          {
            toolName: "document_referral",
            description: "Document the referral in school health records",
            inputSchema: { 
              type: "object",
              required: ["studentId", "referralDetails"],
              properties: { 
                studentId: { type: "string" },
                referralDetails: { type: "string" },
                urgency: { type: "string" }
              } 
            },
            synthesisGuidance: "Confirm documentation of referral with timestamp and expected follow-up timeline."
          }
        ],
        knowledgeBase: {
          studentInfo: {
            name: "Emma Chen",
            dob: "2017-03-15",
            grade: "2nd",
            parentContact: "Lisa Chen - 555-0123"
          },
          screeningResults: {
            date: "2024-10-15",
            rightEye: "20/40",
            leftEye: "20/50",
            method: "Snellen chart at 20 feet",
            previousScreening: "2023-10-20: 20/30 both eyes (borderline pass)"
          },
          districtPolicy: {
            referralThreshold: "20/40 or worse in either eye",
            timeline: "Notify parents within 24 hours, physician within 48 hours",
            followUpRequired: "Within 60 days"
          }
        },
        messageToUseWhenInitiatingConversation: "Hello Dr. Roberts, this is Sarah Mitchell from Lincoln Elementary. I need to report vision screening results for your patient Emma Chen."
      },
      {
        agentId: "pediatrician",
        principal: {
          type: "individual",
          name: "Dr. James Roberts, MD",
          description: "Pediatrician at Valley Pediatrics managing Emma's primary care."
        },
        situation: "You're receiving vision screening results from the school nurse about your patient Emma Chen.",
        systemPrompt: "You are a pediatrician receiving school vision screening results. You need to evaluate the findings, determine appropriate next steps, and coordinate care. Consider insurance requirements for specialist referrals. Be aware that school screening methods may differ from clinical standards. Ask clarifying questions about screening conditions and methods used.",
        goals: [
          "Understand screening results and methods",
          "Determine clinical significance",
          "Plan appropriate follow-up",
          "Coordinate specialist referral if needed"
        ],
        tools: [
          {
            toolName: "retrieve_patient_record",
            description: "Access patient's medical record and history",
            inputSchema: { 
              type: "object",
              properties: { 
                patientId: { type: "string" },
                recordType: { type: "string" }
              } 
            },
            synthesisGuidance: "Return record showing no previous vision concerns, normal development, family history of maternal myopia requiring glasses at age 8."
          },
          {
            toolName: "check_insurance_requirements",
            description: "Verify insurance coverage and referral requirements",
            inputSchema: { 
              type: "object",
              properties: { 
                insuranceId: { type: "string" },
                serviceType: { type: "string" }
              } 
            },
            synthesisGuidance: "Return requirement for PCP referral before ophthalmology, covered services include comprehensive eye exam and corrective lenses if prescribed."
          },
          {
            toolName: "create_referral",
            description: "Generate referral to specialist",
            inputSchema: { 
              type: "object",
              required: ["patientId", "specialistType", "reason"],
              properties: { 
                patientId: { type: "string" },
                specialistType: { type: "string" },
                reason: { type: "string" },
                urgency: { type: "string" },
                preferredProvider: { type: "string" }
              } 
            },
            synthesisGuidance: "Generate referral to pediatric ophthalmology with authorization number, including screening results and family history."
          },
          {
            toolName: "schedule_follow_up",
            description: "Schedule follow-up appointment",
            inputSchema: { 
              type: "object",
              required: ["patientId", "appointmentType"],
              properties: { 
                patientId: { type: "string" },
                appointmentType: { type: "string" },
                timeframe: { type: "string" }
              } 
            },
            synthesisGuidance: "Confirm follow-up scheduled in 3 months to review specialist findings and treatment plan."
          }
        ],
        knowledgeBase: {
          patientRecord: {
            name: "Emma Chen",
            dob: "2017-03-15", 
            mrn: "PC-445678",
            insurance: "BlueCross PPO",
            lastVisit: "2024-08-20 - Well child check",
            familyHistory: "Mother - myopia onset age 8, Father - normal vision"
          },
          clinicalGuidelines: {
            visionScreening: "AAP recommends comprehensive eye exam for failed screening",
            referralCriteria: "20/40 or worse warrants ophthalmology evaluation",
            riskFactors: "Family history of early myopia increases risk"
          },
          preferredSpecialists: [
            {
              name: "Dr. Amy Wong, Pediatric Ophthalmology",
              location: "Children's Eye Center",
              waitTime: "2-3 weeks"
            }
          ]
        }
      }
    ]
  };
}