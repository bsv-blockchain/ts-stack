import { Engine } from '../Engine'
import type { Storage } from '../storage/Storage'

const topic = 'tm_basm_guards'
const txid = 'ab'.repeat(32)

/** A storage backend that implements none of the optional BASM read methods. */
const engineWithout = (methods: Record<string, unknown> = {}): Engine =>
  new Engine({}, {}, methods as unknown as Storage, 'scripts only')

const expectUnsupported = async (operation: Promise<unknown>, message: string): Promise<void> => {
  await expect(operation).rejects.toThrow(TypeError)
  await expect(operation).rejects.toThrow(message)
  await expect(operation).rejects.toMatchObject({ code: 'BASM_UNSUPPORTED' })
}

describe('BASM provider capability guards', () => {
  it('refuses to serve a topic anchor tip without findTopicAnchorTip', async () => {
    await expectUnsupported(
      engineWithout().provideTopicAnchorTip(topic),
      'Storage does not support BASM topic anchor tips'
    )
  })

  it('refuses to serve a topic anchor range without findTopicBlockAnchors', async () => {
    await expectUnsupported(
      engineWithout().provideTopicAnchorRange(topic, 0, 0),
      'Storage does not support BASM topic anchor ranges'
    )
  })

  it('refuses to serve an admitted list without findAdmittedTransactionsForBlock', async () => {
    await expectUnsupported(
      engineWithout().provideAdmittedList(topic, 100),
      'Storage does not support BASM admitted lists'
    )
  })

  it('refuses to serve a compound Merkle path without findTransactionMerklePaths', async () => {
    await expectUnsupported(
      engineWithout().provideCompoundMerklePath(topic, 100, [txid]),
      'Storage does not support direct Merkle path lookup'
    )
  })

  it('refuses to serve raw transactions without findRawTransactions', async () => {
    await expectUnsupported(
      engineWithout().provideRawTransactions([txid]),
      'Storage does not support raw transaction lookup'
    )
  })

  it('checks capability before the empty-txid guard on compound Merkle paths', async () => {
    // Order matters: an unsupported backend must report BASM_UNSUPPORTED rather
    // than the argument-shape error a caller could mistake for a bad request.
    await expectUnsupported(
      engineWithout().provideCompoundMerklePath(topic, 100, []),
      'Storage does not support direct Merkle path lookup'
    )
  })

  it('still serves a tip and a range once the backend supports them', async () => {
    const engine = engineWithout({
      findTopicAnchorTip: jest.fn(async () => undefined),
      findTopicBlockAnchors: jest.fn(async () => [])
    })
    await expect(engine.provideTopicAnchorTip(topic)).resolves.toEqual({
      topic,
      blockHeight: -1,
      tac: '00'.repeat(32)
    })
    await expect(engine.provideTopicAnchorRange(topic, 5, 7)).resolves.toEqual({
      topic,
      anchors: []
    })
  })
})
