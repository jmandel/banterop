# Published Scenarios — Lightweight Curation & Soft-Lock

## 1. Goals

* **Curation by default:** landing page shows only curated items (tagged `published`) by default, with a toggle to view “All”.
* **Accidental-edit protection:** scenarios tagged `published` open in **read-only** mode by default. Users must explicitly **Unlock to edit**.
* **Lightweight friction, not heavy auth:** optional server-side soft lock using a single shared token. If unset, UI-only protection still applies.
* **Backwards compatible:** no schema migration needed. Just reuses `config.metadata.tags`.

---

## 2. UX Overview

* **Landing page**

  * Toggle: **Show: Published | All** (default = Published).
  * Cards for published scenarios show a lock badge/icon.

* **Scenario editor**

  * If a scenario has the `published` tag:

    * Displays a yellow banner: “This scenario is Published and protected against accidental edits.”
    * Structured/JSON views are read-only.
    * Unlock button:

      * Prompts for a token (if backend token is set) or a simple confirm gesture otherwise.
      * Stores unlock state in `localStorage`.
      * Stores token in `localStorage` so PUT/DELETE calls attach `X-Edit-Token`.
      * After unlocking, editing is enabled for that scenario.

* **Backend enforcement (optional)**

  * If `PUBLISHED_EDIT_TOKEN` env var is set:

    * PUT/DELETE for published scenarios require `X-Edit-Token` header matching the token.
    * Otherwise return **423 Locked**.
  * If env var is not set, edits are allowed normally (client-side friction only).

---

## 3. Technical Approach

### 3.1 Data model

* Use `config.metadata.tags: string[]`.
* `published` tag = curated & soft-locked.

### 3.2 Local state (frontend)

* Unlock map: `localStorage['scenario.edit.unlock']` → `{ [scenarioId]: boolean }`.
* Token: `localStorage['scenario.edit.token']` (optional).
* Landing filter: `localStorage['scenario.showMode']` ∈ {`published`, `all`}.

### 3.3 API behavior

* Existing endpoints: `GET/POST/PUT/DELETE /api/scenarios/:id`.
* Only PUT/DELETE guarded if `published` + env var is set.
* Header: `X-Edit-Token: <string>`.

### 3.4 Environment variable

* `PUBLISHED_EDIT_TOKEN` (string, optional).
* If set, server enforces token on PUT/DELETE for published scenarios.
* If unset, server ignores the header and all edits go through.

---

## 4. Implementation Details

### 4.1 New helper: locks

`src/frontend/scenarios/utils/locks.ts`

```ts
export const PUBLISHED_TAG = 'published';
const UNLOCK_KEY = 'scenario.edit.unlock';
const TOKEN_KEY = 'scenario.edit.token';

export function isPublished(cfg: any): boolean {
  const tags: string[] = cfg?.metadata?.tags || [];
  return tags.includes(PUBLISHED_TAG);
}

export function isUnlockedFor(id?: string): boolean {
  if (!id) return false;
  try {
    const m = JSON.parse(localStorage.getItem(UNLOCK_KEY) || '{}');
    return !!m[id];
  } catch { return false; }
}

export function setUnlocked(id?: string, v = true) {
  if (!id) return;
  try {
    const m = JSON.parse(localStorage.getItem(UNLOCK_KEY) || '{}');
    m[id] = !!v;
    localStorage.setItem(UNLOCK_KEY, JSON.stringify(m));
  } catch {}
}

export function getEditToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setEditToken(token: string) {
  try { localStorage.setItem(TOKEN_KEY, token || ''); } catch {}
}
```

### 4.2 API helper injects token

`src/frontend/scenarios/utils/api.ts`

```diff
-  const res = await fetch(url, init);
+  const token = (() => { try { return localStorage.getItem('scenario.edit.token') || ''; } catch { return ''; }})();
+  const headers = new Headers(init?.headers || {});
+  if (token) headers.set('X-Edit-Token', token);
+  const res = await fetch(url, { ...init, headers });
```

### 4.3 Landing page filter

`ScenarioLandingPage.tsx`

* State: `showMode` default `'published'`.
* Filter scenarios: if mode=`published`, only keep those tagged `published`.

UI:

```tsx
<button onClick={() => setShowMode('published')}>Published</button>
<button onClick={() => setShowMode('all')}>All</button>
```

Persist mode in `localStorage`.

### 4.4 Editor lock UI

`ScenarioEditor.tsx`

* If `isPublished(config)` and not `isUnlockedFor(id)`, then:

  * Show banner.
  * Structured/JSON editors receive `isReadOnly={true}`.
  * Unlock button → prompt for token, call `setEditToken()`, `setUnlocked()`, reload or re-render.

### 4.5 Builder page save suppression

`ScenarioBuilderPage.tsx`

* Compute `locked = isPublished(config) && !isUnlockedFor(config.metadata.id)`.
* Suppress Save bar if locked.

### 4.6 Backend guard

`scenarios.http.ts`

```ts
const checkGuard = (c: any, scenario: any) => {
  const tags: string[] = scenario?.config?.metadata?.tags || [];
  if (!tags.includes('published')) return { ok: true };
  if (!process.env.PUBLISHED_EDIT_TOKEN) return { ok: true };
  const hdr = c.req.header('X-Edit-Token') || '';
  if (hdr === process.env.PUBLISHED_EDIT_TOKEN) return { ok: true };
  return { ok: false, code: 423, msg: 'Locked published scenario. Invalid or missing token.' };
};
```

Apply in PUT/DELETE.

---

## 5. Testing Criteria

1. Landing defaults to showing only published scenarios.
2. Toggle to “All” shows everything.
3. Published scenarios open locked:

   * Banner shown.
   * Editor read-only.
   * Save bar hidden.
4. Unlock to edit works:

   * Locally re-enables editing.
   * If server token is set, PUT/DELETE succeeds only with correct token.
5. Wrong/no token → **423 Locked**.
6. Non-published scenarios remain fully editable.

