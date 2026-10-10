// Shared contract fixtures retain their ordinary global Jest API. In the
// native ESM project Jest exposes the same object through import.meta instead.
// Install it only in this test sandbox; legacy CommonJS remains unchanged.
if (globalThis.jest !== undefined && globalThis.jest !== import.meta.jest)
  throw new Error('Native fixture received a different Jest test owner')
globalThis.jest ??= import.meta.jest
