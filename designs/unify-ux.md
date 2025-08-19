love that—they work, but the vibes clash. here’s a pragmatic, low-risk path to make **Scenarios, Watch, and A2A Client** feel like one product, using Scenarios as the north star.

# 1) Establish a shared design system (lightweight first)

**Goal:** one source of truth for colors, spacing, typography, radii, shadows.

* **Create a small “ui-kit” package** in the repo: `src/frontend/ui/` (or a separate `packages/ui`).
  Contents:

  * `theme.css` with CSS variables (semantic tokens):

    ```css
    :root {
      --bg: #f8fafc;            /* surface background */
      --panel: #ffffff;         /* panels/cards */
      --text: #0f172a;          /* primary text */
      --muted: #64748b;         /* secondary text */
      --border: #e2e8f0;

      --primary: #2563eb;
      --primary-foreground: #ffffff;

      --success: #059669;
      --warning: #d97706;
      --danger:  #e11d48;

      --radius: 12px;           /* rounded-2xl */
      --shadow-sm: 0 1px 2px rgba(0,0,0,.05);
      --shadow-md: 0 4px 12px rgba(0,0,0,.08);
    }
    .dark:root {
      --bg: #0b1220;
      --panel: #0f172a;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --border: #1e293b;

      --primary: #60a5fa;
      --primary-foreground: #0b1220;
    }
    ```
  * Tailwind **preset** (`tailwind.preset.cjs`) with your brand tokens (so all apps share the same Tailwind config via `presets: [require('../ui/tailwind.preset')]`).
  * Reusable **React components**: `Button`, `Card`, `PageHeader`, `Toolbar`, `Badge`, `Table`, `Modal`, `Toast`, `ShortcutHint`. Keep them tiny and presentational.
  * Reusable **patterns**: `SplitPane`, `SaveBar`, `KeyboardShortcutsModal`.

**Win:** all three apps can opt in gradually—no big bang.

---

# 2) Align Tailwind + typography

* Use the same **Tailwind preset** in all three apps. Unify:

  * **Font scale:** base 14px, headings with `text-xl / 2xl / 3xl`.
  * **Radii:** use `rounded-2xl` (maps to `--radius`).
  * **Shadows:** `shadow-sm` and a custom `shadow-md` from the preset.
  * **Spacing:** prefer `gap-2/3/4`, `p-2/3`, `px-3 py-2`.
* Add `@tailwindcss/typography` and standardize Markdown rendering (`prose-sm max-w-none`).

---

# 3) Unify layout and header

* Lift **Scenario’s `AppLayout`** to the shared UI and reuse it:

  * Product header (logo + breadcrumbs), sticky, translucent panel, same height.
  * Footer with the same links and small print.
* **Watch**: wrap its split view inside `AppLayout`. Replace its ad-hoc header with `PageHeader` (title + status badges on the right).
* **A2A Client**: same `AppLayout`. Left info column + right content follows the same grid as Scenario edit.

---

# 4) Standardize primitives & patterns already present

* Buttons: one `Button` with `variant="primary|secondary|danger|ghost"` and shared sizing.
* Cards/Panels: `Card`, `CardHeader`, `CardBody` for all info boxes.
* Tables: one `Table` style (header background, row hover, compact density).
* Badges: `Badge` for statuses (success/warning/danger/neutral).
* Modals/Toasts: shared look and spacing.
* **Keyboard shortcuts modal**: Watch already has a nice one—make it a `KeyboardShortcutsModal` component and use in all apps (Scenarios already uses hints in help copy; bring the modal there too).

---

# 5) Normalize status & iconography

* Adopt a shared **status language** + colors:

  * live/open → success
  * connecting/reconnecting → warning
  * completed → success, canceled → warning, errored → danger
* Use a single **icon set** (e.g., lucide-react) and stick to line icons at 16–18px.

---

# 6) Consistent network utilities

