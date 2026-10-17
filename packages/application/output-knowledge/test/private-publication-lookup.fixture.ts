import { PrivateKey, Utils } from '@bsv/sdk'
import {
  PrivatePublicationLookupContext,
  type PrivatePublicationLookupContextOptions
} from '../src/private/PrivatePublicationLookupContext.js'
import { privatePublicationOperation } from '../src/private/PrivatePublicationProgress.js'
import { verifiedFixture } from './private-verified-publication-fixture.js'
import { allow } from './private-publication-fixture.js'

/** Native protected ready records; actual SDK/Engine/HTTP admission is qualified separately. */
export function publicationLookupFixture() {
  const f = verifiedFixture(),
    initial = f.stage()
  f.store.advance(initial.publicationId, '1', { kind: 'reserve-admission' }, () => '20', allow)
  let saved = f.store.loadVerified(initial.publicationId, () => '20', allow)!
  f.store.advance(
    initial.publicationId,
    saved.record.revision,
    {
      kind: 'admitted',
      admission: {
        operationId: privatePublicationOperation(initial),
        txid: initial.txid,
        assessmentContextId: 'lookup-fixture-assessment',
        steak: {
          [initial.topic]: {
            outputsToAdmit: [initial.outputIndex],
            coinsToRetain: [],
            coinsRemoved: []
          }
        }
      }
    },
    () => '20',
    allow
  )
  saved = f.store.loadVerified(initial.publicationId, () => '20', allow)!
  f.store.bindVerified(initial.publicationId, saved.record.revision, () => '20', allow)
  const recipient = new PrivateKey(64).toPublicKey().toString()
  let allowed = true,
    current = true,
    maps = 0
  const options: PrivatePublicationLookupContextOptions = {
    domain: f.native.owner,
    store: f.store,
    topic: initial.topic,
    lookup: f.service.lookup,
    clock: () => '20',
    maximumContextBytes: 64,
    maximumResponseBytes: 1048576,
    authorize: (_reference, identity, publisher) =>
      allowed && identity === recipient && publisher === initial.publisher,
    mapContext: privateValues => {
      maps++
      return privateValues
    }
  }
  return {
    ...f,
    initial,
    recipient,
    options,
    reader: new PrivatePublicationLookupContext(options),
    caller: { recipient, current: () => current },
    answer() {
      return {
        type: 'output-list',
        outputs: [
          {
            beef: Utils.toArray(f.contract.request.evidence.beef, 'base64'),
            outputIndex: initial.outputIndex,
            context: [1, 2, 3]
          }
        ]
      }
    },
    get maps() {
      return maps
    },
    revoke() {
      allowed = false
    },
    grant() {
      allowed = true
    },
    disconnect() {
      current = false
    },
    reopenReader() {
      const { owner, store } = f.reopenWithDomain()
      return new PrivatePublicationLookupContext({ ...options, domain: owner, store })
    }
  }
}
