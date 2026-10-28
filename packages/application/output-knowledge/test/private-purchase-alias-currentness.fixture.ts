import { type OutputPurchaseSubmit } from '@bsv/sdk'
import { SDKPrivatePurchaseAliasCurrentness } from '../src/private/SDKPrivatePurchaseAliasCurrentness.js'
import type { ChainViewResolver } from '../src/SDKEvidenceVerifier.js'
import { candidate, chain, context, corpus, resolver } from './evidence-fixture.js'

/** Real Script/SPV evidence in a small proof-of-work-checked fixture ancestry.
 * This fixture tests only the chain adapter. It makes no BRC197 purchase-domain,
 * lineage, native-custody, topical-admission, production-mining or rights claim. */
export function aliasCurrentnessFixture() {
  const acquisitionId = 'ad'.repeat(32)
  let selected = 'included',
    generation = 0,
    contexts = 0,
    resolutions = 0
  let available = true
  const selection = {
    async context() {
      contexts++
      const snapshot = context(selected)
      snapshot.id += '-' + generation
      await Promise.resolve()
      return snapshot
    },
    current(snapshot: ReturnType<typeof context>) {
      return snapshot.id === 'verification-' + selected + '-' + generation
    }
  }
  const chains: ChainViewResolver = {
    async resolve(view, signal) {
      resolutions++
      if (!available) throw new Error('Historical fixture ancestry unavailable')
      return resolver.resolve(view, signal)
    }
  }
  function submit(mined = true): OutputPurchaseSubmit {
    const evidence = mined
      ? { txid: corpus.transactions[corpus.inclusion.name].txid, beef: corpus.inclusion.beef }
      : candidate(corpus.inclusion.name).evidence
    return { version: 1, acquisitionId, txid: evidence.txid, beef: evidence.beef }
  }
  const subject = { acquisitionId, chain: structuredClone(chain) }
  return {
    subject,
    selection,
    chains,
    adapter: new SDKPrivatePurchaseAliasCurrentness(chains, selection),
    submit,
    select(id: 'included' | 'fork' | 'base') {
      selected = id
      generation++
    },
    available(value: boolean) {
      available = value
    },
    counts() {
      return { contexts, resolutions }
    }
  }
}
