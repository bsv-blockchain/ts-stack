import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalOutputJSON } from '@bsv/sdk'
import { ProposalTransitions } from '../src/proposals/ProposalTransitions.js'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { proposalChannelKey } from '../src/proposals/ProposalPolicyRegistry.js'
import { author, createRegistry, scope, signed } from './proposal-fixture.js'

export async function proposalSendFixture() {
  const registry = createRegistry()
  const directory = mkdtempSync(join(tmpdir(), 'proposal-send-'))
  const file = join(directory, 'journal.sqlite')
  const lifecycle = new ProposalTransitions(registry, scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
  const first = lifecycle.put(undefined, signed(), author, '10')
  const next = lifecycle.put(
    first.next,
    signed({ revision: '1', previous: first.next.proposalId }),
    author,
    '11'
  )
  const stores: SQLiteProposalJournal[] = []
  const open = () => {
    const value = new SQLiteProposalJournal(file, 'send-test', author, lifecycle)
    stores.push(value)
    return value
  }
  const store = open()
  await store.commit(first)
  return {
    store,
    first,
    next,
    lifecycle,
    file,
    directory,
    open,
    channel: { kind: 'channel' as const, channelKey: proposalChannelKey(first.next.proposal.body) },
    proposal: { kind: 'proposal' as const, proposalId: first.next.proposalId },
    bytes: new TextEncoder().encode(
      canonicalOutputJSON({ proposal: first.next.proposal, state: first.next.state })
    ),
    async close() {
      await Promise.all(stores.map(value => value.close()))
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
