import React from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import logoImage from '../interlocked-speech-bubbles.png';

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const { scenarioId } = useParams<{ scenarioId?: string }>();
  const pathSegments = location.pathname.split('/').filter(Boolean);
  
  const getBreadcrumbs = () => {
    const crumbs = [];
    
    if (pathSegments[0] === 'scenarios') {
      if (pathSegments.length === 1) {
        return null; // Don't show breadcrumbs on landing page
      }
      
      crumbs.push({ label: 'All Scenarios', path: '/scenarios' });
      
      if (scenarioId) {
        crumbs.push({ label: 'Scenario', path: null });
        
        if (pathSegments.includes('edit')) {
          crumbs.push({ label: 'Edit', path: null });
        } else if (pathSegments.includes('view')) {
          crumbs.push({ label: 'View', path: null });
        } else if (pathSegments.includes('run')) {
          crumbs.push({ label: 'Run', path: null });
        } else if (pathSegments.includes('plug-in')) {
          crumbs.push({ label: 'Plugin', path: null });
        }
      }
    }
    
    return crumbs;
  };
  
  const breadcrumbs = getBreadcrumbs();

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="header-content">
          <Link to="/scenarios" className="header-logo">
            <img src={logoImage} alt="Logo" className="logo-image" />
            <h1 className="logo-title">Scenario Tool</h1>
          </Link>
          
          {breadcrumbs && breadcrumbs.length > 0 && (
            <nav className="header-breadcrumbs">
              {breadcrumbs.map((crumb, index) => (
                <React.Fragment key={index}>
                  {index > 0 && <span className="breadcrumb-separator">/</span>}
                  {crumb.path ? (
                    <Link to={crumb.path} className="breadcrumb-link">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="breadcrumb-current">{crumb.label}</span>
                  )}
                </React.Fragment>
              ))}
            </nav>
          )}
        </div>
      </header>

      <main className="app-main">
        {children}
      </main>

      <footer className="app-footer">
        <div className="footer-content">
          <p className="footer-text">Conversational Interoperability - Testing healthcare workflows through dialogue</p>
          <div className="footer-links">
            <a 
              href="https://github.com/jmandel/conversational-interop" 
              className="footer-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              Reference Implementation
            </a>
            <a 
              href="https://confluence.hl7.org/spaces/FHIR/pages/358260686/2025+-+09+Language+First+Interoperability" 
              className="footer-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              Connectathon Track
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}