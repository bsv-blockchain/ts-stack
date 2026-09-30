import {
  canonicalOutputJSON,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputRootEvictionDecisionId,
  parseOutputJSON
} from '@bsv/sdk'
import { rootDecimal, rootPosition, rootTarget, rootTargetKey } from './RootEvictionCodec.js'
import type {
  RootEvictionProjection,
  RootEvictionBasis,
  RootEvictionRetainedRequest,
  RootEvictionServing,
  RootEvictionServingTarget
} from './RootEvictionStorage.js'
import type { SQLiteRootEvictionDatabase } from './SQLiteRootEvictionDatabase.js'

/** Internal serving records; attribution and evidence policy are evaluated by the installed service. */
export class RootEvictionServingRecords {
  constructor(private readonly database: SQLiteRootEvictionDatabase) {}

  private blockers(key: string): RootEvictionServing['blockers'] {
    return this.database
      .all(
        'SELECT decision,policy FROM root_bases WHERE target_key=? AND lifted_by IS NULL ORDER BY decision LIMIT ?',
        key,
        this.database.configuration.capacity.blockers + 1
      )
      .map(row => ({
        decisionId: outputHex32(row.decision),
        policyDigest: outputHex32(row.policy)
      }))
  }
  private view(
    target: RootEvictionServingTarget,
    requireAdvertisement = true
  ): Record<string, unknown> | undefined {
    const row = this.database.get(
      'SELECT target,revision,projection_revision,eligible,ready FROM root_views WHERE target_key=?',
      rootTargetKey(target)
    )
    if (row) {
      outputAssert(
        !requireAdvertisement || row.target === canonicalOutputJSON(target),
        'Root advertisement differs from retained verified bytes',
        'conflict'
      )
      outputAssert(
        (row.eligible === 0 || row.eligible === 1) && (row.ready === 0 || row.ready === 1),
        'Invalid root serving flags',
        'unavailable'
      )
      rootDecimal(row.projection_revision)
      rootDecimal(row.revision)
    }
    return row
  }
  serving(target: RootEvictionServingTarget, requireAdvertisement = true): RootEvictionServing {
    const key = rootTargetKey(target),
      blockers = this.blockers(key)
    outputAssert(
      blockers.length <= this.database.configuration.capacity.blockers,
      'Root blocker capacity is inconsistent',
      'unavailable'
    )
    const row = this.view(target, requireAdvertisement)
    let state: RootEvictionServing['state'] = 'unresolved'
    if (blockers.length > 0) state = 'suppressed'
    else if (row?.eligible === 1 && row.ready === 1) state = 'eligible'
    return {
      state,
      revision: row ? rootDecimal(row.revision) : '0',
      blockers
    }
  }
  stage(target: RootEvictionServingTarget, eligible: boolean, revision: string): void {
    const previous = this.view(target)
    outputAssert(
      previous ||
        Number(this.database.get('SELECT count(*) AS n FROM root_views')!.n) <
          this.database.configuration.capacity.targets,
      'Root serving target capacity is full',
      'limited'
    )
    const key = rootTargetKey(target)
    const membership = eligible && this.blockers(key).length === 0 ? 'include' : 'withdraw'
    this.database.run(
      `INSERT INTO root_views VALUES (?,?,?,?,?,0)
      ON CONFLICT(target_key) DO UPDATE SET revision=excluded.revision,projection_revision=excluded.projection_revision,eligible=excluded.eligible,ready=0`,
      key,
      canonicalOutputJSON(target),
      rootPosition(revision),
      rootPosition(revision),
      eligible ? 1 : 0
    )
    this.database.run(
      'INSERT INTO root_projections VALUES (?,?,?) ON CONFLICT(target_key) DO UPDATE SET revision=excluded.revision,membership=excluded.membership',
      key,
      rootPosition(revision),
      membership
    )
  }
  invalidate(revision: string): void {
    // A policy rotation preserves action history, but never carries an old
    // eligibility assessment into the newly installed serving policy.
    this.database.run(
      'UPDATE root_views SET eligible=0,ready=0,revision=?,projection_revision=?',
      rootPosition(revision),
      rootPosition(revision)
    )
    this.database.run(
      `INSERT INTO root_projections SELECT target_key,?,'withdraw' FROM root_views WHERE true
      ON CONFLICT(target_key) DO UPDATE SET revision=excluded.revision,membership=excluded.membership`,
      rootPosition(revision)
    )
  }
  basis(decisionId: string): RootEvictionBasis | undefined {
    const row = this.database.get(
      'SELECT * FROM root_bases WHERE decision=?',
      outputHex32(decisionId)
    )
    if (!row) return undefined
    outputAssert(typeof row.target_key === 'string', 'Invalid root basis selector', 'unavailable')
    const key = parseOutputJSON(row.target_key) as unknown as Pick<
      RootEvictionServingTarget,
      'service' | 'outpoint'
    >
    return {
      decisionId,
      target: rootTarget({ ...key, advertisementDigest: outputHex32(row.advertisement_digest) }),
      requester: outputIdentity(row.requester),
      requestDigest: outputHex32(row.request_digest),
      policyDigest: outputHex32(row.policy),
      revision: rootDecimal(row.revision),
      liftedBy: row.lifted_by === null ? null : outputHex32(row.lifted_by)
    }
  }
  suppress(record: RootEvictionRetainedRequest, index: number, revision: string): string {
    const requested = record.request.body.targets[index]
    const key = rootTargetKey(requested)
    outputAssert(
      this.blockers(key).length < this.database.configuration.capacity.blockers,
      'Root active-decision capacity is full',
      'limited'
    )
    const decision = this.decision(record, index, revision)
    this.database.run(
      'INSERT INTO root_bases VALUES (?,?,?,?,?,?,?,NULL)',
      decision,
      key,
      requested.advertisementDigest,
      record.request.body.requester,
      record.digest,
      record.policyDigest,
      rootPosition(revision)
    )
    return decision
  }
  restore(
    record: RootEvictionRetainedRequest,
    index: number,
    revision: string
  ): { decisionId?: string; affected: string } {
    const target = record.request.body.targets[index],
      affected = outputHex32(target.restores)
    const basis = this.database.get(
      'SELECT target_key,advertisement_digest,lifted_by FROM root_bases WHERE decision=?',
      affected
    )
    outputAssert(
      basis?.target_key === rootTargetKey(target) &&
        basis.advertisement_digest === target.advertisementDigest,
      'Restoration does not name a matching local suppression',
      'invalid'
    )
    if (basis.lifted_by !== null) {
      outputHex32(basis.lifted_by)
      return { affected }
    }
    const decisionId = this.decision(record, index, revision)
    this.database.run('UPDATE root_bases SET lifted_by=? WHERE decision=?', decisionId, affected)
    return { decisionId, affected }
  }
  private decision(record: RootEvictionRetainedRequest, index: number, revision: string): string {
    const target = record.request.body.targets[index]
    return outputRootEvictionDecisionId({
      root: this.database.configuration.root,
      requestDigest: record.digest,
      service: target.service,
      outpoint: target.outpoint,
      revision
    })
  }

