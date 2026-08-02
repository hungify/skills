/**
 * TEMPLATE — harness/showcase for the fidelity gate (step 5b).
 * Copy to `<component>-showcase.tsx` next to the real component.
 *
 * Principles:
 * - Each state in the main matrix (prop × value combinations AFTER DEDUP
 *   in step 5a — use the canonical prop, skip redundant bindings) renders
 *   in its own region, with a data-testid taken from
 *   `*-showcase.testids.ts` (do not hardcode testid strings here).
 * - Bindings with mappingKind:"composition" (e.g. show/hide a prepend
 *   icon) do NOT get their own matrix — just make sure >=1 state in the
 *   main matrix illustrates the composition, using a "-with-prepend" /
 *   "-with-append" suffix if needed.
 * - Capture at element scope (data-testid), NOT full-page.
 */
import { __COMPONENT_NAME_UPPER___TESTIDS as TESTIDS } from "./__component-name__-showcase.testids";
import { __ComponentName__ } from "./__component-name__";

export function __ComponentName__Showcase() {
  return (
    <div>
      {/* Loop over each canonical prop × value combination (e.g. size ×
          variant × color for Button, or the matrix that applies to the
          component being implemented). Each cell renders:

          <__ComponentName__
            {...propsForThisCombo}
            data-testid={TESTIDS.<prop>.<value>}
          />
      */}
    </div>
  );
}
