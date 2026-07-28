# skills

Hybrid repo for **Claude/Cursor agent skills** and related **npm packages**.

```text
skills/                  # Agent skills (SKILL.md + scripts) — not npm workspace members
  spec-design-md/        # Brief → DESIGN.md
  shadcn-design-md/      # Codebase → DESIGN.md
  figma-component-registry/
  figma-implement-component/
  figma-implement-screen/
packages/                # Publishable Node packages (own lockfile + CI each)
  figma-fidelity/        # MCP visual fidelity: Figma gold ↔ live capture
```

This is a **hybrid content monorepo** (model A): skills stay file-based; packages are independent npm projects under `packages/*`. There is **no** root `pnpm-workspace.yaml` / root `package.json` yet. When a second publishable package lands, graduate to a real pnpm workspace (model B).

---

## Packages

| Package | Role | Install |
| --- | --- | --- |
| [`figma-fidelity`](packages/figma-fidelity) | MCP + CLI: fetch Figma gold, capture app, multi-signal compare, artifact done-gate | `pnpm add figma-fidelity` (after publish) |

Develop / test locally:

```bash
cd packages/figma-fidelity
pnpm install
pnpm test
pnpm exec tsc --noEmit
```

CI: [`.github/workflows/figma-fidelity.yml`](.github/workflows/figma-fidelity.yml) (path-filtered). Capture thresholds are **PROVISIONAL** — see [`packages/figma-fidelity/docs/CAPTURE.md`](packages/figma-fidelity/docs/CAPTURE.md) when that package is on the branch.

---

## Figma implement skills

Agent playbooks for Figma → code with evidence gates (pair with `figma-fidelity` for visual proof):

| Skill | Role |
| --- | --- |
| `figma-component-registry` | Figma props ↔ code API bindings + drift checks |
| `figma-implement-component` | DS primitive implement + harness + coverage / fidelity gate |
| `figma-implement-screen` | Screen/page implement + inventory + visual contracts |

Merge order when landing from PRs: registry → implement-component → implement-screen. `figma-fidelity` can land in parallel.

---

## DESIGN.md skills

A pair of Claude skills for working with [DESIGN.md](https://github.com/google-labs-code/design.md) — Google Labs' open-source format for describing design systems to AI coding agents.

```md
skills/
├── spec-design-md/   # Brief → DESIGN.md (greenfield)
└── shadcn-design-md/ # Codebase → DESIGN.md (reverse-engineer)
```

### Why these skills exist

AI coding agents generate generic UIs by default. Drop a `DESIGN.md` in your repo and they stop guessing — they apply your exact colors, fonts, spacing, and component rules on every generation.

|                    | `spec-design-md`                     | `shadcn-design-md`                                     |
| ------------------ | ------------------------------------ | ------------------------------------------------------ |
| **Starting point** | A design brief or brand description  | An existing shadcn/Tailwind codebase                   |
| **You provide**    | Product name, mood, primary color    | `globals.css`, `tailwind.config`, component files      |
| **Output format**  | YAML frontmatter + 8 prose sections  | 8 prose sections, `var(--token)` + Tailwind class refs |
| **Spec**           | Google Labs DESIGN.md (lint-passing) | shadcn/Tailwind conventions                            |
| **Use when**       | Starting a new project               | Documenting an existing one                            |

### spec-design-md

**Greenfield.** Give it a brand name, a mood, and a primary color — it produces a complete `DESIGN.md` from scratch.

The output follows the [official Google Labs spec](https://github.com/google-labs-code/design.md) and passes the CLI linter:

```bash
npx @google/design.md lint DESIGN.md   # 0 errors
npx @google/design.md export --format css-tailwind DESIGN.md > theme.css
```

**Trigger phrases:**

- _"Create a DESIGN.md for my SaaS app, primary color #4f46e5, minimal and professional"_
- _"Generate design tokens for a warm editorial brand called Hearth"_
- _"I want a DESIGN.md I can drop in my repo for Claude Code"_

**Minimum input needed:**

```md
Product name: FinTrack
Mood: professional, not cold
Primary color: #0F3460
```

Everything else — font, radius, neutral palette, component variants — is inferred from the mood and derived from the primary color.

**Output structure:**

```yaml
---
name: fintrack
version: alpha
colors:
  primary: "#0F3460"
  background: "#F8F9FB"
  # ... all semantic tokens
typography:
  h1: { fontFamily: Inter, fontSize: 1.5rem, fontWeight: 600 }
  # ... free-form token names, px/em/rem all valid
rounded:
  sm: 4px
  md: 8px
  # ...
components:
  button-primary:
    backgroundColor: "{colors.primary}" # token refs only, never raw hex
    textColor: "{colors.on-primary}"
    # hover, disabled as separate entries
---
## Overview
## Colors
## Typography
## Layout
## Elevation & Depth
## Shapes
## Components
## Do's and Don'ts
```

### shadcn-design-md

**Reverse-engineer.** Points at an existing shadcn/Tailwind project and extracts its visual language into a `DESIGN.md` that any agent can use to build new pages that look indistinguishable from the existing app.

All values come from the actual codebase — nothing is invented.

**Reading order:**

1. `app/globals.css` — CSS custom properties (`--primary`, `--radius`, `--font-sans`…)
2. `tailwind.config.ts` — theme extensions and overrides
3. `components/ui/button.tsx`, `card.tsx`, `input.tsx`, `badge.tsx` — real padding, radius, variants
4. A representative page component — spatial rhythm and composition patterns

**Trigger phrases:**

- _"Write a DESIGN.md for this project"_
- _"Document the design system"_
- _"I want to capture the visual language so Claude Code can match it"_
- _"Generate a new settings page that matches our existing UI"_

**Output style** — prose sections referencing real tokens:

```markdown
## Colors

`var(--background)` is a near-white off-canvas (#FAFAFA) — the consistent
page foundation. `var(--card)` lifts surfaces one step above it through
tonal contrast alone; no shadow is used at this elevation level...

## Components

**Button — primary:** `bg-primary text-primary-foreground`, `rounded-md`,
`h-9 px-4`, `text-sm font-medium`. Hover: `bg-primary/90`. Disabled:
`opacity-50 pointer-events-none`. No border.
```

No YAML frontmatter. No invented hex values. References stay as `var(--token)` and Tailwind classes so the file stays in sync with `globals.css` without a separate export step.

### Choosing the right DESIGN.md skill

```md
New project, no code yet?
→ spec-design-md

Existing shadcn/Tailwind project, want to document it?
→ shadcn-design-md

Want to feed design context to Claude Code / Cursor?
→ Either, depending on above — both produce agent-ready DESIGN.md files
```

### Spec compliance

`spec-design-md` targets the Google Labs open-source spec directly:

- `primary` color token present (avoids lint warning)
- `fontSize` accepts `px`, `em`, or `rem`
- Typography token names are free-form (`h1`, `body-md`, `caption` — not forced taxonomy)
- Components use `{token.ref}` syntax exclusively — no raw hex
- Variant states (hover, active, disabled) expressed as separate component entries
- All 8 sections present in canonical order

`shadcn-design-md` follows shadcn/Tailwind conventions rather than the Google Labs YAML schema, as the codebase already defines tokens in `globals.css` — a second token layer would drift.

---

## Related

- [google-labs-code/design.md](https://github.com/google-labs-code/design.md) — official spec and CLI
- [shadcn/ui skills](https://ui.shadcn.com/docs/skills) — shadcn's own Claude Code skill for component generation
- [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) — community DESIGN.md examples
- [`figma-fidelity`](packages/figma-fidelity) — Figma ↔ code visual fidelity MCP (when present on branch)
