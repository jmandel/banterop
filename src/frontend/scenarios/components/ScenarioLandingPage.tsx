import React, { useState, useEffect } from 'react';
import { Card, Button } from '../../ui';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { DropdownButton } from './DropdownButton';
import { RUN_MODES } from '../constants/runModes';
import { getShowMode, setShowMode, isPublished } from '../utils/locks';

const SCENARIO_IDEAS = [
  "Primary‑care agent ↔ Rheumatology intake agent: confirm referral eligibility for suspected RA by reconciling recent labs/symptoms with clinic’s referral criteria and capacity.",
  "Oncology trial prescreener agent ↔ Health‑system EHR agent: determine inclusion/exclusion for a HER2+ trial by mapping local meds/allergies to trial rules and producing a de‑identified prescreen log.",
  "Hospital discharge planner agent ↔ Skilled nursing facility intake agent: decide SNF placement by matching functional scores, payer days remaining, and bed availability/preferences.",
  "ED triage agent ↔ Outpatient cardiology fast‑track agent: negotiate next‑day chest‑pain clinic slot using risk score, prior imaging, and insurance constraints.",
  "Endocrinology clinic agent ↔ Payer prior‑auth agent: approve GLP‑1 therapy by assembling failed‑therapy history and BMI/A1c evidence against plan rules.",
  "Orthopedics surgical scheduler agent ↔ Anesthesia clearance agent: clear for OR by reconciling meds/comorbidities with fasting, anticoagulant hold, and airway risk protocols.",
  "Community health worker agent ↔ Transportation benefits agent: arrange rides for dialysis by proving appointment cadence and member eligibility, then issuing ride vouchers.",
  "Pediatric clinic agent ↔ School nurse agent: authorize return‑to‑play after concussion by merging symptom logs with school safety policy and scheduling neurocognitive testing.",
  "Behavioral health clinic agent ↔ 42 CFR Part 2 consent service agent: share SUD treatment summary by negotiating segmented disclosure scope, purpose, and expiration.",
  "Dermatology telehealth agent ↔ Imaging/LIS agent: decide biopsy vs watchful waiting by matching image quality needs and pathology turnaround with patient preference and travel limits.",
  "Transplant center agent ↔ Outside hospital EHR agent: evaluate transplant referral by collecting cross‑institution labs/imaging and normalizing HLA data formats.",
  "Genomics lab agent ↔ Research registry agent: contribute variant data by aligning consent, de‑identification rules, and VCF field mapping to registry schema.",
  "Maternal‑fetal medicine agent ↔ Radiology scheduling agent: book targeted ultrasound by reconciling gestational age, indications, and scanner availability with interpreter needs.",
  "Home health agency agent ↔ DME supplier agent: approve home O₂ by negotiating ABG/SpO₂ evidence, qualifying diagnoses, and delivery logistics.",
  "Pharmacy agent ↔ PBM real‑time benefits agent: pick a covered inhaler by trading current med list, step therapy history, and formulary tiers with out‑of‑pocket estimates.",
  "Allergy clinic agent ↔ Immunotherapy mixing lab agent: initiate allergy shots by verifying skin test results, vial build protocol, and schedule safety windows.",
  "Neurology clinic agent ↔ Infusion center agent: schedule IVIG by reconciling weight‑based dosing, labs, payer auth, and chair capacity.",
  "Ophthalmology clinic agent ↔ Vision benefits agent: decide coverage for glaucoma laser vs drops by aligning diagnosis codes, IOP trends, and plan rules.",
  "Dental clinic agent ↔ Medicare Advantage agent: determine coverage for extractions prior to radiation by mapping oncology plan of care to dental benefits.",
  "Wound care clinic agent ↔ Visiting nurse agent: coordinate home debridement schedule by merging wound measurements, supply formulary, and nurse territory.",
  "Sleep clinic agent ↔ DME CPAP supplier agent: fulfill CPAP order by assembling AHI evidence, titration results, and coverage compliance rules.",
  "Pulmonology clinic agent ↔ Imaging center agent: pick low‑dose CT site by balancing Lung‑RADS indications, prior imaging availability, and cost estimate.",
  "Hematology clinic agent ↔ Blood bank agent: clear iron infusion by checking transfusion history, antibodies, and lab thresholds against infusion protocols.",
  "HIV clinic agent ↔ Public health reporting agent: submit case without PHI leakage by negotiating data minimization and deduplication keys.",
  "Travel medicine clinic agent ↔ Border health certificate agent: issue Yellow Fever certificate by verifying vaccine lot/expiry and traveler itinerary constraints.",
  "Urology clinic agent ↔ Radiology prostate MRI agent: ensure pre‑MRI prep by aligning devices/implants data, renal function for contrast, and scheduling slots.",
  "Orthotics clinic agent ↔ Payer DME agent: approve diabetic shoes by reconciling podiatry exam findings and A1c history with documentation requirements.",
  "Palliative care agent ↔ Hospice intake agent: establish hospice eligibility by assembling prognosis notes, ADL scores, and caregiver capacity.",
  "Ob‑Gyn clinic agent ↔ Confidential adolescent consent agent: coordinate STI care while enforcing minor confidentiality and explanation of benefits suppression.",
  "Domestic violence shelter health agent ↔ Hospital records agent: obtain limited records using safe‑contact protocols, purpose restriction, and redaction of address/contacts.",
  "Sports medicine agent ↔ Imaging prior‑auth agent: authorize MRI knee by mapping injury mechanism, physical exam, and failed PT trials to plan criteria.",
  "IRB liaison agent ↔ Investigator agent: approve protocol amendment by negotiating new data elements, consent language, and re‑contact plan.",
  "ACO quality agent ↔ Multi‑clinic EHR agents: close HEDIS gaps by aggregating vaccinations/labs across sites and reconciling measure logic versions.",
  "Employer occupational health agent ↔ PCP agent: clear fit‑for‑duty by sharing limited problem/med list per employee consent and employer policy scope.",
  "Workers’ comp claims agent ↔ Orthopedic clinic agent: approve surgery by aligning injury timeline and imaging with policy coverage and employer restrictions.",
  "SSDI disability agent ↔ Specialty clinic agent: adjudicate disability claim by assembling longitudinal function tests and linking to SSA listings.",
  "Telepsychiatry crisis agent ↔ Mobile crisis team agent: dispatch in‑person response by merging real‑time risk assessment, location/availability, and legal thresholds.",
  "Rare disease registry agent ↔ Academic center agent: enroll patient by negotiating phenopacket fields, gene panels, and contact frequency under dynamic consent.",
  "Care manager agent ↔ Food pantry benefits agent: approve medically tailored meals by sharing diagnoses, diet restrictions, and delivery windows.",
  "Diabetes program agent ↔ Glucose sensor vendor agent: ship CGM by mapping Rx, prior auth, and training needs to vendor onboarding.",
  "Imaging import agent ↔ External hospital PACS agent: retrieve prior studies by negotiating identifiers, IHE profiles vs simple S3 link, and de‑duplication.",
  "Pathology lab agent ↔ Tumor board agent: assemble slide images and structured synoptic report with provenance for multidisciplinary review.",
  "Out‑of‑network exception agent ↔ Payer medical director agent: justify exception based on subspecialty outcomes data and geographic access rules.",
  "Second‑opinion service agent ↔ Originating hospital agent: package de‑identified case summary plus key DICOM frames per receiving specialist’s preferences.",
  "Public health outbreak agent ↔ Urgent care network agent: stand up just‑in‑time case reporting by negotiating schema, dedupe keys, and TAT commitments.",
  "Medication reconciliation agent ↔ HIE aggregator agent: reconcile med list by triangulating pharmacy fill data, patient‑reported meds, and inpatient MAR.",
  "Financial assistance agent ↔ Hospital revenue cycle agent: approve charity care by exchanging income proofs, residency, and presumptive eligibility sources.",
  "Prior‑auth “gold card” agent ↔ Payer policy agent: certify provider for reduced prior‑auth burden by sharing historical appropriateness metrics.",
  "Data‑sharing consent agent ↔ Personal health record agent: craft granular consent for app data export (e.g., only vitals + meds) with expiration and revocation path.",
  "AI labeling agent ↔ Receiving registry agent: submit AI‑abstracted chart review with explicit “AI‑generated” tags, confidence, and links to source snippets."
];

