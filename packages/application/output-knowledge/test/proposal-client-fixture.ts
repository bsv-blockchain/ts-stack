import {
  canonicalOutputJSON,
  LockingScript,
  outputPacketDigest,
  PrivateKey,
  signOutputPacket,
  Transaction,
  UnlockingScript,
  Utils,
  type OutputProposalBody,
  type OutputSignedProposal
} from '@bsv/sdk'
import { AuthorDocumentPolicy, ProposalPolicyRegistry } from '../src/proposals/index.js'

export const authorKey = new PrivateKey(1)
export const author = authorKey.toPublicKey().toString()
export const recipient = new PrivateKey(2).toPublicKey().toString()
export const outsider = new PrivateKey(3).toPublicKey().toString()
export const chain = { network: 'test', genesisHash: '01'.repeat(32) }
export const scope = { chain, service: 'tm_documents' }
export const policy = new AuthorDocumentPolicy()
/** Instantiate the code under test inside a test or an explicit worker operation. */
export function createRegistry(): ProposalPolicyRegistry {
  return new ProposalPolicyRegistry([{ policy, parameters: { maxTextBytes: 32 } }])
}
export const _parameters = { maxTextBytes: 32 }
export const reference = {
  id: policy.id,
  digest: outputPacketDigest('proposal-policy', { id: policy.id, parameters: _parameters })
}
export const bytes = (text: string) => Utils.toBase64(Utils.toArray(text, 'utf8'))
export function signed(changes: Partial<OutputProposalBody> = {}): OutputSignedProposal {
  return signOutputPacket<OutputProposalBody>(
    'proposal',
    {
      version: 1,
      ...scope,
      policy: reference,
      channel: '02'.repeat(32),
      revision: '0',
      previous: null,
      author,
      recipients: [author, recipient].sort((a, b) => a.localeCompare(b)),
      anchors: [],
      issuedAt: '10',
      expiresAt: '100',
      operation: 'update',
      payload: bytes(canonicalOutputJSON({ text: 'shared draft' })),
      ...changes
    },
    authorKey
  )
}
export function finalize(proposal: OutputSignedProposal): Transaction {
  return new Transaction(
    1,
    [
      {
        sourceTXID: '03'.repeat(32),
        sourceOutputIndex: 2,
        unlockingScript: new UnlockingScript(),
        sequence: 0xfffffffe
      }
    ],
    [
      {
        satoshis: 1,
        lockingScript: LockingScript.fromHex(
          '006a045052503120' + outputPacketDigest('proposal', proposal.body)
        )
      }
    ],
    42
  )
}
export function checkFinalization(proposal: OutputSignedProposal, tx: Transaction): void {
  createRegistry().finalization(proposal, Utils.toBase64(tx.toBinary()), tx.id('hex'))
}