  projections(maximum: number): RootEvictionProjection[] {
    outputAssert(
      Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 1024,
      'Invalid root projection page limit'
    )
    return this.database
      .all(
        `SELECT v.target,p.revision,p.membership FROM root_projections p
      JOIN root_views v ON v.target_key=p.target_key ORDER BY p.revision,p.target_key LIMIT ?`,
        maximum
      )
      .map(row => {
        outputAssert(
          typeof row.target === 'string' &&
            (row.membership === 'include' || row.membership === 'withdraw'),
          'Invalid root projection record',
          'unavailable'
        )
        return {
          target: rootTarget(parseOutputJSON(row.target) as unknown as RootEvictionServingTarget),
          revision: rootDecimal(row.revision),
          membership: row.membership
        }
      })
  }
  projected(intent: RootEvictionProjection): boolean {
    const target = rootTarget(intent.target),
      row = this.view(target)
    const revision = rootPosition(intent.revision)
    outputAssert(
      intent.membership === 'include' || intent.membership === 'withdraw',
      'Invalid root projection membership'
    )
    if (row?.projection_revision !== revision) return false
    const key = rootTargetKey(target)
    const membership =
      row.eligible === 1 && this.blockers(key).length === 0 ? 'include' : 'withdraw'
    outputAssert(
      intent.membership === membership,
      'Root projection acknowledgement changed its membership',
      'conflict'
    )
    if (row.ready === 1) return true
    const saved = this.database.get(
      'SELECT revision,membership FROM root_projections WHERE target_key=?',
      key
    )
    outputAssert(
      saved?.revision === revision && saved.membership === membership,
      'Root projection intent is missing',
      'unavailable'
    )
    const next = this.database.advance()
    this.database.run(
      'UPDATE root_views SET ready=1,revision=? WHERE target_key=?',
      rootPosition(next),
      key
    )
    this.database.run('DELETE FROM root_projections WHERE target_key=?', key)
    return true
  }
}
