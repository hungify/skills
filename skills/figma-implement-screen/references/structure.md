# Screen implementation structure

**Read before placing feature-screen files.** Placement: [`.agents/architecture.md`](../../../architecture.md).

Goal: **clean, maintainable code that matches this repo** — not a single mandatory template.

## 1. Follow existing code first

Before inventing structure, APIs, or folder names:

1. Read `.figma/screen.config.json`; use `screensGlob`, `pathAliases`, and framework adapter. Missing config uses React defaults.
2. Find a sibling matching configured `screensGlob` (same feature preferred; else nearest).
3. Mirror naming, configured imports, tokens, layout ownership, and how that screen splits UI vs logic.
4. Prefer copy-adapt over greenfield.
5. Fall back to architecture.md + practices below only when no sibling exists.

## 2. Clean-code practices (apply as needed)

These are **habits**, not a checklist that every screen must expand into the same files.

| Practice                                                                          | Why                                                               |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Thin route + thin screen shell                                                    | Route wires params/context; screen composes; no fat JSX in routes |
| Separate UI blocks from orchestration                                             | Easier review, test, and reuse                                    |
| Keep side effects / submit / local interactive state out of presentational markup | Form stays props-in; logic stays testable                         |
| Chrome once in layout routes                                                      | Don’t re-import Header/Footer per screen                          |
| Promote only when a 2nd consumer appears                                          | No speculative shared folders                                     |
| Audit shared owners before editing                                                | Layout-route changes affect every child route                     |
| No `index.ts` barrels under screens                                               | Direct imports (bundle / clarity)                                 |

### One common React pattern: form + hook (example, not universal)

When a screen has a real form / interactive block + state/mutation, **one** clean approach (see login):

```txt
features/auth/screens/login/
  login-screen.tsx           # shell: title + compose
  testids.ts
  components/login-form.tsx  # presentational fields/CTA
  hooks/use-login-form.ts    # state, submit, mutation wiring
```

Other React screens may use `sections/`, a single small component, or a different sibling precedent. Future adapters may use different filenames and composition conventions. **Match current framework and codebase precedent.**

| Concern (when you split)        | Typical path                              |
| ------------------------------- | ----------------------------------------- |
| Screen shell                    | `…/<screen>-screen.tsx`                   |
| UI block                        | `…/components/<name>.tsx`                 |
| Local state / handlers / mutate | `…/hooks/use-<name>.ts`                   |
| Testids                         | `…/testids.ts`                            |
| Shared Header/Footer            | pathless layout (e.g. `_guest/route.tsx`) |

## 3. When to split further

| Signal                          | Action                                             |
| ------------------------------- | -------------------------------------------------- |
| Hard to review in one pass      | extract `components/` or optional `sections/`      |
| Same block needed by 2nd screen | promote to `features/<feature>/components\|hooks/` |
| Same across features            | `src/components/` / `src/hooks/` / `src/lib/`      |

## 4. Gate file coverage

List the UI files the gate must scan in `screen-implementation.json` `implementationFiles[]`. The gate fails missing paths or resolved components absent from the scanned files. This is not a whole-task change ledger; the developer reviews the real Git diff for every changed file.

Skill executables are `.mjs` and run with `node`. React adapter scans target `.tsx` and `.jsx` source. A configured framework without an installed adapter fails before source scanning.

## 5. Preserve behavior and shared consumers

Before replacing existing route UI, record working capabilities: submit paths, native/client validation, pending/error handling, auth providers, redirects, links, keyboard behavior, and accessible names. Preserve them unless the user explicitly approves a product change. A capability missing from Figma is still product behavior, not disposable markup.

Before editing a pathless layout route or shared component, find every child route/consumer. Prefer screen-owned layout changes for one-screen parity. When a shared edit is necessary, run targeted checks for affected siblings and list them in the handoff.

## Anti-patterns

- Invent structure when a sibling already shows how this repo does it
- Monolith: huge form + mutation + toggles all inside `<screen>-screen.tsx` with no reason
- Re-import Header/Footer when the layout route already owns chrome
- Speculative shared folders / screen-level barrels
- Delete working route behavior because it is absent from the selected Figma frame
- Change a shared layout for one screen without checking sibling routes
