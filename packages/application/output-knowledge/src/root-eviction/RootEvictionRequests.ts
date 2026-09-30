import {
  canonicalOutputJSON,
  outputAssert,
  outputHex32,
  outputPacketDigest,
  outputRootEvictionDecisionId,
  outputString,
  outputU64,
  parseOutputJSON,
  parseOutputRootEvictionRequest,
  parseOutputRootEvictionStatus,
  validateOutputRootEvictionWindow,
  verifyOutputRootEvictionRequest,
  type OutputRootEvictionOutcome
} from '@bsv/sdk'
import { rootBytes, rootDecimal, rootPosition, reserveRootResult } from './RootEvictionCodec.js'
import type { RootEvictionRetainedRequest } from './RootEvictionStorage.js'
import type { SQLiteRootEvictionDatabase } from './SQLiteRootEvictionDatabase.js'

type SavedAction = Omit<OutputRootEvictionOutcome, 'service' | 'outpoint' | 'serving'>

/** Internal request/immutable-terminal-action records. All calls hold the root gate. */
export class RootEvictionRequests {
  constructor(private readonly database: SQLiteRootEvictionDatabase) {}

  private decode(row: Record<string, unknown>): RootEvictionRetainedRequest {
    outputAssert(
      typeof row.packet === 'string',
      'Retained root request exceeds its bound',
      'unavailable'
    )
    const packet = parseOutputRootEvictionRequest(parseOutputJSON(row.packet, { bytes: 1048576 }))
    const { root, chain } = this.database.configuration
    verifyOutputRootEvictionRequest(packet, { root, chain, requester: String(row.requester) })
    const digest = outputPacketDigest('root-eviction-request', packet.body)
    outputAssert(
      digest === row.digest &&
        packet.body.requestId === row.request_id &&
        packet.body.targets.length === row.targets &&
        rootBytes(row.packet) === row.bytes &&
        canonicalOutputJSON(packet) === row.packet,
      'Retained root request binding failed',
      'unavailable'
    )
    rootDecimal(row.revision)
    return { request: packet, digest, policyDigest: outputHex32(row.policy) }
  }

  private row(digest: string): Record<string, unknown> | undefined {
    return this.database.get(
      `SELECT digest,requester,request_id,policy,revision,bytes,targets,
      CASE WHEN length(CAST(packet AS BLOB))<=1048576 THEN packet END AS packet
      FROM root_requests WHERE digest=?`,
      outputHex32(digest)
    )
  }
  byDigest(digest: string): RootEvictionRetainedRequest | undefined {
    const row = this.row(digest)
    return row && this.decode(row)
  }
  get(requester: string, requestId: string): RootEvictionRetainedRequest | undefined {
    const key = parseOutputRootEvictionStatus({ version: 1, requester, requestId })
    const row = this.database.get(
      'SELECT digest FROM root_requests WHERE requester=? AND request_id=?',
      key.requester,
      key.requestId
    )
    return row ? this.byDigest(outputHex32(row.digest)) : undefined
  }

  retain(
    input: unknown,
    requester: string,
    clock: { now: string; maximumLifetimeSeconds: string; futureClockSeconds: string }
  ): RootEvictionRetainedRequest {
    const packet = parseOutputRootEvictionRequest(input)
    // Authenticate before looking up the retained key. A changed recipient in an
    // otherwise authenticated, retained body is still an idempotency conflict.
    verifyOutputRootEvictionRequest(packet, {
      root: packet.body.recipient,
      chain: packet.body.chain,
      requester
    })
    const digest = outputPacketDigest('root-eviction-request', packet.body)
    const previous = this.get(requester, packet.body.requestId)
    if (previous) {
      outputAssert(
        previous.digest === digest,
        'Root request ID conflicts with its retained body',
        'conflict'
      )
      return previous
    }
    const configuration = this.database.configuration
    verifyOutputRootEvictionRequest(packet, {
      root: configuration.root,
      chain: configuration.chain,
      requester
    })
    validateOutputRootEvictionWindow(packet, clock)
    const head = this.database.head()
    reserveRootResult(packet, head.policyDigest, configuration.capacity.blockers)
    const text = canonicalOutputJSON(packet),
      bytes = rootBytes(text)
    const totals = this.database.get(
      'SELECT count(*) AS requests,coalesce(sum(bytes),0) AS bytes,coalesce(sum(targets),0) AS targets FROM root_requests'
    )!
    const capacity = configuration.capacity
    outputAssert(
      Number(totals.requests) < capacity.requests &&
        Number(totals.bytes) + bytes <= capacity.requestBytes &&
        Number(totals.targets) + packet.body.targets.length <= capacity.targets,
      'Root request capacity is full; permanent request fences cannot be reused',
      'limited'
    )
    this.database.run(
      'INSERT INTO root_requests VALUES (?,?,?,?,?,?,?,?)',
      digest,
      requester,
      packet.body.requestId,
      text,
      head.policyDigest,
      rootPosition(head.revision),
      bytes,
      packet.body.targets.length
    )
    return { request: packet, digest, policyDigest: head.policyDigest }
  }

