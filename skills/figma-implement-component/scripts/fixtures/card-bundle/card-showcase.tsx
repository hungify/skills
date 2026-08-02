import { CARD_TESTIDS } from "./card-showcase.testids";

export function CardShowcase() {
  return (
    <section>
      {Object.entries(CARD_TESTIDS).flatMap(([prop, values]) =>
        Object.entries(values).map(([value, testid]) => (
          <div key={`${prop}-${value}`} data-testid={testid}>
            {prop}: {value}
          </div>
        )),
      )}
    </section>
  );
}
