import {
  canonicalOutputJSON,
  closedOutputObject,
  Hash,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputLookupOpen,
  parseOutputObservation,
  parseOutputScope,
  Utils,
  type OutputJSON,
  type OutputJSONObject,
  type OutputScope,
  type OutputSourceGroup
} from '@bsv/sdk'
import { LookupIndexCodec, type LookupIndexGroup, type LookupIndexRow } from './LookupIndexCodec.js'
import type {
  LookupQueryContext,
  LookupQueryDescription,
  LookupQueryInstallation,
  LookupObservationTemplate
} from './LookupQueryPolicy.js'
import { LookupLimitError } from './LookupLimitError.js'

function owned(value: unknown, bytes: number): OutputJSON {
  return parseOutputJSON(canonicalOutputJSON(value, { bytes }), { bytes })
}
function parameters(value: unknown): OutputJSONObject {
  const result = owned(value, 65536)
  if (result === null || typeof result !== 'object' || Array.isArray(result))
    throw new OutputProtocolError('invalid', 'Lookup rule parameters must be a JSON object')
  return result
}
function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).length
}

/** An immutable prepared query. Its outputs still require a current disclosure gate. */
export interface LookupQueryView {
  snapshot(
    row: LookupIndexRow,
    session: string,
    watermark: string,
    time: string
  ): OutputSourceGroup | null
  live(group: LookupIndexGroup): OutputSourceGroup | null
}

class InstalledLookupQueryView implements LookupQueryView {
  private readonly index = new LookupIndexCodec()
  private readonly context: LookupQueryContext
  constructor(
    private readonly installation: LookupQueryInstallation,
    context: LookupQueryContext
  ) {
    this.context = structuredClone(context)
  }

  private identifier(phase: 'snapshot' | 'live', position: unknown): string {
    return Utils.toHex(
      Hash.sha256(
        Utils.toArray(
          'OUTPUT-LOOKUP-GROUP/1\0' +
            canonicalOutputJSON(
              {
                scope: this.context.scope,
                phase,
                position
              },
              { bytes: 65536 }
            ),
          'utf8'
        )
      )
    )
  }

  snapshot(
    input: LookupIndexRow,
    session: string,
    watermark: string,
    time: string
  ): OutputSourceGroup | null {
    const row = this.index.row(input)
    outputHex32(session)
    outputU64(time)
    if (
      outputU64(row.revision) > outputU64(watermark) ||
      (row.value.expiresAt !== null && outputU64(row.value.expiresAt) <= outputU64(time))
    )
      throw new OutputProtocolError(
        'context-changed',
        'Snapshot row is outside its captured boundary'
      )
    const templates = this.installation.policy.snapshot(row, structuredClone(this.context))
    return this.group(
      this.identifier('snapshot', { session, watermark, key: row.key }),
      watermark,
      templates
    )
  }

  live(input: LookupIndexGroup): OutputSourceGroup | null {
    const group = this.index.group(input)
    const templates = this.installation.policy.transition(group, structuredClone(this.context))
    // No session, response limit or observation time enters live identity.
    return this.group(this.identifier('live', group.sequence), group.sequence, templates)
  }

  private group(
    id: string,
    sequence: string,
    input: LookupObservationTemplate[]
  ): OutputSourceGroup | null {
    try {
      return this.buildGroup(id, sequence, input)
    } catch (error) {
      if (error instanceof OutputProtocolError && error.code === 'limited')
        throw new LookupLimitError({ kind: 'permanent-group' })
      throw error
    }
  }

  private buildGroup(
    id: string,
    sequence: string,
    input: LookupObservationTemplate[]
  ): OutputSourceGroup | null {
    if (!Array.isArray(input))
      throw new OutputProtocolError('invalid', 'Lookup policy must return an observation array')
    if (input.length > 1024) throw new LookupLimitError({ kind: 'permanent-group' })
    if (input.length === 0) return null
    const templates = owned(input, 4194304) as unknown as LookupObservationTemplate[]
    const group: OutputSourceGroup = { id, sequence, observations: [] }
    let size = encodedBytes(canonicalOutputJSON(group))
    for (const template of templates) {
      closedOutputObject(template, ['kind', 'payload'], ['extensions', 'critical'])
      const observation = parseOutputObservation({
        ...template,
        id: id + ':' + group.observations.length,
        scope: this.context.scope
      })
      size +=
        encodedBytes(canonicalOutputJSON(observation)) + (group.observations.length === 0 ? 0 : 1)
      if (size > 4194304) throw new LookupLimitError({ kind: 'permanent-group' })
      group.observations.push(observation)
    }
    return group
  }
}

/** Installed selection rules and stable whole-group identities, independent of storage and HTTP. */
export class LookupQueryRegistry {
  private readonly installations = new Map<
    string,
    LookupQueryInstallation & LookupQueryDescription
  >()
  constructor(input: readonly LookupQueryInstallation[]) {
    if (input.length < 1 || input.length > 32)
      throw new OutputProtocolError('invalid', 'Install 1–32 lookup query policies')
    const ids = new Set<string>()
    for (const installation of input) {
      const id = outputString(installation.policy.id)
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(id) || ids.has(id))
        throw new OutputProtocolError('invalid', 'Invalid or duplicate lookup query policy')
      const prepared = parameters(
        installation.policy.parameters(parameters(installation.parameters))
      )
      const rules = { id, parameters: prepared }
      const rulesDigest = outputPacketDigest('service-rules', rules)
      this.installations.set(rulesDigest, {
        policy: installation.policy,
        parameters: prepared,
        rules,
        rulesDigest
      })
      ids.add(id)
    }
  }

  describe(): LookupQueryDescription[] {
    return [...this.installations.values()].map(({ rules, rulesDigest }) => ({
      rules: structuredClone(rules),
      rulesDigest
    }))
  }

  prepare(input: unknown, inputScope: OutputScope, inputPrincipal: string | null): LookupQueryView {
    const open = parseOutputLookupOpen(input)
    const scope = parseOutputScope(inputScope)
    const principal = inputPrincipal === null ? null : outputIdentity(inputPrincipal)
    const installation = this.installations.get(scope.rulesDigest)
    if (!installation)
      throw new OutputProtocolError('unsupported', 'Lookup selection rules are not installed')
    if (
      open.service !== scope.service ||
      (open.requiredRulesDigest !== undefined && open.requiredRulesDigest !== scope.rulesDigest) ||
      outputPacketDigest('lookup-query', { service: open.service, query: open.query }) !==
        scope.queryDigest
    )
      throw new OutputProtocolError('context-changed', 'Lookup query changed its retained scope')
    const query = owned(
      installation.policy.query(open.query, structuredClone(installation.parameters)),
      1048576
    )
    return new InstalledLookupQueryView(installation, {
      scope,
      principal,
      query,
      parameters: installation.parameters
    })
  }
}
