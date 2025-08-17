import React, { useState, useEffect } from 'react';
import { Card } from '../../ui';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { DropdownButton } from './DropdownButton';
import { RUN_MODES } from '../constants/runModes';

const SCENARIO_IDEAS = [
  "[Imaging coverage] A primary care agent shares knee instability notes while a payer policy agent verifies therapy criteria to approve imaging that shortens time to diagnosis.",
  "[Specialty drug access] A rheumatology agent documents medication intolerance while a pharmacy benefits agent confirms step rules to authorize treatment that restores daily function.",
  "[Diabetes technology] An endocrinology agent compiles glucose logs while a device coverage agent validates requirements to approve monitoring that reduces emergencies.",
  "[Cardiac recovery] A hospital discharge agent summarizes the cardiac event while a rehabilitation benefits agent confirms qualifying criteria to start therapy that prevents readmissions.",
  "[Home respiratory support] A pulmonology agent reports oxygen values while a coverage review agent applies thresholds to authorize home services that improve quality of life.",
  "[Surgical readiness] A surgeon's office agent confirms labs and clearances while a facility scheduling agent verifies prerequisites to assign a date that avoids delays.",
  "[Behavioral health placement] A behavioral health agent presents standardized scores while a utilization review agent applies level‑of‑care rules to approve a program that improves stability.",
  "[Outpatient procedure access] A gastroenterology agent details alarm features while a procedure benefits agent verifies indications to schedule care that prevents complications.",
  "[Mobility equipment] A therapy clinic agent summarizes functional limits while a device authorization agent confirms coverage ladders to approve equipment that preserves independence.",
  "[Heart rhythm diagnostics] A cardiology agent shares symptom timelines while a monitoring allocation agent selects a device window to capture events that guide treatment.",
  "[Prenatal screening] An obstetrics agent confirms gestational timing while a lab routing agent picks a pathway to deliver results that support early decisions.",
  "[Genetic risk counseling] A genetics clinic agent provides family history text while a risk assessment agent confirms indications to schedule counseling that informs choices.",
  "[Pediatric therapy] A pediatrics agent compiles evaluation scores while a therapy authorization agent checks criteria to approve sessions that accelerate development.",
  "[Screening intervals] A primary care agent verifies last test dates while a coverage rules agent applies interval guidance to schedule screening that prevents disease.",
  "[Second opinion] An oncology agent assembles staging details while a coordination agent verifies completeness to book a consult that clarifies options.",
  "[Palliative alignment] A primary care agent documents symptom burden while a benefits navigator confirms eligibility to arrange services that match personal goals.",
  "[Post‑discharge home care] A discharge planner agent extracts skilled needs while a home health intake agent validates criteria to start visits that reduce readmissions.",
  "[Allergy evaluation] An allergy clinic agent summarizes seasonal patterns while a testing access agent confirms timing to schedule assessments that tailor care.",
  "[Fertility workup] A fertility clinic agent outlines cycle history while a diagnostic coordinator sequences tests to shorten time to a plan that fits goals.",
  "[Kidney‑safe imaging] An ordering agent shares kidney function values while an imaging protocol agent applies thresholds to choose a safe approach that avoids harm.",
  "[Wellness enrollment] A primary care agent presents weight trends and risks while a program coordinator validates entry rules to enroll support that lowers long‑term complications.",
  "[Antiviral coverage] A liver clinic agent reports genotype and fibrosis details while a regimen coverage agent matches protocols to approve therapy that achieves cure.",
  "[Sleep diagnostics] A sleep medicine agent presents screening scores while a diagnostic access agent validates criteria to schedule a study that restores restful sleep.",
  "[Dermatologic surgery] A dermatology agent describes lesion risk features while a surgical scheduling agent verifies urgency to reserve a slot that reduces cancer risk.",
  "[Respiratory infection triage] A primary care agent compiles symptom history while a coverage triage agent applies guidance to approve testing that directs timely treatment."
];

export function ScenarioLandingPage() {
  const navigate = useNavigate();
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [newScenarioIdea, setNewScenarioIdea] = useState('');
  const [isWiggling, setIsWiggling] = useState(false);
  
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
      if (response.success) {
        setScenarios(response.data.scenarios);
      } else {
        throw new Error(response.error || 'Failed to load scenarios');
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
      if (response.success) {
        await loadScenarios();
      } else {
        throw new Error(response.error || 'Failed to delete scenario');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete scenario');
    }
  };

  const filteredScenarios = scenarios.filter(scenario =>
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
    return scenario.config.agents.map(a => a.principal?.name || a.agentId || 'Unknown').join(' ↔ ');
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

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filteredScenarios.length === 0 ? (
            <div className="col-span-full text-center py-8">
              <p className="text-gray-500">
                {searchTerm ? 'No scenarios found matching your search' : 'No scenarios available'}
              </p>
            </div>
          ) : (
            filteredScenarios.map((scenario) => (
              <Card key={scenario.config.metadata.id} className="hover:shadow-sm transition">
                <div className="mb-3">
                  <h3 className="text-sm font-semibold text-gray-900 mb-1">
                    {scenario.config.metadata.title || scenario.name}
                  </h3>
                  
                  <div className="text-xs text-blue-600 mb-2">
                    {getAgentNames(scenario)}
                  </div>
                  
                  <p className="text-xs text-gray-600 line-clamp-2">
                    {scenario.config.metadata.description || 'Configure and test interoperability conversations'}
                  </p>
                </div>

                <div className="flex gap-2 items-center">
                  <a href={`#/scenarios/${scenario.config.metadata.id}`} className="inline-flex items-center justify-center gap-2 px-2 py-1 text-xs border border-[color:var(--border)] rounded-2xl bg-[color:var(--panel)]" style={{ minHeight: '28px' }}>View</a>
                  <a href={`#/scenarios/${scenario.config.metadata.id}/edit`} className="inline-flex items-center justify-center gap-2 px-2 py-1 text-xs border border-[color:var(--border)] rounded-2xl bg-[color:var(--panel)]" style={{ minHeight: '28px' }}>Edit</a>
                  <DropdownButton
                    label="Run"
                    buttonClassName="bg-[color:var(--primary)] text-[color:var(--primary-foreground)]"
                    options={Object.values(RUN_MODES).map(mode => ({
                      label: mode.label,
                      value: mode.value,
                      description: mode.description,
                      disabled: mode.disabled
                    }))}
                    onSelect={(mode) => {
                      navigate(`/scenarios/${scenario.config.metadata.id}/run?mode=${mode}`);
                    }}
                  />
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
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
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
            className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
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
