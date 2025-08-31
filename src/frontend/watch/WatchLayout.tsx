import React from 'react';
import logoImage from '../ui/interlocked-speech-bubbles.png';

interface WatchLayoutProps {
  children: React.ReactNode;
  statusIndicator?: React.ReactNode;
}

export function WatchLayout({ children, statusIndicator }: WatchLayoutProps) {
  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header with Migration Banner */}
      <header className="sticky top-0 z-30 border-b bg-amber-50/95 backdrop-blur">
        <div className="bg-amber-100 border-b-2 border-amber-300">
          <div className="px-4 py-3">
            <p className="text-lg font-bold text-amber-900 text-center">
              <span className="text-xl">📢 TIME TO SWITCH!</span> chitchat.fhir.me is retiring September 5th.
            </p>
            <p className="text-base font-semibold text-amber-900 text-center mt-1">
              Your new home is ready at{' '}
              <a 
                href="https://banterop.fhir.me" 
                className="text-amber-700 underline hover:text-amber-800 font-bold text-lg"
                target="_blank"
                rel="noopener noreferrer"
              >
                banterop.fhir.me
              </a>
            </p>
          </div>
        </div>
        <div className="px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3 text-gray-900">
            <img src={logoImage} alt="Logo" className="w-10 h-10 object-contain" />
            <h1 className="text-xl font-semibold">Watch</h1>
          </div>
          
          {statusIndicator && (
            <div className="flex items-center gap-4">
              {statusIndicator}
            </div>
          )}
        </div>
      </header>

      {/* Main Content - Full height with no padding */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {children}
      </main>

      {/* Footer */}
      <footer className="border-t bg-white">
        <div className="px-4 py-2 flex items-center justify-between">
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