import React from 'react';
import logoImage from '../logo.png';

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
  const year = new Date().getFullYear();
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
        <div className="container mx-auto px-3 h-12 flex items-center justify-between">
          <div className="flex items-center gap-3 text-gray-900 min-w-0">
            <a href="/" className="flex items-center gap-3 text-gray-900 hover:opacity-80 no-underline" aria-label="Go to home">
              {logo || <img src={logoImage} alt="Banterop logo" className="w-10 h-10 -m-1 object-contain block" />}
              <h1 className="text-2xl font-bold tracking-tight whitespace-nowrap">{title}</h1>
            </a>
            {breadcrumbs && (
              <nav className="ml-3 flex items-center gap-2 text-sm text-muted truncate min-w-0">
                {breadcrumbs}
              </nav>
            )}
          </div>

          <div className="flex items-center gap-2">
            {headerRight && (
              <div className="flex items-center gap-4 shrink-0">
                {headerRight}
              </div>
            )}
            {/* Hamburger menu (mobile + desktop) */}
            <div className="relative">
              <button
                aria-label="Open menu"
                className="inline-flex items-center justify-center w-9 h-9 rounded-full border border-gray-200 bg-white text-gray-700 hover:bg-gray-100"
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
        <div className="container mx-auto px-4 py-2 flex items-center justify-between overflow-x-hidden">
          <p className="text-xs text-gray-600">Banterop © {year}</p>
          <div className="flex gap-x-4 gap-y-1 flex-wrap text-xs">
            <a 
              href="https://github.com/jmandel/banterop"
              className="text-primary hover:opacity-80 no-underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              github.com/jmandel/banterop
            </a>
            <span className="text-gray-400">•</span>
            <a
              href="https://github.com/jmandel/banterop/issues/new"
              className="text-primary hover:opacity-80 no-underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Report an issue
            </a>
            <span className="text-gray-400">•</span>
            <a
              href="https://chat.fhir.org/#narrow/channel/323443-Artificial-Intelligence.2FMachine-Learning-.28AI.2FML.29"
              className="text-primary hover:opacity-80 no-underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Zulip chat
            </a>
            <span className="text-gray-400">•</span>
            <a
              href="https://confluence.hl7.org/spaces/FHIR/pages/358260686/2025+-+09+Language+First+Interoperability"
              className="text-primary hover:opacity-80 no-underline"
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
