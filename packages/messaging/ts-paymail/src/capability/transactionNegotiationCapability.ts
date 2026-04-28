import Capability from './capability.js'

const TransactionNegotiationCapability = new Capability({
  title: 'Transaction Negotiation',
  authors: ['Curtis Ellis (Tokenized)'],
  version: '1',
  code: 'bc2add1aae8e',
  method: 'POST'
})

export default TransactionNegotiationCapability

export interface TransactionNegotiationBody {
  thread_id: string
  fees: Array<{ feeType: string, satoshis: number, bytes: number }>
  expanded_tx: {
    tx: string
    ancestors: Array<{ tx: string, merkle_proofs?: any[], miner_responses?: any[] }>
    spent_outputs: Array<{ value: number, locking_script: string }>
  }
  expiry: number
  timestamp: number
  reply_to: {
    handle: string
    peer_channel?: string
  }
}
