import React from 'react';
import logoImage from '../interlocked-speech-bubbles.png';

interface AppLayoutProps {
  title: string;
  children: React.ReactNode;
  logo?: React.ReactNode;
  breadcrumbs?: React.ReactNode;
  headerRight?: React.ReactNode;
  fullWidth?: boolean;
}

export function AppLayout({ 
  title,
  children, 
  logo,
  breadcrumbs,
  headerRight,
  fullWidth = false
}: AppLayoutProps) {
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b bg-white/90 backdrop-blur">
        <div className="container mx-auto px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3 text-gray-900">
            {logo || <img src={logoImage} alt="Logo" className="w-10 h-10 object-contain" />}
            <h1 className="text-xl font-semibold">{title}</h1>
          </div>
          
          {breadcrumbs && (
            <nav className="flex items-center gap-2 text-sm">
              {breadcrumbs}
            </nav>
          )}
          
          {headerRight && (
            <div className="flex items-center gap-4">
              {headerRight}
            </div>
          )}
        </div>
      </header>

      {/* Main Content - Full width or container based on prop */}
      <main className="flex-1 bg-gray-50 flex flex-col">
        {fullWidth ? (
          <div className="flex-1 min-h-0">
            {children}
          </div>
        ) : (
          <div className="container mx-auto px-4 py-4">
            {children}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t bg-white">
        <div className="container mx-auto px-4 py-2 flex items-center justify-between">
          <p className="text-xs text-gray-600">
            Conversational Interoperability - Testing healthcare workflows through dialogue
          </p>
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

