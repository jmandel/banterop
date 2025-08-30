import React, { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { AppLayout as SharedAppLayout } from '../../ui';

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const { scenarioId } = useParams<{ scenarioId?: string }>();
  const pathSegments = location.pathname.split('/').filter(Boolean);
  // Derive scenarioId from the URL when AppLayout is not within a params scope
  const derivedScenarioId = (() => {
    if (scenarioId) return scenarioId;
    if (pathSegments[0] === 'scenarios') {
      const seg = pathSegments[1];
      if (!seg) return undefined;
      // Ignore top-level actions without an id
      if (['create', 'configured', 'created'].includes(seg)) return undefined;
      return decodeURIComponent(seg);
    }
    return undefined;
  })();
  const [scenarioTitle, setScenarioTitle] = useState<string | null>(null);

  // Try to resolve a friendly scenario title for breadcrumbs
  useEffect(() => {
    let cancelled = false;
    setScenarioTitle(null);
    const sid = derivedScenarioId;
    if (!sid) return;
    (async () => {
      try {
        const res = await fetch(`/api/scenarios/${encodeURIComponent(sid)}`);
        if (!res.ok) return;
        const s = await res.json();
        if (!cancelled) {
          const name: string | undefined = s?.name || s?.config?.metadata?.title;
          if (name) setScenarioTitle(name);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [derivedScenarioId]);
  
  const getBreadcrumbs = () => {
    const crumbs = [];
    
    if (pathSegments[0] === 'scenarios') {
      if (pathSegments.length === 1) {
        return null; // Don't show breadcrumbs on landing page
      }
      
      crumbs.push({ label: 'Scenarios', path: '/scenarios' });
      
      const sid = derivedScenarioId;
      if (sid) {
        // Show scenario id as the crumb label; pages further append their action
        const label = scenarioTitle || decodeURIComponent(sid);
        crumbs.push({ label, path: `/scenarios/${encodeURIComponent(sid)}` });
        
        if (pathSegments.includes('edit')) {
          crumbs.push({ label: 'Edit', path: null });
        } else if (pathSegments.includes('view')) {
          crumbs.push({ label: 'View', path: null });
        } else if (pathSegments.includes('run')) {
          crumbs.push({ label: 'Run', path: null });
        } else if (pathSegments.includes('external-mcp-client')) {
          crumbs.push({ label: 'Run', path: `/scenarios/${encodeURIComponent(sid)}/run` });
          crumbs.push({ label: 'External MCP Client', path: null });
        } else if (pathSegments.includes('external-a2a-client')) {
          crumbs.push({ label: 'Run', path: `/scenarios/${encodeURIComponent(sid)}/run` });
          crumbs.push({ label: 'External A2A Client', path: null });
        } else if (pathSegments.includes('configured')) {
          crumbs.push({ label: 'Configured', path: null });
        } else if (pathSegments.includes('created')) {
          crumbs.push({ label: 'Created', path: null });
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
    <SharedAppLayout 
      title="Banterop"
      breadcrumbs={
        breadcrumbs && breadcrumbs.length > 0 ? (
          <>
            {breadcrumbs.map((crumb, index) => (
              <React.Fragment key={index}>
                {index > 0 && <span className="text-gray-400">/</span>}
                {crumb.path ? (
                  <Link to={crumb.path} className="text-primary hover:opacity-80 no-underline">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="text-gray-600">{crumb.label}</span>
                )}
              </React.Fragment>
            ))}
          </>
        ) : undefined
      }
    >
      {children}
    </SharedAppLayout>
  );
}
