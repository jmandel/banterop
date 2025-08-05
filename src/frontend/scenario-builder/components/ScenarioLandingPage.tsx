import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ScenarioItem } from '$lib/types.js';
import { api } from '../utils/api.js';

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
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [newScenarioName, setNewScenarioName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  
  const getRandomIdea = () => {
    return SCENARIO_IDEAS[Math.floor(Math.random() * SCENARIO_IDEAS.length)];
  };
  
  useEffect(() => {
    setNewScenarioName(getRandomIdea());
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

  const createNewScenario = async () => {
    if (!newScenarioName.trim() || isCreating) return;
    
    setIsCreating(true);
    try {
      const config = {
        metadata: {
          title: newScenarioName,
          description: 'Configure agents and tools for this interoperability scenario',
          schemaVersion: '2.4'
        },
        agents: [],
        interactionDynamics: {
          tools: []
        }
      };
      
      const response = await api.createScenario(newScenarioName, config);
      if (response.success) {
        await loadScenarios();
        navigate(`/scenarios/${response.data.id}/edit`);
      } else {
        throw new Error(response.error || 'Failed to create scenario');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create scenario');
    } finally {
      setIsCreating(false);
    }
  };
  
  const handleCreateKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      createNewScenario();
    }
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

  const getAgentNames = (scenario: ScenarioItem) => {
    return scenario.config.agents.map(a => a.principal?.name || a.id || 'Unknown').join(' ↔ ');
  };

  if (isLoading) {
    return (
      <div className="landing-container">
        <div className="loading">Loading scenarios...</div>
      </div>
    );
  }

  return (
    <div className="landing-page">
      <div className="scenarios-section">
        <input
          type="text"
          className="search-input-full"
          placeholder="Search scenarios by name, description, or agents..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />

        {error && (
          <div className="error-banner">
            {error}
          </div>
        )}

        <div className="scenarios-grid">
          {filteredScenarios.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state-text">
                {searchTerm ? 'No scenarios found matching your search' : 'No scenarios available'}
              </p>
            </div>
          ) : (
            filteredScenarios.map((scenario) => (
              <div key={scenario.id} className="scenario-card">
                <div className="scenario-card-content">
                  <h3 className="scenario-card-title">
                    {scenario.config.metadata.title || scenario.name}
                  </h3>
                  
                  <div className="scenario-card-agents">
                    {getAgentNames(scenario)}
                  </div>
                  
                  <p className="scenario-card-description">
                    {scenario.config.metadata.description || 'Configure and test interoperability conversations'}
                  </p>
                </div>

                <div className="scenario-card-actions">
                  <button
                    className="btn-card-action"
                    onClick={() => navigate(`/scenarios/${scenario.id}/view`)}
                  >
                    View
                  </button>
                  <button
                    className="btn-card-action"
                    onClick={() => navigate(`/scenarios/${scenario.id}/edit`)}
                  >
                    Edit
                  </button>
                  <button
                    className="btn-card-action btn-card-primary"
                    onClick={() => navigate(`/scenarios/${scenario.id}/run`)}
                  >
                    Run
                  </button>
                  <button
                    className="btn-card-action btn-card-secondary"
                    onClick={() => navigate(`/scenarios/${scenario.id}/run?mode=plugin`)}
                  >
                    Plug In
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      
      <div className="create-scenario-hero">
        <h2 className="hero-title">Create New Scenario</h2>
        <div className="create-scenario-box">
          <textarea
            className="scenario-name-input"
            placeholder="Enter scenario description..."
            value={newScenarioName}
            onChange={(e) => setNewScenarioName(e.target.value)}
            onKeyPress={handleCreateKeyPress}
            disabled={isCreating}
            rows={2}
          />
          <button 
            className="dice-button" 
            onClick={() => setNewScenarioName(getRandomIdea())}
            disabled={isCreating}
            title="Random scenario idea"
          >
            <span className="dice-icon">⚄</span>
          </button>
          <button
            className="btn-create-scenario"
            onClick={createNewScenario}
            disabled={!newScenarioName.trim() || isCreating}
          >
            {isCreating ? 'Creating...' : 'Create Scenario'}
          </button>
        </div>
      </div>
    </div>
  );
}