---
name: spec-design-md
description: Generate a complete DESIGN.md file that follows the official Google Labs DESIGN.md open-source specification (github.com/google-labs-code/design.md) — YAML frontmatter with typed design tokens (colors, typography, rounded, spacing, components) plus 8 structured prose sections (Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts). Use this skill whenever the user wants to create a design system from scratch, generate a DESIGN.md for a new product or brand, define visual tokens for a greenfield project, or produce a machine-readable + human-readable design spec that AI coding agents like Claude Code, Cursor, or Kiro can consume. Also trigger when the user describes a visual style (e.g. "clay-inspired", "dark minimal SaaS", "warm editorial") and wants it formalized into a DESIGN.md. Always use this skill when the user explicitly mentions DESIGN.md or design tokens for AI agents.
---

# spec-design-md

Generate a complete, spec-compliant `DESIGN.md` file from a design brief, visual reference, or brand description.

The output conforms to the official Google Labs DESIGN.md format (Apache 2.0, alpha):
`github.com/google-labs-code/design.md`

---

## What this skill produces

A single `DESIGN.md` with two parts:

1. **YAML frontmatter** — machine-readable design tokens between `---` delimiters
2. **Markdown body** — 8 `##` sections of evocative, specific prose

The tokens are the normative source of truth. The prose explains how and why to apply them.

The output must pass: `npx @google/design.md lint DESIGN.md`

---

## Step 1 — Gather intent

Before generating anything, check which of these are present in the user's brief:

**Required — must ask if missing:**

- **Product name** — what is this design system called?
- **Visual mood** — what does it feel like? (e.g. warm, clinical, playful, minimal, bold)
- **Primary color** — at least one anchor color or direction ("deep navy", "#4f46e5", "earthy greens")

**Infer if missing — do not ask:**

- **Font** — pick a fitting one based on mood (Inter for neutral/professional, Plus Jakarta Sans for friendly, DM Sans for minimal, etc.)
- **Radius** — infer from mood (playful → rounder, clinical/sharp → tighter)
- **Secondary colors** — derive a harmonious neutral stack from the primary

**Optional — ask only if the brief is genuinely ambiguous without it:**

- **Dark or light mode** — assume light unless stated
- **Brand accent colors** — ask only if mood implies multi-color (e.g. "vibrant", "colorful landing page")
- **Reference products** — helpful but not required

### Questioning rule

If 1 or more required fields are missing: ask for all missing required fields in a single message before proceeding.

If all required fields are present: proceed directly to Step 2 without asking anything.

Never ask about optional fields unless the brief is genuinely ambiguous — infer and note the assumption in the output instead.

### If the user provides specific hex colors

Map them to semantic roles using these rules — in order of priority:

1. **User-labeled colors** — if the user says "primary: #X" or "background: #Y", use exactly as stated.
2. **Infer from lightness** — very light colors → `background` or `surface`. Very dark → `foreground` or a dark surface. Mid-range saturated → `primary` or brand accent.
3. **Infer from saturation** — the most saturated color is almost always `primary`. Desaturated variants → hover/disabled states. Neutrals → background/surface/border stack.
4. **Brand colors beyond primary** — if 3+ saturated colors are provided, treat them as brand accent palette (e.g. `brand-coral`, `brand-teal`). Describe their cycling rule in the Colors section.
5. **Derive the rest** — tokens not covered by user input must be derived to harmonize. Never leave a token undefined.

Always convert any user-provided hex to the exact value in the YAML. Do not adjust colors the user explicitly chose.

---

## Step 2 — Generate the YAML frontmatter

Output valid YAML between `---` delimiters. Follow the official token schema exactly.

### Required top-level fields

```yaml
name: <system name, lowercase-kebab>          # required
version: alpha                                 # optional, but always include
description: <one sentence: palette + mood>   # optional, but always include
```

### colors

Define every color as a hex value in sRGB (`#RRGGBB`). Name tokens semantically, not by hue.

**The only token name required by the spec is `primary`** — the linter will warn if absent. All other names are free-form. Choose names that communicate purpose, not appearance.

Recommended set (adapt freely to the design):
`primary`, `background`, `foreground`, `surface`, `on-primary`, `muted`, `border`, `destructive`

Add brand accent colors if the design calls for them (e.g. `brand-pink`, `brand-teal`).
Add `surface-dark` and `on-dark` if the design uses dark panels.

Derive all hex values from the brief. Every color must be a real, deliberate decision.

### typography

**Token names are free-form.** Choose names that describe the typographic role, not a fixed taxonomy. Examples from the spec: `h1`, `body-md`, `label-caps`, `display-lg`, `caption`.

Each token is an object with these fields:

| Field           | Type                | Required    | Notes                            |
| --------------- | ------------------- | ----------- | -------------------------------- |
| `fontFamily`    | string              | yes         | Font name as-is                  |
| `fontSize`      | Dimension           | yes         | `px`, `em`, or `rem` — all valid |
| `fontWeight`    | number              | yes         | e.g. `400`, `600`                |
| `lineHeight`    | Dimension or number | recommended | e.g. `1.5`, `24px`               |
| `letterSpacing` | Dimension           | optional    | e.g. `-0.02em`, `0.05em`         |
| `fontFeature`   | string              | optional    | OpenType feature string          |
| `fontVariation` | string              | optional    | Variable font axis string        |

