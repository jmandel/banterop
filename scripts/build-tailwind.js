import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

// Create a require function to load the Tailwind CDN script
const require = createRequire(import.meta.url);

// Read the Tailwind CDN script and extract the core functionality
async function buildTailwindBundle() {
  try {
    // For v3, we can build a standalone version using the Play CDN approach
    const tailwindScript = `
(() => {
  // Minimal Tailwind v3 configuration for bundling
  const tailwindConfig = {
    content: ['./src/frontend/external-executor/**/*.{js,jsx,ts,tsx,html}'],
    theme: {
      extend: {},
    },
    plugins: [],
  };

  // This creates a script that mimics the Tailwind Play CDN
  const script = document.createElement('script');
  script.src = 'https://cdn.tailwindcss.com';
  script.onload = () => {
    console.log('Tailwind CSS loaded');
  };
  
  // For bundling, we'll export the config
  window.tailwindConfig = tailwindConfig;
})();
`;
    
    // Instead, let's use a different approach - generate all possible classes
    const tailwindSource = readFileSync('./node_modules/tailwindcss/lib/css/preflight.css', 'utf8');
    
    // For now, let's just copy the CDN content approach
    const cdnContent = `/* Tailwind CSS Bundle for Bun */
/* This file is auto-generated - do not edit */

/* Preflight */
${tailwindSource}

/* Utilities - extracted from CDN */
.bg-gray-100 { background-color: rgb(243 244 246); }
.text-white { color: rgb(255 255 255); }
.text-gray-600 { color: rgb(75 85 99); }
.text-gray-900 { color: rgb(17 24 39); }
.text-gray-800 { color: rgb(31 41 55); }
.text-gray-700 { color: rgb(55 65 81); }
.text-gray-500 { color: rgb(107 114 128); }
.text-sm { font-size: 0.875rem; line-height: 1.25rem; }
.text-xs { font-size: 0.75rem; line-height: 1rem; }
.text-lg { font-size: 1.125rem; line-height: 1.75rem; }
.text-2xl { font-size: 1.5rem; line-height: 2rem; }
.font-bold { font-weight: 700; }
.font-semibold { font-weight: 600; }
.font-medium { font-weight: 500; }
.p-6 { padding: 1.5rem; }
.px-6 { padding-left: 1.5rem; padding-right: 1.5rem; }
.py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
.px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
.py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
.px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
.px-4 { padding-left: 1rem; padding-right: 1rem; }
.p-3 { padding: 0.75rem; }
.p-4 { padding: 1rem; }
.p-2 { padding: 0.5rem; }
.mt-2 { margin-top: 0.5rem; }
.mb-4 { margin-bottom: 1rem; }
.mb-2 { margin-bottom: 0.5rem; }
.mb-3 { margin-bottom: 0.75rem; }
.ml-2 { margin-left: 0.5rem; }
.ml-4 { margin-left: 1rem; }
.mt-1 { margin-top: 0.25rem; }
.min-h-screen { min-height: 100vh; }
.max-w-4xl { max-width: 56rem; }
.mx-auto { margin-left: auto; margin-right: auto; }
.bg-white { background-color: rgb(255 255 255); }
.bg-gray-50 { background-color: rgb(249 250 251); }
.bg-yellow-50 { background-color: rgb(254 252 232); }
.bg-blue-600 { background-color: rgb(37 99 235); }
.bg-red-600 { background-color: rgb(220 38 38); }
.bg-purple-50 { background-color: rgb(250 245 255); }
.bg-blue-50 { background-color: rgb(239 246 255); }
.bg-blue-100 { background-color: rgb(219 234 254); }
.bg-green-500 { background-color: rgb(34 197 94); }
.bg-gray-300 { background-color: rgb(209 213 219); }
.bg-gray-100 { background-color: rgb(243 244 246); }
.bg-gray-200 { background-color: rgb(229 231 235); }
.bg-green-50 { background-color: rgb(240 253 244); }
.bg-red-50 { background-color: rgb(254 242 242); }
.border { border-width: 1px; }
.border-b { border-bottom-width: 1px; }
.border-gray-200 { border-color: rgb(229 231 235); }
.border-gray-300 { border-color: rgb(209 213 219); }
.border-yellow-200 { border-color: rgb(254 240 138); }
.border-purple-200 { border-color: rgb(233 213 255); }
.border-purple-300 { border-color: rgb(216 180 254); }
.border-blue-200 { border-color: rgb(191 219 254); }
.border-green-200 { border-color: rgb(187 247 208); }
.border-red-200 { border-color: rgb(254 202 202); }
.rounded-lg { border-radius: 0.5rem; }
.rounded-md { border-radius: 0.375rem; }
.rounded { border-radius: 0.25rem; }
.rounded-full { border-radius: 9999px; }
.shadow-lg { box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1); }
.shadow-sm { box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05); }
.flex { display: flex; }
.inline-flex { display: inline-flex; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.gap-4 { gap: 1rem; }
.gap-2 { gap: 0.5rem; }
.gap-3 { gap: 0.75rem; }
.gap-1 { gap: 0.25rem; }
.space-y-1 > :not([hidden]) ~ :not([hidden]) { margin-top: 0.25rem; }
.space-y-2 > :not([hidden]) ~ :not([hidden]) { margin-top: 0.5rem; }
.space-y-4 > :not([hidden]) ~ :not([hidden]) { margin-top: 1rem; }
.flex-wrap { flex-wrap: wrap; }
.flex-1 { flex: 1 1 0%; }
.w-3 { width: 0.75rem; }
.h-3 { height: 0.75rem; }
.w-2 { width: 0.5rem; }
.h-2 { height: 0.5rem; }
.w-32 { width: 8rem; }
.w-full { width: 100%; }
.min-w-\\[60px\\] { min-width: 60px; }
.max-h-96 { max-height: 24rem; }
.overflow-y-auto { overflow-y: auto; }
.hover\\:bg-blue-700:hover { background-color: rgb(29 78 216); }
.hover\\:bg-red-700:hover { background-color: rgb(185 28 28); }
.hover\\:bg-gray-300:hover { background-color: rgb(209 213 219); }
.hover\\:bg-gray-200:hover { background-color: rgb(229 231 235); }
.hover\\:bg-blue-200:hover { background-color: rgb(191 219 254); }
.disabled\\:opacity-50:disabled { opacity: 0.5; }
.disabled\\:cursor-not-allowed:disabled { cursor: not-allowed; }
.animate-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
.cursor-pointer { cursor: pointer; }
.select { /* select styles */ }
.appearance-none { appearance: none; }
.focus\\:outline-none:focus { outline: 2px solid transparent; outline-offset: 2px; }
.focus\\:ring-2:focus { box-shadow: 0 0 0 2px; }
.focus\\:ring-blue-500:focus { box-shadow: 0 0 0 2px rgb(59 130 246); }
.italic { font-style: italic; }
.text-yellow-800 { color: rgb(133 77 14); }
.text-yellow-700 { color: rgb(161 98 7); }
.text-blue-900 { color: rgb(30 58 138); }
.text-blue-800 { color: rgb(30 64 175); }
.text-blue-700 { color: rgb(29 78 216); }
.text-blue-600 { color: rgb(37 99 235); }
.text-purple-900 { color: rgb(88 28 135); }
.text-purple-600 { color: rgb(147 51 234); }
.text-green-600 { color: rgb(22 163 74); }
.text-red-600 { color: rgb(220 38 38); }
.transition-colors { transition-property: color, background-color, border-color, text-decoration-color, fill, stroke; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms; }
.transition-all { transition-property: all; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms; }
.text-center { text-align: center; }
.opacity-75 { opacity: 0.75; }

/* Slider styles */
.slider::-webkit-slider-thumb {
  appearance: none;
  height: 16px;
  width: 16px;
  border-radius: 50%;
  background: #3b82f6;
  cursor: pointer;
  border: 2px solid #ffffff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.slider::-moz-range-thumb {
  height: 16px;
  width: 16px;
  border-radius: 50%;
  background: #3b82f6;
  cursor: pointer;
  border: 2px solid #ffffff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.slider:hover::-webkit-slider-thumb {
  background: #2563eb;
  transform: scale(1.1);
  transition: all 0.2s ease;
}

.slider:hover::-moz-range-thumb {
  background: #2563eb;
  transform: scale(1.1);
  transition: all 0.2s ease;
}

@keyframes pulse {
  50% { opacity: .5; }
}
`;
    
    writeFileSync('./src/frontend/external-executor/tailwind-bundle.css', cdnContent);
    console.log('Tailwind bundle created successfully!');
    
  } catch (error) {
    console.error('Error building Tailwind bundle:', error);
  }
}

buildTailwindBundle();