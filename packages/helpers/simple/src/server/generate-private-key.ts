/**
 * Standalone utility — generate a random private key hex.
 *
 * Lives as a sibling file inside `server/` so that other server-side modules
 * (e.g. `credential-issuer-handler.ts`, `server-wallet-manager.ts`) can
 * dynamically import it directly without going through the parent `server.ts`
 * barrel — which would create a circular dependency:
 *   server.ts -> server/index.ts -> server/<sibling>.ts -> server.ts
 */

import { PrivateKey } from '@bsv/sdk'

export function generatePrivateKey (): string {
  return PrivateKey.fromRandom().toHex()
}
