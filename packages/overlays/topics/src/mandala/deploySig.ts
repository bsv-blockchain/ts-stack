// The deploy signature (spec §5.3). A deploy has no authority input, so anyone
// who saw an issuer's earlier linkage could rebuild a deploy locked to the same
// key and spoof metadata under the issuer's name. The off-chain envelope
// therefore carries `deploySig`: the issuer's signature over this txid, which
// is unique and so cannot be replayed onto another deploy.
import { ProtoWallet } from '@bsv/sdk'
import { toArray } from '@bsv/sdk/primitives/utils'

const DEPLOY_PREFIX = 'mandala-deploy:'
const LOWERCASE_HEX = /^([0-9a-f]{2})+$/

/** UTF-8 bytes of `'mandala-deploy:' + txid`, the txid being 64 lowercase hex in display order. */
export function deployDigest(txid: string): number[] {
  return toArray(`${DEPLOY_PREFIX}${txid}`, 'utf8')
}

/**
 * True when `signatureHex` is the deploy owner's `createSignature` over
 * `deployDigest(txid)` (protocol `[2, 'mandala deploy']`, keyID `'1'`,
 * counterparty `'anyone'`). Anything else, including any throw, is false.
 */
export async function verifyDeploySig(
  txid: string,
  signatureHex: string | undefined,
  ownerIdentityKey: string
): Promise<boolean> {
  if (signatureHex === undefined || !LOWERCASE_HEX.test(signatureHex)) return false
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: deployDigest(txid),
      signature: toArray(signatureHex, 'hex'),
      protocolID: [2, 'mandala deploy'],
      keyID: '1',
      counterparty: ownerIdentityKey
    })
    return valid
  } catch {
    return false
  }
}
