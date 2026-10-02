import { readFileSync } from 'node:fs'
import { createSecretKey } from 'node:crypto'
import { PrivateServiceDomain } from '../../dist/private/PrivateServiceDomain.js'
import { NodeProtectedPayloadCodec } from '../../dist/private/NodeProtectedPayloadCodec.js'
import { PrivateAcquisitionContracts } from '../../dist/private/PrivateAcquisitionContracts.js'
import { SQLitePrivateAcquisitionStore } from '../../dist/private/SQLitePrivateAcquisitionStore.js'

// Synthetic local process-loss fixture. Receipt fields model a trusted native
// adapter outcome; this worker performs no real wallet effect or paid operation.
const job = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const domain = PrivateServiceDomain.open(
  job.path,
  job.configuration,
  { resolve: () => createSecretKey(Buffer.alloc(32, 83)) },
  new NodeProtectedPayloadCodec({ resolve: () => createSecretKey(Buffer.alloc(32, 84)) }, 'payload')
)
const contracts = new PrivateAcquisitionContracts(job.installation, {
  maximumAgeSeconds: '100',
  clockSkewSeconds: '1',
  rules: new Map([[job.ruleId, () => {}]])
})
const store = new SQLitePrivateAcquisitionStore(domain, job.limits, {
  contracts,
  validationPolicy: job.policy,
  maximumRecordBytes: 1048576
})
let now = '20'
const clock = () => now,
  guard = () => {},
  id = job.original.challenge.acquisitionId,
  buyer = job.original.challenge.buyer
let value = store.quote(job.original, 'AQID', clock, guard)
const phases = ['quoted', 'pinned', 'funding-pending', 'funded', 'delivery-pending', 'delivered']
for (const phase of phases) {
  if (phase === 'pinned') {
    now = '30'
    value = store.advance(
      id,
      buyer,
      value.row.revision,
      { type: 'pin', payment: job.payment },
      clock,
      guard
    )
  }
  if (phase === 'funding-pending') {
    now = '31'
    value = store.advance(
      id,
      buyer,
      value.row.revision,
      {
        type: 'reserve-funding',
        candidateDigest: value.state.progress.candidate.digest,
        sellerPaymentKey: job.sellerPaymentKey,
        acceptance: job.acceptance
      },
      clock,
      guard
    )
  }
  if (phase === 'funded') {
    now = '32'
    const operation = value.state.progress.funding.operation
    value = store.advance(
      id,
      buyer,
      value.row.revision,
      {
        type: 'wallet-accepted',
        receipt: {
          operationId: operation.id,
          funding: operation.funding,
          seller: operation.seller,
          satoshis: operation.satoshis,
          evidence: { nativeReceipt: 'fixture-only' }
        }
      },
      clock,
      guard
    )
  }
  if (phase === 'delivery-pending') {
    now = '33'
    value = store.advance(id, buyer, value.row.revision, { type: 'prepare-delivery' }, clock, guard)
  }
  if (phase === 'delivered') {
    now = '34'
    value = store.complete(id, buyer, value.row.revision, 'BAUG', clock, guard)
  }
  if (phase === job.phase) {
    process.send({
      phase,
      revision: value.revision,
      recordRevision: value.row.revision,
      state: value.state
    })
    await new Promise(() => {
      setInterval(() => {}, 1000)
    })
  }
}
throw new Error('Unknown process fixture phase')
