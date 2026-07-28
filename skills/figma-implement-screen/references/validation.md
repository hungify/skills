# Behavioral validation

Read during screen UI implementation and accessibility verification. Pixel comparison and test locators stay in [visual](visual.md) and [automation](automation.md).

This validation covers behavior visible at UI boundary: responsive layout, supplied component states, semantics, focus, keyboard use, and callback wiring. It does not invent or certify business rules, API effects, authentication, persistence, or product workflows.

## Responsive behavior

Read Figma Auto Layout, constraints, min/max sizing, hug/fill behavior, and overflow before coding.

- One supplied node still carries responsive constraints; do not turn it into a fixed screenshot.
- Do not invent a second visual layout or breakpoint without evidence.
- Use repository breakpoint and container conventions.
- Preserve fluid widths and intrinsic content behavior between supplied viewports.
- Check narrow, target, and adjacent wider widths for clipping, overflow, and unintended reflow.

## Interactive states

Inventory states exposed by Figma component properties and existing code primitives before implementation.

- Implement supplied hover, focus, active, disabled, selected/checked, error, and loading states through prop maps and existing component APIs.
- Preserve keyboard and pointer behavior from accessible primitives.
- Do not invent business states absent from design or product requirements.
- Expose and manually inspect every supplied state; default-state screenshot alone is weak UI evidence.

## Accessibility

- Prefer semantic elements and existing accessible primitives.
- Give controls accessible names; associate labels, descriptions, and errors with fields.
- Preserve keyboard navigation, visible focus, disabled semantics, and appropriate roles/states.
- Keep text and control contrast at project requirements.
- Use ARIA only when native semantics or primitive APIs are insufficient.
- Accessibility wins over literal visual replication when directly conflicting; report deviation.

## Deviations

Do not silently diverge from Figma. Allow deviation only for accessibility requirement or verified technical constraint, not implementation convenience.

Report Figma node or affected intent, constraint and evidence, implemented behavior, and visual/behavior impact. Stop for user direction when impact is material or needs product/design choice.

## Developer review checklist

- [ ] Responsive constraints implemented without invented layouts
- [ ] Supplied interactive states available for manual review
- [ ] Keyboard interaction and visible focus work
- [ ] Labels, roles, errors, and disabled states are accessible
- [ ] Assets and content have correct accessible treatment
- [ ] Deviations absent or explicitly reported with evidence
- [ ] Business logic marked out of scope or handed to owner
