import { reactAdapter } from "./react.mjs";

const requiredMethods = [
  "analyzeFile",
  "isAllowedComponentAttribute",
  "isKnownPrimitive",
  "isRawPrimitiveUsage",
  "formatRawPrimitiveUsage",
  "replacementImportSource",
];

function assertFrameworkAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("framework adapter must be an object");
  }
  if (typeof adapter.id !== "string" || adapter.id.length === 0) {
    throw new Error("framework adapter requires non-empty id");
  }
  if (
    !Array.isArray(adapter.fileExtensions) ||
    adapter.fileExtensions.length === 0 ||
    adapter.fileExtensions.some((extension) => !/^\.[a-z0-9]+$/i.test(extension))
  ) {
    throw new Error(`framework adapter ${adapter.id} requires fileExtensions[]`);
  }
  for (const method of requiredMethods) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`framework adapter ${adapter.id} requires ${method}()`);
    }
  }
  return adapter;
}

const adapters = /* @__PURE__ */ new Map(
  [reactAdapter].map((adapter) => {
    const validated = assertFrameworkAdapter(adapter);
    return [validated.id, validated];
  }),
);
function getFrameworkAdapter(framework) {
  const adapter = adapters.get(framework);
  if (!adapter) {
    throw new Error(
      `framework adapter unavailable: ${framework}; available adapters: ${[...adapters.keys()].join(", ")}`,
    );
  }
  return adapter;
}
export { assertFrameworkAdapter, getFrameworkAdapter };
