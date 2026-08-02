/**
 * TEMPLATE — copy this file to `<component>-showcase.testids.ts` next to
 * the component, rename the const, and fill in the values following the
 * dedup canonical props (step 5a) of the component being implemented.
 *
 * testid convention (step 5b): `{componentName}-{prop}-{value}`
 *
 * This file is the SINGLE SOURCE of testid strings — both the showcase
 * harness and scripts/coverage_check.mjs read from it. Do not hardcode
 * testid strings anywhere else.
 */
export const __COMPONENT_NAME_UPPER___TESTIDS = {
  // <propName>: { <codeValue>: "<componentname>-<propname>-<codevalue>", ... }
  //
  // Example (Button):
  // size: { sm: "button-size-sm", md: "button-size-md", lg: "button-size-lg", xl: "button-size-xl" },
  // variant: { filled: "button-variant-filled", outline: "button-variant-outline" },
  // color: { green: "button-color-green", lime: "button-color-lime", /* ... */ },
} as const;
