# Screen visual integration

Use `$figma-verify-visual` for capture, comparison, evidence inspection, and independent done-gate. Screen skill owns code changes and required coverage; verification skill remains read-only and owns visual verdict.

For every supplied mobile, desktop, or state node:

1. Declare one primary `visualContracts[]` entry.
2. Pass equivalent CLI contract to `$figma-verify-visual`.
3. Inspect gold, actual, diff, score, and punch list.
4. Store CLI-owned `visual-verification.json` path and SHA-256 in `visualVerification`.
5. Fix code only in screen workflow, then rerun affected verification contracts.

Use a region when it gives meaningful localized evidence. Use page scope when complete chrome/layout matters. Never invent Figma source, breakpoint, selector, crop, state, or threshold.

Unified screen gate requires `figloom done-gate` success and exact agreement between screen declarations and verification request. Passing evidence never replaces developer code review, diff review, accessibility tests, behavior tests, or manual UI testing.
