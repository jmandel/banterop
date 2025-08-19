// Central API base resolution for the client app
// Priority:
// 1) window.__APP_CONFIG__.API_BASE if provided by HTML
// 2) __API_BASE__ define injected at build time (scripts/build-frontend.ts)
// 3) Fallback to current origin + '/api' (works in most deploys)

// This is defined by the bundler in production builds
declare const __API_BASE__: string | undefined;

function fromWindow(): string | undefined {
  try { return (typeof window !== 'undefined' ? (window as any).__APP_CONFIG__?.API_BASE : undefined); } catch { return undefined; }
}

function fromDefine(): string | undefined {
  try { return (typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : undefined); } catch { return undefined; }
}

function fromLocation(): string {
  try {
    if (typeof location !== 'undefined' && location.host) {
      return `${location.protocol}//${location.host}/api`;
    }
  } catch {}
  return 'http://localhost:3000/api';
}

export const API_BASE: string = fromWindow() || fromDefine() || fromLocation();
export const getApiBase = () => API_BASE;

