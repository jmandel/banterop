import React from 'react';

export function ClientLinksCard() {
  return (
    <div className="card">
      <div className="small font-semibold mb-2">Helpful Links</div>
      <div className="row items-center justify-between">
        <div className="small">Scenario Editor</div>
        <a className="btn secondary" href="/scenarios/" target="_blank" rel="noreferrer">Open</a>
      </div>
      <div className="row items-center justify-between mt-2">
        <div className="small">Zulip chat.fhir.org</div>
        <a className="btn secondary" href="https://chat.fhir.org/" target="_blank" rel="noreferrer">Open</a>
      </div>
    </div>
  );
}

