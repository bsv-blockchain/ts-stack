import { OutputProtocolError } from '@bsv/sdk'
import { LookupResponseDisclosure } from '../src/lookup/LookupResponseDisclosure.js'
import { providerFixture } from './lookup-provider-fixture.js'
export async function lookupSendServiceFixture() {
  const f = await providerFixture('brc103')
  const access = { allowed: true, control: true }
  const disclosure = new LookupResponseDisclosure({
    sessions: f.sessions,
    contracts: f.contracts,
    authorize: async context => {
      if (!access.allowed) throw new OutputProtocolError('unauthorized', 'Denied')
      return {
        access: context.principal!,
        guards: [
          { id: 'serving', revision: await f.sessions.guard('serving'), failure: 'unauthorized' }
        ]
      }
    },
    authorizeControl: () => access.control
  })
  const response = await f.service.open(f.open, f.caller)
  return { ...f, access, disclosure, response, bytes: new TextEncoder().encode(response.body) }
}
