import { MerklePath } from '@bsv/sdk'
import { Services } from '../Services'
import { createDefaultWalletServicesOptions } from '../createDefaultWalletServicesOptions'

/**
 * Verifies Arcade proof acquisition for a MINED transaction: fetch the BUMP from
 * `GET /tx/{txid}`, parse it, compute the merkle root and locate the tx's leaf, then validate
 * the root against the chaintracker — the same data path `TaskArcadeSSE.fetchProofFromArcade` uses.
 *
 *   PROOF_TXID=<txid> node_modules/.bin/jest --runTestsByPath \
 *     src/services/__tests/ArcadeProof.man.test.ts
 */
const PROOF_TXID = process.env.PROOF_TXID
const ARCADE_URL = process.env.ARCADE_URL ?? 'https://arcade-v2-us-1.bsvblockchain.tech'

describe('Arcade proof acquisition (live)', () => {
  jest.setTimeout(120000)

  test('GET /tx/{txid} returns a valid BUMP that proves the txid', async () => {
    if (!PROOF_TXID) throw new Error('Set PROOF_TXID env var')

    const options = createDefaultWalletServicesOptions(
      'main', undefined, undefined, undefined, undefined, undefined, undefined, undefined, ARCADE_URL
    )
    const services = new Services(options)

    const data = await services.arcade!.getTxData(PROOF_TXID)
    console.log(`[arcade] txStatus=${data.txStatus} blockHeight=${data.blockHeight} blockHash=${data.blockHash}`)
    console.log(`[arcade] merklePath present=${data.merklePath ? `yes (${data.merklePath.length} hex)` : 'NO'}`)

    expect(data.txStatus === 'MINED' || data.txStatus === 'IMMUTABLE').toBe(true)
    expect(data.merklePath).toBeTruthy()

    // Parse + compute root + locate the leaf — exactly TaskArcadeSSE.fetchProofFromArcade.
    const merklePath = MerklePath.fromHex(data.merklePath)
    const merkleRoot = merklePath.computeRoot(PROOF_TXID)
    const leaf = merklePath.path[0].find(l => l.txid === true && l.hash === PROOF_TXID)
    const height = data.blockHeight || merklePath.blockHeight
    console.log(`[proof] computed merkleRoot=${merkleRoot}`)
    console.log(`[proof] leaf offset=${leaf?.offset} height=${height}`)
    expect(leaf).toBeDefined()

    // Validate the BUMP's root against chain headers (the authoritative check).
    const chainTracker = await services.getChainTracker()
    const valid = await chainTracker.isValidRootForHeight(merkleRoot, height)
    console.log(`[proof] isValidRootForHeight(${merkleRoot.slice(0, 16)}…, ${height}) = ${valid}`)
    expect(valid).toBe(true)
  })
})
