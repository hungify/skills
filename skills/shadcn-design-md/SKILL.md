---
name: shadcn-design-md
description: Reads a shadcn/Tailwind codebase and produces a DESIGN.md — the prompting source of truth for generating new UI that stays on-brand. Use this skill whenever the user asks to write a DESIGN.md, document the design system, capture the visual language or UI style, or generate new screens/components that must match the existing design. All token values are derived from globals.css and real component files — never invented.
---

# DESIGN.md Skill — shadcn/Tailwind Codebase Edition

You are an expert Design Systems Lead. Your task is to read the project's existing codebase and produce a `DESIGN.md` file that serves as the **prompting source of truth** for generating new UI that stays perfectly on-brand.

---

## When to trigger

- "write a DESIGN.md for this project"
- "document the design system"
- "capture the visual language / UI style"
- Any request to generate new screens or components that must match existing design

---

## Step 1 — Read the codebase first

Before writing a single word, read these files in order:

1. `app/globals.css` or `src/globals.css` — CSS custom properties: `--primary`, `--background`, `--radius`, `--font-sans`, etc.
2. `tailwind.config.ts` / `tailwind.config.js` — theme extensions, color aliases, font stack overrides
3. `components/ui/button.tsx`, `card.tsx`, `badge.tsx`, `input.tsx` — shadcn primitives reveal actual padding, radius, variant structure
4. Any `tokens.*`, `theme.*`, or `design-system.*` file if present
5. A representative page component (e.g. `app/page.tsx`) to understand spatial rhythm and component usage in context

**Never guess or invent values.** If a token is ambiguous, read the file that defines it.

---

## Step 2 — Produce DESIGN.md

Output a single `DESIGN.md` file. **No YAML frontmatter.** Eight `##` sections in order. Sections are dense prose — not raw value dumps. Write as if briefing a senior developer who has never seen this codebase but needs to build a new page that looks identical to existing ones.

Reference every color and spacing value as `var(--token-name)` using the actual CSS variable name from `globals.css`. Reference Tailwind classes where they're the real abstraction (`font-sans`, `text-sm`, `tracking-tight`, `rounded-lg`). Do not include raw hex values unless a value has no CSS variable or Tailwind class.

---

## Section guidance

### ## Overview

3–5 sentences. Answer: _What does this product feel like and who is it for?_ Name the brand personality (clinical, playful, authoritative, minimal, editorial…), the target user, the emotional register, and any aesthetic reference point if one is clearly identifiable. This section is the most important — it sets the frame for every decision that follows.

The bar for specificity: "A clean, modern interface with a focus on usability" tells an agent nothing useful. A good Overview names a concrete aesthetic register, a real emotional quality, and ideally a reference point — so an agent reading it cold can make the right visual call on an edge case without looking at any other file. Write entirely from what you observe in the codebase.

### ## Colors

Describe the **semantic role and emotional feel** of each color, not just its name. For each: what is it used for, what does it communicate, when should it be used, when should it never be used.

Structure: start with the page foundation (background, foreground), then interactive (primary, accent), then semantic (muted, destructive, border), then any brand accent colors.

Reference every color as `var(--token-name)`. If the project uses brand accent colors beyond the shadcn defaults, describe their cycling rule or priority order explicitly.

Must cover: background, foreground, primary, muted, accent, destructive, border. Cover card, popover, sidebar tokens if they exist and differ meaningfully from background.

### ## Typography

Describe the font stack, the scale in use, and the _feel and use_ of each level. Use a markdown table for the scale — it's the most scannable format for this data. Columns: Token/Class | Size | Weight | Use.

Note any critical typographic rules: weight ceiling, letter-spacing conventions, line-height for dense vs. relaxed contexts, whether there's a display face vs. a UI face.

Use a table — all values must come from the actual codebase, not this example:

| Class                        | Size          | Weight          | Use          |
| ---------------------------- | ------------- | --------------- | ------------ |
| _(real class from codebase)_ | _(real size)_ | _(real weight)_ | _(real use)_ |

### ## Layout

Describe the spatial character in concrete terms: max content width, base spacing unit, section vertical rhythm, grid strategy (sidebar+main? full-bleed bands? card grid?), responsive behavior at key breakpoints.

Name the actual Tailwind spacing classes or CSS vars used for section padding and gutters if they're consistent across the codebase.

### ## Elevation & Depth

Is the UI flat, lightly shadowed, or layered? Name the actual shadow utilities in use (`shadow-sm`, `shadow-md`, or none). If depth comes from tonal contrast between `var(--card)` and `var(--background)` rather than shadows, say so explicitly — this is a critical design decision that agents frequently get wrong by adding shadows where the design uses tonal contrast.

List the levels: flat (no shadow, no border) / hairline border only / faint drop shadow / and what each is used for.

### ## Shapes

State the corner radius philosophy. Reference `var(--radius)` and describe how it scales across component sizes. Note any pill shapes (badges, toggles), any sharp-corner exceptions, and whether radius is uniform across the system or varies by component type.

If there are 4+ distinct radius values in use, use a table — populate with real values from the codebase:

| Tailwind class        | Computed value                       | Used for                 |
| --------------------- | ------------------------------------ | ------------------------ |
| _(e.g. `rounded-md`)_ | _(e.g. `calc(var(--radius) - 2px)`)_ | _(e.g. buttons, inputs)_ |

### ## Components

For each key component, describe the **visual contract** precisely enough that a new component can be built to match without seeing the original. Cover default, hover, active, and disabled states. Cover all meaningful variants.

Always cover: Button (primary + secondary + ghost/outline variants), Input, Card. Also cover any domain-specific components that appear in 3+ places in the codebase.

Write as structured prose with bold component names. Read the actual component file before writing — every class name must be real. Format example (replace all values with what you find in the code):

> **Button — primary:** `bg-primary text-primary-foreground`, `rounded-[X]`, `h-[X] px-[X]`, `text-[X] font-[X]`. Hover: `[real hover class]`. Disabled: `[real disabled class]`. Border: [yes/no, describe].

### ## Do's and Don'ts

6–10 guardrails distilled from what you actually read in the codebase. Every rule must be specific to _this_ project — derived from real code, not generic advice.

**Do not copy the examples below — they are format templates only. Replace every value with what you found in the codebase.**

- Do use `var(--[real primary token])` for [real use case in this project].
- Don't [real anti-pattern found in the codebase] — [reason derived from the actual design].
- Do use `[real muted token]` for [real secondary text use case].
- Don't use `[real class you should avoid]` — [explain why based on actual code].

If you find yourself writing a generic rule like "maintain good contrast" or "use consistent spacing" — delete it and replace with something you actually observed in the code.

---

## Quality bar

Before saving, re-read the output and ask: _could an agent build a new Settings page from this file alone — no codebase access — and have it look indistinguishable from the existing app?_

If any section contains a generic sentence, an invented token name, or a placeholder value from this skill's examples rather than the real codebase — rewrite it. Target 500–900 words total.
