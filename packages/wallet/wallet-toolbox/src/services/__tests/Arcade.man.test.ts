import { Arcade } from '../providers/Arcade'
import { arcadeDefaultUrl } from '../createDefaultWalletServicesOptions'

/**
 * Integration ("man") tests against a live Arcade (bsv-blockchain/arcade) instance.
 *
 * Excluded from `npm test` (matches *.man.test.ts). Run explicitly, e.g.:
 *   npx jest src/services/__tests/Arcade.man.test.ts
 *
 * Default target is the public teratestnet endpoint (no auth required):
 *   https://arcade-v2-ttn-us-1.bsvblockchain.tech
 * Override with ARCADE_URL / ARCADE_API_KEY env vars.
 *
 * The active tests are fund-free: they exercise the broadcast/lookup paths and the
 * live 400/404 classification without needing a signed, funded transaction. The
 * full happy-path broadcast (202 → SSE → MINED → proof) requires a funded wallet and
 * is left as a documented, skipped template.
 */

const ARCADE_URL = process.env.ARCADE_URL ?? arcadeDefaultUrl('ttn')!
const ARCADE_API_KEY = process.env.ARCADE_API_KEY

function arcade(): Arcade {
  return new Arcade(ARCADE_URL, { apiKey: ARCADE_API_KEY })
}

describe('Arcade integration (live)', () => {
  jest.setTimeout(60000)

  test('endpoint uses /tx prefix and is reachable: unknown txid → not found', async () => {
    const arc = arcade()
    const unknown = '00'.repeat(32)
    const data = await arc.getTxData(unknown)
    // Arcade returns 404 {"error":"transaction not found"} for an unknown txid;
    // the parsed body therefore carries no matching txid.
    expect(data.txid).not.toBe(unknown)
  })

  test('malformed tx → HTTP 400 classified as invalidTx (serviceError=false), not a transient service error', async () => {
    const arc = arcade()
    // Unparseable wire bytes: Arcade replies 400 "failed to parse transaction".
    const malformed = '0100000000000000000000'
    const r = await arc.postRawTx(malformed)
    expect(r.status).toBe('error')
    // Key Arcade-specific behavior: a 400 is terminal/invalid, not a retryable service error.
    expect(r.serviceError).toBe(false)
  })

  test('empty tx → HTTP 400 (serviceError=false)', async () => {
    const arc = arcade()
    const r = await arc.postRawTx('')
    expect(r.status).toBe('error')
    expect(r.serviceError).toBe(false)
  })

  // A funded happy-path belongs in this suite only once its key provisioning,
  // cleanup, and assertions are implemented. Do not register an empty skipped
  // test: the intended lifecycle is 202 RECEIVED → SEEN_ON_NETWORK → MINED,
  // followed by a non-empty merklePath assertion.
})
