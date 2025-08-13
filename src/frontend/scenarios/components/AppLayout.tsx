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
      
      crumbs.push({ label: 'All', path: '/scenarios' });
      
      if (scenarioId) {
        // Show scenario id as the crumb label; pages further append their action
        crumbs.push({ label: decodeURIComponent(scenarioId), path: `/scenarios/${encodeURIComponent(scenarioId)}` });
        
        if (pathSegments.includes('edit')) {
          crumbs.push({ label: 'Edit', path: null });
        } else if (pathSegments.includes('view')) {
          crumbs.push({ label: 'View', path: null });
        } else if (pathSegments.includes('run')) {
          crumbs.push({ label: 'Run', path: null });
        } else if (pathSegments.includes('plug-in')) {
          crumbs.push({ label: 'Plugin', path: null });
        }
      } else if (pathSegments[1] === 'created' && pathSegments[2]) {
        // Attempt to hydrate breadcrumbs for created/:conversationId using localStorage metadata
        const convId = pathSegments[2];
        try {
          const raw = localStorage.getItem(`convoMeta:${convId}`);
          if (raw) {
            const meta = JSON.parse(raw);
            const scenId = meta?.scenarioId as string | undefined;
            const scenTitle = meta?.title as string | undefined;
            if (scenId) {
              crumbs.push({ label: scenTitle || scenId, path: `/scenarios/${encodeURIComponent(scenId)}` });
              crumbs.push({ label: 'Run', path: null });
            } else {
              crumbs.push({ label: `Conversation #${convId}`, path: null });
            }
          } else {
            crumbs.push({ label: `Conversation #${convId}`, path: null });
          }
        } catch {
          const convIdFallback = pathSegments[2];
          crumbs.push({ label: `Conversation #${convIdFallback}`, path: null });
        }
      }
    }
    
    return crumbs;
  };
  
  const breadcrumbs = getBreadcrumbs();

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="sticky top-0 z-30 border-b bg-white/90 backdrop-blur">
        <div className="container mx-auto px-4 py-2 flex items-center justify-between">
          <Link to="/scenarios" className="flex items-center gap-3 text-gray-900 no-underline hover:text-gray-700 transition-colors">
            <img src={logoImage} alt="Logo" className="w-10 h-10 object-contain" />
            <h1 className="text-xl font-semibold">Scenario Tool</h1>
          </Link>
          
          {breadcrumbs && breadcrumbs.length > 0 && (
            <nav className="flex items-center gap-2 text-sm">
              {breadcrumbs.map((crumb, index) => (
                <React.Fragment key={index}>
                  {index > 0 && <span className="text-gray-400">/</span>}
                  {crumb.path ? (
                    <Link to={crumb.path} className="text-blue-600 hover:text-blue-800 no-underline">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="text-gray-600">{crumb.label}</span>
                  )}
                </React.Fragment>
              ))}
            </nav>
          )}
        </div>
      </header>

      <main className="flex-1 bg-gray-50">
        {children}
      </main>

      <footer className="border-t bg-white">
        <div className="container mx-auto px-4 py-2 flex items-center justify-between">
          <p className="text-xs text-gray-600">Conversational Interoperability - Testing healthcare workflows through dialogue</p>
          <div className="flex gap-4 text-xs">
            <a 
              href="https://github.com/jmandel/conversational-interop" 
              className="text-blue-600 hover:text-blue-800 no-underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Reference Implementation
            </a>
            <span className="text-gray-400">•</span>
            <a 
              href="https://confluence.hl7.org/spaces/FHIR/pages/358260686/2025+-+09+Language+First+Interoperability" 
              className="text-blue-600 hover:text-blue-800 no-underline"
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