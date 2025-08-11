import React, { useState, useEffect } from 'react';

interface CreateScenarioModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, description: string) => void;
}

const SCENARIO_IDEAS = [
  "Emergency MRI Authorization at 2 AM",
  "Cross-Border Prescription Transfer",
  "Pediatric Vaccine Record Reconciliation",
  "Mental Health Crisis Intervention Coordination",
  "Organ Transplant Eligibility Verification",
  "Clinical Trial Enrollment Negotiation",
  "Home Health Equipment Approval",
  "Specialty Drug Prior Authorization",
  "Telemedicine Coverage Determination",
  "Physical Therapy Session Extension",
  "Genetic Testing Insurance Review",
  "Ambulance Transport Authorization",
  "Prosthetic Device Customization Approval",
  "Cancer Treatment Protocol Verification",
  "Dental Surgery Pre-Authorization",
  "Vision Correction Procedure Coverage",
  "Chronic Pain Management Program",
  "Post-Surgical Rehabilitation Plan",
  "Emergency Medication Override",
  "Preventive Care Benefits Clarification",
  "Medical Travel Reimbursement",
  "Experimental Treatment Access Request",
  "Multi-Specialist Care Coordination",
  "Medicare Advantage Plan Navigation",
  "Workers Compensation Claim Processing"
];

export function CreateScenarioModal({ isOpen, onClose, onCreate }: CreateScenarioModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  
  const getRandomIdea = () => {
    return SCENARIO_IDEAS[Math.floor(Math.random() * SCENARIO_IDEAS.length)];
  };
  
  useEffect(() => {
    if (isOpen && !name) {
      setName(getRandomIdea());
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onCreate(name.trim(), description.trim());
      setName('');
      setDescription('');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Create New Scenario</h2>
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">
              Scenario Name <span className="required">*</span>
            </label>
            <div className="input-with-action">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="form-input"
                placeholder="e.g., Prior Authorization Request"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setName(getRandomIdea())}
                className="dice-button"
                title="Get a random scenario idea"
              >
                🎲
              </button>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="form-textarea"
              placeholder="Brief description of the interoperability scenario..."
              rows={3}
            />
          </div>

          <div className="modal-actions">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim()}
              className="btn-primary"
            >
              Create Scenario
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}