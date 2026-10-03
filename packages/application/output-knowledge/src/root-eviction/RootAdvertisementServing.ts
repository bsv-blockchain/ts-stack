import {
  Beef,
  canonicalOutputJSON,
  decodeOutputBytes,
  outputAssert,
  outputRootAdvertisementDigest,
  parseOutputEvidence,
  parseOutputLookupBatch,
  parseOutputJSON,
  Transaction,
  Utils,
  type OutputChain,
  type OutputEvidence
} from '@bsv/sdk'
import { rootTarget } from './RootEvictionCodec.js'
import type { RootEvictionHead, RootEvictionServingTarget } from './RootEvictionStorage.js'

/** Optional native port. Existing asynchronous journal/store contracts remain valid. */
export interface RootAdvertisementServingGate {
  readonly servingEnqueue: 'root-serving-send/1'
  captureServing(): RootEvictionHead
  enqueueNow(
    candidate: { revision: string; targets: RootEvictionServingTarget[]; bytes: Uint8Array },
    authorize: () => boolean,
    enqueue: (bytes: Uint8Array) => undefined
  ): void
}

/**
 * Derive a responsive advertisement's exact inventory key. This is serialization,
 * not authentication/currentness: installed SDK evidence and topic rules must
 * already have established this target's eligibility in the root journal.
 */
export function rootAdvertisementServingTarget(
  service: string,
  chain: OutputChain,
  input: OutputEvidence
): RootEvictionServingTarget {
  outputAssert(service === 'ls_ship' || service === 'ls_slap', 'Not a root discovery service')
  const evidence = parseOutputEvidence(input),
    bytes = decodeOutputBytes(evidence.beef)
  outputAssert(bytes.length <= 1048576, 'Root advertisement evidence byte limit', 'limited')
  const beef = Beef.fromBinary(Array.from(bytes))
  outputAssert(
    beef.atomicTxid === undefined || beef.atomicTxid === evidence.txid,
    'Root advertisement Atomic BEEF subject differs'
  )
  const subject = beef.findTxid(evidence.txid)?.tx
  outputAssert(subject, 'Root advertisement raw subject is absent')
  const transaction = Transaction.fromBinary(subject.toBinary())
  outputAssert(
    transaction.id('hex') === evidence.txid && evidence.outputIndex < transaction.outputs.length,
    'Root advertisement output differs'
  )
  const outpoint = { chain, txid: evidence.txid, outputIndex: evidence.outputIndex }
  return rootTarget({
    service,
    outpoint,
    advertisementDigest: outputRootAdvertisementDigest({
      service,
      outpoint,
      lockingScript: Utils.toBase64(
        transaction.outputs[evidence.outputIndex].lockingScript.toBinary()
      )
    })
  })
}

/** Complete positive inventory; raw ancestry and withdrawals are not advertisements of membership. */
export function rootLookupAdvertisementTargets(
  body: string,
  supportedExtensions: readonly string[] = []
): RootEvictionServingTarget[] {
  const batch = parseOutputLookupBatch(parseOutputJSON(body), 4194304, supportedExtensions)
  outputAssert(
    batch.scope.service === 'ls_ship' || batch.scope.service === 'ls_slap',
    'Not a root discovery lookup'
  )
  outputAssert(
    batch.extensions === undefined,
    'Opaque root lookup extensions require an installed inventory',
    'unsupported'
  )
  const targets: RootEvictionServingTarget[] = []
  for (const group of batch.groups) {
    for (const observation of group.observations) {
      outputAssert(
        observation.extensions === undefined,
        'Opaque root observation extensions require an installed inventory',
        'unsupported'
      )
      outputAssert(
        ['output', 'withdraw', 'spend', 'assessment-invalidated'].includes(observation.kind),
        'Unsupported root discovery observation'
      )
      if (observation.kind === 'output') {
        outputAssert(
          observation.payload.context === undefined,
          'Root advertisements have no private context'
        )
        targets.push(
          rootAdvertisementServingTarget(
            batch.scope.service,
            batch.scope.chain,
            observation.payload.evidence
          )
        )
      }
    }
  }
  return targets
}

/**
 * Bind the complete bytes to an owned inventory and one native enqueue attempt.
 * A finite/cache/hydration adapter can capture() before asynchronous preparation
 * and pass that original head to bind(). No filtering, signing or I/O runs under
 * the root writer gate. Headers must not contain additional advertisements.
 */
export class RootAdvertisementServing {
  private readonly captureMethod: RootAdvertisementServingGate['captureServing']
  private readonly enqueueMethod: RootAdvertisementServingGate['enqueueNow']
  constructor(private readonly gate: RootAdvertisementServingGate) {
    outputAssert(
      gate.servingEnqueue === 'root-serving-send/1',
      'Root serving requires native enqueue',
      'unsupported'
    )
    this.captureMethod = gate.captureServing
    this.enqueueMethod = gate.enqueueNow
  }
  capture(): RootEvictionHead {
    this.current()
    return { ...this.captureMethod.call(this.gate) }
  }
  bind(bytes: Uint8Array, inventory: readonly RootEvictionServingTarget[], head = this.capture()) {
    outputAssert(
      bytes instanceof Uint8Array && bytes.length <= 4194304,
      'Root serving byte limit',
      'limited'
    )
    outputAssert(
      Array.isArray(inventory) && inventory.length <= 1024,
      'Root serving inventory limit',
      'limited'
    )
    const expected = new Uint8Array(bytes),
      targets = inventory.map(target => rootTarget(target)),
      revision = head.revision
    // Own nested chains and reject noncanonical/foreign target fields before binding.
    canonicalOutputJSON(targets, { bytes: 1048576 })
    let attempted = false
    return Object.freeze({
      enqueue: (
        supplied: Uint8Array,
        authorize: () => boolean,
        send: (bytes: Uint8Array) => undefined
      ): void => {
        outputAssert(!attempted, 'Root serving enqueue was already attempted', 'conflict')
        outputAssert(
          supplied instanceof Uint8Array &&
            supplied.length === expected.length &&
            supplied.every((byte, index) => byte === expected[index]),
          'Root serving response bytes changed'
        )
        this.current()
        attempted = true
        this.enqueueMethod.call(this.gate, { revision, targets, bytes: expected }, authorize, send)
      }
    })
  }
  private current(): void {
    outputAssert(
      this.gate.servingEnqueue === 'root-serving-send/1' &&
        this.gate.captureServing === this.captureMethod &&
        this.gate.enqueueNow === this.enqueueMethod,
      'Root serving owner changed',
      'unavailable'
    )
  }
}
