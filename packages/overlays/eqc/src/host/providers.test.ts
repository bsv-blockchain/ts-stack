import { Utils, type LookupAnswer } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { sampleBeef } from '../../test/support/transactions.js'
import { HostError } from '../protocol/errors.js'
import { decodeOutpointList } from '../protocol/payloads.js'
import type { EconomicQuery } from '../protocol/query.js'
import { bytesProvider, messageListProvider, overlayLookupProvider } from './providers.js'

const client = `02${'ab'.repeat(32)}`
const context = { clientIdentityKey: client }

function query(type: string, params: Record<string, unknown>): EconomicQuery {
  return {
    type,
    client,
    params,
    maxFeeSats: 2000,
    floorFeeSats: 1000,
    threshold: 3,
    topK: 5,
    raceMs: 400,
    expires: '2026-09-18T19:05:00.000Z',
    nonce: '11'.repeat(32)
  }
}

async function failure(promise: Promise<unknown>): Promise<HostError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof HostError) return error
    throw error
  }
  throw new Error('Expected a HostError')
}

describe('overlayLookupProvider', () => {
  const first = sampleBeef(1)
  const second = sampleBeef(2)
  const answer: LookupAnswer = {
    type: 'output-list',
    outputs: [
      { beef: second.beef, outputIndex: 0 },
      { beef: first.beef, outputIndex: 0 }
    ]
  }

  it('returns sorted outpoints, a BEEF supplement, and anchors for configured topics', async () => {
    const provider = overlayLookupProvider({
      engine: {
        lookup: async () => answer,
        provideTopicAnchorTip: async topic => ({ topic, blockHeight: 900, tac: 'cd'.repeat(32) })
      },
      anchorTopics: { ls_example: ['tm_example'] }
    })
    expect(provider.type).toBe('overlay-lookup')
    const result = await provider.execute(
      query('overlay-lookup', { service: 'ls_example', query: { key: 'value' } }),
      context
    )
    expect(decodeOutpointList(result.payload).map(entry => entry.txid)).toEqual(
      [first.txid, second.txid].sort()
    )
    expect(result.supplement?.length).toBeGreaterThan(0)
    expect(result.extensions?.anchors).toEqual([
      { topic: 'tm_example', blockHeight: 900, tac: 'cd'.repeat(32) }
    ])
  })

  it('omits anchors when the engine lacks BASM or the tip lookup fails', async () => {
    const plain = overlayLookupProvider({
      engine: { lookup: async () => answer },
      anchorTopics: { ls_example: ['tm_example'] }
    })
    const failing = overlayLookupProvider({
      engine: {
        lookup: async () => answer,
        provideTopicAnchorTip: async () => {
          throw new Error('BASM_UNSUPPORTED')
        }
      },
      anchorTopics: { ls_example: ['tm_example'] }
    })
    const request = query('overlay-lookup', { service: 'ls_example', query: {} })
    expect((await plain.execute(request, context)).extensions).toBeUndefined()
    expect((await failing.execute(request, context)).extensions).toBeUndefined()
  })

  it('passes the question through and rejects bad parameters and freeform answers', async () => {
    const questions: unknown[] = []
    const provider = overlayLookupProvider({
      engine: {
        lookup: async question => {
          questions.push(question)
          return { type: 'freeform' }
        }
      }
    })
    const freeform = await failure(
      provider.execute(query('overlay-lookup', { service: 'ls_x', query: 7 }), context)
    )
    expect(freeform.status).toBe(422)
    expect(freeform.code).toBe('ERR_UNSUPPORTED_CLASS')
    expect(questions).toEqual([{ service: 'ls_x', query: 7 }])
    const invalid = await failure(provider.execute(query('overlay-lookup', { query: 7 }), context))
    expect(invalid.status).toBe(400)
  })
})

describe('messageListProvider', () => {
  const provider = messageListProvider({
    listMessages: async (recipient, messageBox) => [
      { messageId: 'b', sender: recipient, body: messageBox },
      { messageId: 'a', sender: recipient, body: messageBox }
    ]
  })

  it('serves the caller its own canonical list', async () => {
    const result = await provider.execute(
      query('message-list', { recipient: client, messageBox: 'payment_inbox' }),
      context
    )
    expect(Utils.toUTF8(result.payload)).toBe(
      `[{"messageId":"a","sender":"${client}","body":"payment_inbox"},` +
        `{"messageId":"b","sender":"${client}","body":"payment_inbox"}]`
    )
  })

  it("refuses to list another identity's inbox", async () => {
    const other = `03${'cd'.repeat(32)}`
    const error = await failure(
      provider.execute(query('message-list', { recipient: other, messageBox: 'inbox' }), context)
    )
    expect(error.status).toBe(403)
    expect(error.code).toBe('ERR_FORBIDDEN_RECIPIENT')
  })

  it('rejects a missing message box', async () => {
    const error = await failure(
      provider.execute(query('message-list', { recipient: client }), context)
    )
    expect(error.status).toBe(400)
  })
})

describe('bytesProvider', () => {
  it('returns resolver bytes and rejects unknown keys', async () => {
    const provider = bytesProvider('relay-lookup', async params =>
      params.key === 'known' ? [1, 2, 3] : undefined
    )
    expect(provider.type).toBe('relay-lookup')
    expect(
      (await provider.execute(query('relay-lookup', { key: 'known' }), context)).payload
    ).toEqual([1, 2, 3])
    const error = await failure(provider.execute(query('relay-lookup', { key: 'other' }), context))
    expect(error.status).toBe(400)
  })
})
