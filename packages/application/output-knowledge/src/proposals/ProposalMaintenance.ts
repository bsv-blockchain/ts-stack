import {
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputString,
  outputU64,
  parseOutputJSON,
  canonicalOutputJSON
} from '@bsv/sdk'
import type { ProposalJournalStorage } from './ProposalJournal.js'
import { proposalChannelKey } from './ProposalPolicyRegistry.js'

/** Trusted local work hint. Service methods independently reread and validate durable state. */
export interface ProposalMaintenanceItem {
  channelKey: string
  proposalId: string
  state: 'active' | 'finalizing'
}
export interface ProposalMaintenancePage {
  items: ProposalMaintenanceItem[]
  /** Local opaque continuation. Absence completes a bounded pass. */
  next?: string
}
/**
 * Interchangeable private maintenance inventory; contains identifiers, not signed
 * proposal payloads. A cursor is a scan hint and never grants service authority.
 * Each pass must terminate despite concurrent appends. Missing retained state
 * fails explicitly; an empty page must not disguise a reset or storage failure.
 */
export interface ProposalMaintenanceSource {
  readonly durability: 'durable'
  page(maximum: number, after?: string): Promise<ProposalMaintenancePage>
}

/** Bounded maintenance inventory over the existing append-only proposal journal. */
export class ProposalJournalMaintenance implements ProposalMaintenanceSource {
  readonly durability = 'durable' as const
  private readonly binding: string
  private readonly current: NonNullable<ProposalJournalStorage['getChannelEntry']>
  private readonly proposal: NonNullable<ProposalJournalStorage['getProposalEntry']>
  constructor(private readonly journal: ProposalJournalStorage) {
    outputAssert(journal.durability === 'durable', 'Proposal maintenance requires durable storage')
    outputAssert(
      typeof journal.getChannelEntry === 'function' &&
        typeof journal.getProposalEntry === 'function',
      'Proposal maintenance requires indexed retained records'
    )
    this.current = journal.getChannelEntry.bind(journal)
    this.proposal = journal.getProposalEntry.bind(journal)
    // Local cursor binding only, not a portable protocol digest or authority.
    this.binding = canonicalOutputJSON({
      namespace: outputString(journal.namespace),
      identity: outputString(journal.identity)
    })
  }
  async page(maximum: number, after?: string): Promise<ProposalMaintenancePage> {
    outputAssert(
      Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 256,
      'Invalid proposal maintenance page bound'
    )
    const head = outputU64((await this.journal.head()).revision)
    let through = head,
      position = 0n
    if (after !== undefined) {
      outputAssert(
        typeof after === 'string' && after.length <= 16384,
        'Invalid proposal maintenance cursor'
      )
      const cursor = parseOutputJSON(after, { bytes: 16384 })
      closedOutputObject(cursor, ['binding', 'through', 'after'])
      outputAssert(
        cursor.binding === this.binding,
        'Proposal maintenance cursor changed storage',
        'context-changed'
      )
      through = outputU64(cursor.through)
      position = outputU64(cursor.after)
      outputAssert(
        position <= through && through <= head,
        'Proposal maintenance cursor exceeds retained history',
        'context-changed'
      )
    }
    if (position === through) return { items: [] }
    const page = await this.journal.read(String(position), maximum)
    outputAssert(
      page.length > 0 && page.length <= maximum,
      'Proposal maintenance history is missing',
      'unavailable'
    )
    const items: ProposalMaintenanceItem[] = [],
      seen = new Set<string>()
    for (const entry of page) {
      const revision = outputU64(entry.revision)
      outputAssert(revision > position, 'Proposal maintenance history is unordered', 'unavailable')
      if (revision > through) {
        outputAssert(position === through, 'Proposal maintenance history is missing', 'unavailable')
        break
      }
      outputAssert(
        revision === position + 1n,
        'Proposal maintenance history has a gap',
        'unavailable'
      )
      position = revision
      const body = entry.transition.next.proposal.body
      const channelKey = proposalChannelKey(body)
      if (seen.has(channelKey)) continue
      seen.add(channelKey)
      const latest = await this.current(channelKey)
      outputAssert(latest !== undefined, 'Proposal maintenance channel is missing', 'unavailable')
      const record = latest.transition.next
      if (record.state.status !== 'active' && record.state.status !== 'finalizing') continue
      outputAssert(
        proposalChannelKey(record.proposal.body) === channelKey,
        'Proposal maintenance channel changed',
        'unavailable'
      )
      const proposalId = outputHex32(record.proposalId)
      // The indexed proposal must agree with the exact channel head from this read.
      // A concurrently changed index may be retried next pass; no work is authorized here.
      const retained = await this.proposal(proposalId)
      outputAssert(
        retained !== undefined,
        'Proposal maintenance proposal is missing',
        'unavailable'
      )
      if (retained.revision !== latest.revision) continue
      items.push({ channelKey, proposalId, state: record.state.status })
    }
    return {
      items,
      ...(position < through
        ? {
            next: canonicalOutputJSON({
              binding: this.binding,
              through: String(through),
              after: String(position)
            })
          }
        : {})
    }
  }
}