  action(record: RootEvictionRetainedRequest, index: number): SavedAction {
    const row = this.database.get(
      'SELECT * FROM root_actions WHERE request_digest=? AND target_index=?',
      record.digest,
      index
    )
    if (!row) {
      const original = this.row(record.digest)!
      return {
        actionStatus: 'pending',
        reasonCode: 'awaiting-local-evaluation',
        affectedDecisionIds: [],
        revision: rootDecimal(original.revision)
      }
    }
    outputAssert(
      row.action_status === 'rejected' ||
        row.action_status === 'applied' ||
        row.action_status === 'no-op',
      'Invalid saved root action',
      'unavailable'
    )
    outputAssert(
      (row.decision !== null) === (row.action_status === 'applied') &&
        (row.affected !== null) === (row.action_status !== 'rejected'),
      'Invalid root decision attribution',
      'unavailable'
    )
    const revision = rootDecimal(row.revision)
    this.checkSavedAction(record, index, row, revision)
    return {
      actionStatus: row.action_status,
      reasonCode: outputString(row.reason),
      revision,
      ...(row.decision === null ? {} : { decisionId: outputHex32(row.decision) }),
      affectedDecisionIds: row.affected === null ? [] : [outputHex32(row.affected)]
    }
  }

  private checkSavedAction(
    record: RootEvictionRetainedRequest,
    index: number,
    row: Record<string, unknown>,
    revision: string
  ): void {
    const target = record.request.body.targets[index]
    const expectedDecision = outputRootEvictionDecisionId({
      root: record.request.body.recipient,
      requestDigest: record.digest,
      service: target.service,
      outpoint: target.outpoint,
      revision
    })
    outputAssert(
      (row.action_status !== 'applied' || row.decision === expectedDecision) &&
        (row.action_status !== 'no-op' || record.request.body.action === 'restore') &&
        (row.action_status === 'rejected' ||
          row.affected ===
            (record.request.body.action === 'suppress' ? expectedDecision : target.restores)) &&
        outputU64(revision) > outputU64(rootDecimal(this.row(record.digest)!.revision)) &&
        outputU64(revision) <= outputU64(this.database.head().revision),
      'Saved root action does not match its original request and revision',
      'unavailable'
    )
  }

  save(record: RootEvictionRetainedRequest, index: number, action: SavedAction): void {
    // INSERT only: neither retries nor later assessments can edit a terminal action.
    this.database.run(
      'INSERT INTO root_actions VALUES (?,?,?,?,?,?,?)',
      record.digest,
      index,
      action.actionStatus,
      action.reasonCode,
      rootPosition(action.revision),
      action.decisionId ?? null,
      action.affectedDecisionIds[0] ?? null
    )
  }

  pending(record: RootEvictionRetainedRequest): number[] {
    return record.request.body.targets.flatMap((_, index) =>
      this.action(record, index).actionStatus === 'pending' ? [index] : []
    )
  }
  expire(record: RootEvictionRetainedRequest, now: string): void {
    const head = this.database.head()
    const reason =
      record.policyDigest !== head.policyDigest
        ? 'policy-changed'
        : outputU64(now) >= outputU64(record.request.body.expiresAt)
          ? 'request-expired'
          : undefined
    if (!reason) return
    const pending = this.pending(record)
    if (pending.length === 0) return
    this.reject(record, pending, reason, this.database.advance())
  }
  private reject(
    record: RootEvictionRetainedRequest,
    indices: number[],
    reason: string,
    revision: string
  ): void {
    for (const index of indices)
      this.save(record, index, {
        actionStatus: 'rejected',
        reasonCode: reason,
        revision,
        affectedDecisionIds: []
      })
  }
  changePolicy(policy: string): void {
    outputHex32(policy)
    if (this.database.head().policyDigest === policy) return
    const revision = this.database.advance()
    const rows = this.database.all('SELECT digest FROM root_requests ORDER BY digest')
    for (const row of rows) {
      const record = this.byDigest(outputHex32(row.digest))!
      this.reject(record, this.pending(record), 'policy-changed', revision)
    }
    this.database.run('UPDATE root_meta SET policy=? WHERE id=1', policy)
  }
}
