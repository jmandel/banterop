Shared frontend UI primitives for Language Track v3.

What’s here
- theme.css: CSS variables (colors, radii, shadows) used across apps.
- tailwind.preset.cjs: Tailwind preset exposing semantic tokens and defaults.

Usage
- Import theme variables in your app CSS:
  @import "../ui/theme.css";
  @tailwind base; @tailwind components; @tailwind utilities;
- Use a per-app Tailwind config with the shared preset:
  const preset = require('../ui/tailwind.preset.cjs');
  module.exports = { presets: [preset], content: ['./**/*.{html,ts,tsx}'] };
- Build CSS per app with tailwindcss CLI, pointing to your config.

Conventions
- Base font size 14px; headings via text-xl/2xl/3xl.
- Radii via rounded-2xl (maps to --radius).
- Shadows via shadow-sm and shadow-md.
- Spacing: gap-2/3/4, px-3 py-2.

Next steps
- Add @tailwindcss/typography plugin to preset when ready.
- Move common React components here (Button, PageHeader, Badge, Card).
- Extract shared networking utils and agent color helpers.