* Extract one **`wsRpcCall`** + **`API_BASE`** util (already similar across apps).
  Put in `src/frontend/ui/net.ts`:

  * `getApiBase()`
  * `wsRpcCall<T>(method, params)`
  * `http<T>(path, init)`
* Have a single **health ping hook** `useHealthPing()` and one **connection badge** `ConnBadge` used in all apps.

---

# 7) Shared color logic for agents

* You already have a good **colorForAgent** palette in Watch. Move it to `ui/agent-colors.ts` and use it in:

  * Watch (turn blocks)
  * A2A Client (thread and agent chips)
  * Scenarios (agent list badges)

---

# 8) Typography + content alignment

* Markdown rendering (messages, tool results): use the same `prose-sm` with whitespace handling.
* Code blocks: same font, same rounded corners, same subtle border.

---

# 9) Dark mode (now or later)

* With the CSS variables above, adding `.dark` on `<html>` flips the theme.
  Use a **single toggle** component in `AppLayout` (stores preference in `localStorage`).

---

# 10) Migration plan (incremental, safest order)

1. **Create `ui` package** (tokens, Tailwind preset, Button/Card/Badge/PageHeader).
2. **Adopt the preset** in Scenarios (already closest) → small refactor only.
3. **Wrap Watch** in `AppLayout`; replace header, swap buttons for shared `Button`, swap local badges for `Badge`, adopt `Card` for the sticky info bar and trace blocks.
4. **Apply shared net utils** across all three (remove per-app duplicates).
5. **Unify tables** in Watch & A2A Client (same density/hover/striping).
6. **Move agent color logic** to shared and adopt in all three.
7. Add **KeyboardShortcutsModal** to Scenarios and A2A Client for parity.
8. Optional: enable **dark mode** with the same toggle.

---

# 11) Code shape examples (super minimal)

**Tailwind preset (shared):**

```js
// packages/ui/tailwind.preset.cjs
module.exports = {
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        panel: 'var(--panel)',
        text: 'var(--text)',
        muted: 'var(--muted)',
        border: 'var(--border)',
        primary: 'var(--primary)',
      },
      borderRadius: { xl: 'var(--radius)' },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
```

**Button:**

```tsx
export function Button({ variant='primary', className='', ...props }) {
  const base = 'inline-flex items-center gap-2 px-3 py-2 rounded-2xl text-sm disabled:opacity-50';
  const look = {
    primary: 'bg-primary text-[color:var(--primary-foreground)] hover:opacity-90',
    secondary: 'border border-[color:var(--border)] bg-panel hover:bg-gray-50',
    danger: 'bg-[color:var(--danger)] text-white hover:opacity-90',
    ghost: 'text-[color:var(--muted)] hover:bg-gray-50',
  }[variant];
  return <button className={`${base} ${look} ${className}`} {...props} />;
}
```

**PageHeader:**

```tsx
export function PageHeader({ title, right }: {title: string; right?: React.ReactNode}) {
  return (
    <header className="sticky top-0 z-30 border-b bg-white/90 backdrop-blur">
      <div className="container mx-auto px-4 py-2 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{title}</h1>
        <div className="flex items-center gap-2">{right}</div>
      </div>
    </header>
  );
}
```

---

# 12) Consistency checklist (use for PR reviews)

* [ ] Uses shared `AppLayout` (header/footer) and `PageHeader`
* [ ] Buttons/Badges/Cards come from `ui`
* [ ] Colors via CSS variables, not hardcoded Tailwind brand classes
* [ ] Tables use shared table styles
* [ ] Same Markdown “prose” style
* [ ] Same agent color mapping
* [ ] Same connection/health components
* [ ] Keyboard shortcuts modal available and discoverable (`?`)
* [ ] Optional: dark mode respected

---

if you want, I can draft the shared `ui` skeleton (tokens, preset, 3–4 primitives) and show a small diff for wrapping **Watch** with `AppLayout` plus replacing its header/status bits—usually the highest impact for the least churn.