Define enough levels to cover the design's hierarchy. Typical sets include heading levels, body sizes, label/caption sizes, and display/hero type for marketing-heavy designs.

Display weights should not exceed 600 unless the brief explicitly calls for heavy type. Negative letter-spacing on display levels (`-0.02em` to `-0.05em`) is appropriate for modern sans display type.

### rounded

Define at least 5 levels. Names are free-form; conventional: `xs`, `sm`, `md`, `lg`, `xl`. Add `pill: 9999px` and `full: 9999px` if badges or avatars appear. Values in `px`.

### spacing

Define at minimum: `xs: 4px`, `sm: 8px`, `md: 16px`, `lg: 24px`, `xl: 32px`, `xxl: 48px`.

Spec allows `<Dimension>` (with unit) or bare `<number>` (unitless). Prefer explicit `px` for clarity.

### components

Define every component variant relevant to the design. Use **token references** exclusively — never raw hex or raw values.

Token reference syntax: `{colors.primary}`, `{typography.body-md}`, `{rounded.md}`

**Valid component properties** (per spec): `backgroundColor`, `textColor`, `typography`, `rounded`, `padding`, `size`, `height`, `width`

Express variants (hover, active, pressed, disabled, focused) as **separate component entries** with a related key suffix:

```yaml
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
    padding: 12px 24px
  button-primary-hover:
    backgroundColor: "{colors.primary-container}"
  button-primary-disabled:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.muted-foreground}"
```

Required components (adapt names to the design): `button-primary`, `button-primary-hover`, `button-primary-disabled`, `button-secondary`, `text-input`, `text-input-focused`, `card`, `badge`, `nav`

Add domain-specific components as needed: `feature-card`, `pricing-card`, `pricing-card-featured`, `testimonial-card`, `cta-band`, `tab`, `tab-active`, `footer`

---

## Step 3 — Generate the 8 prose sections

Sections appear after the closing `---` of the frontmatter, in this exact order. Use `##` headings. **Sections can be omitted but must appear in this canonical order if present:**

1. Overview
2. Colors
3. Typography
4. Layout
5. Elevation & Depth
6. Shapes
7. Components
8. Do's and Don'ts

### ## Overview

3–5 sentences. Describe the holistic feel: brand personality, target user, emotional register, aesthetic reference if identifiable. This is the agent's fallback when no specific token covers a decision. Avoid generic phrases like "clean and modern" — be specific about what makes this system distinctive.

### ## Colors

Describe the semantic role and emotional character of every color group. Structure: page foundation first (background, surface), then interactive (primary, accent), then semantic (muted, destructive, border), then brand accents if present.

For each color, explain what it communicates and when it must not be used. Reference token names as `{colors.token-name}`.

If brand accent colors cycle (e.g. feature cards), describe the cycling rule explicitly.

### ## Typography

Describe the font stack and the feel each level conveys. Include a markdown table:

| Token             | Size | Weight | Letter-spacing | Use |
| ----------------- | ---- | ------ | -------------- | --- |
| `{typography.h1}` | Xrem | X      | Xem            | …   |

Note the weight ceiling, any letter-spacing conventions, and whether the system uses a single typeface or a display/UI pair.

### ## Layout

Max content width, base spacing unit, section vertical rhythm, grid strategy (card grid / sidebar+main / full-bleed bands), responsive breakpoints and their behavior. Describe the spatial character — tight and dense or airy and editorial.

### ## Elevation & Depth

State clearly: does the system use shadows, tonal contrast, or borders to convey depth? List each elevation level with what it's used for. If the system is intentionally flat, say so and explain what replaces shadow hierarchy.

### ## Shapes

State the radius philosophy. Describe how `{rounded.*}` tokens map to component sizes. Include a table if 4+ distinct values are in use. Note pill shapes and any sharp-corner exceptions.

### ## Components

For each component defined in the YAML, describe the visual contract in prose: default appearance, hover, active, disabled states, and any variant rules. Be specific enough that a developer can implement it without seeing a Figma file. Bold each component name.

### ## Do's and Don'ts

8–12 rules derived from the specific design decisions in this system. Every rule must be concrete and actionable — no generic advice. Format as a flat list starting with "Do" or "Don't".

---

## Output format

Output the raw file content directly — not inside a code block — so it can be saved as `DESIGN.md` as-is.

## Spec compliance checklist (self-verify before outputting)

- [ ] YAML is valid and delimited by `---` fences
- [ ] `name` field present
- [ ] At least one `primary` color defined (avoids lint warning)
- [ ] All `components` use `{token.ref}` syntax — zero raw hex or raw px values
- [ ] Typography `fontSize` uses a valid dimension: `px`, `em`, or `rem`
- [ ] All 8 sections present and in canonical order
- [ ] `section-order` rule satisfied — no section appears before its predecessor
- [ ] Do's and Don'ts are derived from actual token decisions, not generic filler
- [ ] No duplicate section headings (would cause lint error)
