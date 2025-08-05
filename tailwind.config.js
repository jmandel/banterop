/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/frontend/scenario-builder/**/*.{ts,tsx,html}',
    './src/frontend/scenario-builder/*.{ts,tsx,html}',
    './src/**/*.{ts,tsx,html}'
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
