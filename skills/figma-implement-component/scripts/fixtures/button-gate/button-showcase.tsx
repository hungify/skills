import { BUTTON_TESTIDS } from "./button-showcase.testids";

export function ButtonShowcase() {
  return (
    <section>
      {Object.entries(BUTTON_TESTIDS).flatMap(([prop, values]) =>
        Object.entries(values).map(([value, testid]) => (
          <button key={`${prop}-${value}`} data-testid={testid}>
            {prop}: {value}
          </button>
        )),
      )}
    </section>
  );
}
