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
  const [menuOpen, setMenuOpen] = React.useState(false);
  const toggleMenu = () => setMenuOpen(v => !v);
  const closeMenu = () => setMenuOpen(false);
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* Header with Migration Banner */}
      <header className="sticky top-0 z-30 border-b bg-amber-50/95 backdrop-blur">
        <div className="bg-amber-100 border-b-2 border-amber-300">
          <div className="container mx-auto px-4 py-3">
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
        <div className="container mx-auto px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3 text-gray-900">
            {logo || <img src={logoImage} alt="Logo" className="w-10 h-10 object-contain" />}
            <h1 className="text-xl font-semibold">{title}</h1>
          </div>
          
          {breadcrumbs && (
            <nav className="hidden md:flex items-center gap-2 text-sm">
              {breadcrumbs}
            </nav>
          )}
          
          <div className="flex items-center gap-2">
            {headerRight && (
              <div className="hidden sm:flex items-center gap-4">
                {headerRight}
              </div>
            )}
            {/* Hamburger menu (mobile + desktop) */}
            <div className="relative">
              <button
                aria-label="Open menu"
                className="inline-flex items-center justify-center w-10 h-10 rounded-full border border-gray-200 bg-white text-gray-700 hover:bg-gray-100"
                onClick={toggleMenu}
              >
                <span className="text-xl leading-none">☰</span>
              </button>
              {menuOpen && (
                <div className="absolute right-0 mt-2 w-48 rounded-lg border border-gray-200 bg-white shadow-lg z-40">
                  <a href="/" onClick={closeMenu} className="block px-3 py-2 text-sm text-gray-800 hover:bg-gray-50">Scenarios</a>
                  <a href="/watch/" onClick={closeMenu} className="block px-3 py-2 text-sm text-gray-800 hover:bg-gray-50">Watch</a>
                  <a href="/client/" onClick={closeMenu} className="block px-3 py-2 text-sm text-gray-800 hover:bg-gray-50">Client</a>
                </div>
              )}
            </div>
          </div>
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
