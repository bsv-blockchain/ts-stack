export * from './proposal-client-fixture.js'
import { createRegistry } from './proposal-client-fixture.js'

/** Shared legacy service fixture; client-policy tests use the explicit factory. */
export const registry = createRegistry()