export function ScenarioLandingPage() {
  const navigate = useNavigate();
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [newScenarioIdea, setNewScenarioIdea] = useState('');
  const [isWiggling, setIsWiggling] = useState(false);
  const [showMode, _setShowMode] = useState<'published' | 'all'>(getShowMode());
  const [showingFallbackNote, setShowingFallbackNote] = useState(false);
  
  const getRandomIdea = () => {
    return SCENARIO_IDEAS[Math.floor(Math.random() * SCENARIO_IDEAS.length)];
  };
  
  useEffect(() => {
    setNewScenarioIdea(getRandomIdea());
  }, []);

  useEffect(() => {
    loadScenarios();
  }, []);

  const loadScenarios = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await api.getScenarios();
      if (!response.success) throw new Error('Failed to load scenarios');
      const list = response.data.scenarios;
      setScenarios(list);
      if (getShowMode() === 'published') {
        const onlyPublished = list.filter(s => isPublished(s.config));
        if (onlyPublished.length === 0) {
          // Auto-fallback once to All and show note
          _setShowMode('all');
          setShowMode('all');
          setShowingFallbackNote(true);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scenarios');
    } finally {
      setIsLoading(false);
    }
  };
  
  const createNewScenario = () => {
    // Pass the scenario idea as plain text in URL
    const ideaParam = encodeURIComponent(newScenarioIdea);
    navigate(`/scenarios/create?idea=${ideaParam}`);
  };

  const deleteScenario = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this scenario?')) return;

    try {
      const response = await api.deleteScenario(id);
      if (!response.success) throw new Error('Failed to delete scenario');
      await loadScenarios();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete scenario');
    }
  };

  const byMode = showMode === 'published' ? scenarios.filter(s => isPublished(s.config)) : scenarios;
  const filteredScenarios = byMode.filter(scenario =>
    scenario.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    scenario.config.metadata.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (scenario.config.metadata.description || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getAgentNames = (scenario: any) => {
    return (Array.isArray(scenario?.config?.agents) ? scenario.config.agents : []).map((a: any) => a?.principal?.name || a?.agentId || 'Unknown').join(' ↔ ');
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center text-gray-600">Loading scenarios...</div>
      </div>
    );
  }

  const triggerWiggle = () => {
    setIsWiggling(true);
    setTimeout(() => setIsWiggling(false), 300);
  };

  const handleDiceClick = () => {
    triggerWiggle();
    setNewScenarioIdea(getRandomIdea());
  };

  return (
    <div className="container mx-auto px-4 py-4 space-y-4">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <button
              className={`px-3 py-1 text-xs rounded ${showMode === 'published' ? 'bg-primary text-primary-foreground' : 'border border-gray-300 text-gray-700'}`}
              onClick={() => { _setShowMode('published'); setShowMode('published'); setShowingFallbackNote(false); }}
            >Published</button>
            <button
              className={`px-3 py-1 text-xs rounded ${showMode === 'all' ? 'bg-primary text-primary-foreground' : 'border border-gray-300 text-gray-700'}`}
              onClick={() => { _setShowMode('all'); setShowMode('all'); setShowingFallbackNote(false); }}
            >All</button>
          </div>
        </div>
        <input
          type="text"
          className="w-full px-4 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Search scenarios by name, description, or agents..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />

        {error && (
          <div className="p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md">
            {error}
          </div>
        )}
        {showingFallbackNote && (
          <div className="p-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md">
            No published scenarios yet — showing All.
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filteredScenarios.length === 0 ? (
            <div className="col-span-full text-center py-8">
              <p className="text-gray-500">
                {searchTerm ? 'No scenarios found matching your search' : 'No scenarios available'}
              </p>
            </div>
          ) : (
            filteredScenarios.map((scenario: any) => (
              <Card key={scenario.config.metadata.id} className="hover:shadow-sm transition">
                <div className="mb-3">
                  <h3 className="text-sm font-semibold text-gray-900 mb-1">
                    {scenario.config.metadata.title || scenario.name}
                  </h3>
                  {isPublished(scenario.config) && (
                    <div className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 border border-gray-200 mb-1">
                      <span>🔒</span>
                      <span>Published</span>
                    </div>
                  )}
                  
                  <div className="text-xs text-primary mb-2">
                    {getAgentNames(scenario)}
                  </div>
                  
                  <p className="text-xs text-gray-600 line-clamp-2">
                    {scenario.config.metadata.description || 'Configure and test interoperability conversations'}
                  </p>
                </div>

                <div className="flex gap-2 items-center">
                  <a href={`#/scenarios/${scenario.config.metadata.id}`} className="inline-flex items-center justify-center gap-2 px-2 py-1 text-xs border border-border rounded-2xl bg-panel min-h-[28px]">View</a>
                  <a href={`#/scenarios/${scenario.config.metadata.id}/edit`} className="inline-flex items-center justify-center gap-2 px-2 py-1 text-xs border border-border rounded-2xl bg-panel min-h-[28px]">Edit</a>
                  <Button as="a" size="sm" variant="primary" href={`#/scenarios/${scenario.config.metadata.id}/run`}>
                    Run
                  </Button>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
      
      <div className="mt-6 p-4 bg-gray-50 rounded-md border border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Create New Scenario</h2>
        <div className="space-y-3">
          <div className="flex gap-2">
            <textarea
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary resize-none"
              placeholder="Enter scenario description..."
              value={newScenarioIdea}
              onChange={(e) => setNewScenarioIdea(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  createNewScenario();
                }
              }}
              rows={2}
            />
            <button 
              className="flex items-center justify-center text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 flex-shrink-0 aspect-square w-[68px] h-[68px]" 
              onClick={handleDiceClick}
              onMouseEnter={triggerWiggle}
              title="Random scenario idea"
            >
              <span 
                className={`text-[2.5rem] leading-none inline-block transition-transform duration-150 ease-in-out ${isWiggling ? 'rotate-[-10deg]' : 'rotate-0'}`}
              >
                ⚄
              </span>
            </button>
          </div>
          <button
            className="w-full px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
            onClick={createNewScenario}
            disabled={!newScenarioIdea.trim()}
          >
            Create Scenario
          </button>
        </div>
      </div>
    </div>
  );
}
