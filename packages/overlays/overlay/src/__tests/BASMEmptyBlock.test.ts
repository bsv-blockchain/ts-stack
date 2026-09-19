import { BASM_ZERO_HASH, computeBasmRoot, computeTac } from '../BASM'
import type { TopicBlockAnchor } from '../BASM'
import { blockHash, blockHeight, fixture, topic } from './BASMReconciliationFixture'

afterEach(() => jest.restoreAllMocks())

// BRC-136: "Empty topic at this height. If k = 0, then R = 0x00…00 (32 zero bytes)."
// A peer anchors every height, so most anchors a lagging node sees admit nothing.
describe('BASM reconciliation of heights where the topic admitted nothing', () => {
  const localHeight = blockHeight - 1
  const localHash = 'cd'.repeat(32)

  function emptyHeightFixture() {
    const f = fixture()
    const localAnchor: TopicBlockAnchor = {
      topic,
      blockHeight: localHeight,
      blockHash: localHash,
      basmRoot: BASM_ZERO_HASH,
      admittedCount: 0,
      tac: computeTac(BASM_ZERO_HASH, localHash, BASM_ZERO_HASH)
    }
    const emptyAnchor: TopicBlockAnchor = {
      topic,
      blockHeight,
      blockHash,
      basmRoot: BASM_ZERO_HASH,
      admittedCount: 0,
      tac: computeTac(localAnchor.tac, blockHash, BASM_ZERO_HASH)
    }
    f.storage.findTopicAnchorTip.mockResolvedValue({
      topic,
      blockHeight: localHeight,
      tac: localAnchor.tac
    })
    f.storage.findTopicBlockAnchor.mockImplementation(async (...args: unknown[]) =>
      args[1] === localHeight ? localAnchor : undefined
    )
    f.engine.topicAnchorHeaderResolver = jest.fn(async (height: number) => ({
      blockHeight: height,
      blockHash: height === localHeight ? localHash : blockHash,
      merkleRoot: f.root
    }))
    f.responses['/requestTopicAnchorTip'] = emptyAnchor
    f.responses['/requestTopicAnchorRange'] = { topic, anchors: [emptyAnchor] }
    f.responses['/requestAdmittedList'] = { topic, blockHeight, blockHash, admitted: [] }
    return { f, emptyAnchor }
  }

  it('defines the empty BASM root as 32 zero bytes', () => {
    expect(computeBasmRoot([])).toBe(BASM_ZERO_HASH)
  })

  it('checks an empty height without requesting a proof or raw transactions', async () => {
    const { f } = emptyHeightFixture()
    const [report] = await f.engine.startBASMSync()
    expect(report.message).toBeUndefined()
    expect(report.status).not.toBe('error')
    expect(report.status).not.toBe('diverged')
    expect(report.checkedHeights).toEqual([blockHeight])
    expect(report.missingTxids).toEqual([])
    const paths = f.requests.map(request => request.path)
    expect(paths).not.toContain('/requestCompoundMerklePath')
    expect(paths).not.toContain('/requestRawTransactions')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('reports divergence when the peer claims an empty height that is populated locally', async () => {
    const { f } = emptyHeightFixture()
    f.storage.findAdmittedTransactionsForBlock.mockResolvedValue([
      { txid: f.ids[1], blockIndex: 1 }
    ])
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('diverged')
    expect(f.requests.map(request => request.path)).not.toContain('/requestCompoundMerklePath')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('still rejects a zero-count anchor whose root is not the zero hash', async () => {
    const { f, emptyAnchor } = emptyHeightFixture()
    const forged = { ...emptyAnchor, basmRoot: 'ee'.repeat(32) }
    forged.tac = computeTac(
      computeTac(BASM_ZERO_HASH, localHash, BASM_ZERO_HASH),
      blockHash,
      forged.basmRoot
    )
    f.responses['/requestTopicAnchorTip'] = forged
    f.responses['/requestTopicAnchorRange'] = { topic, anchors: [forged] }
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.message).toContain('inconsistent with its anchor')
  })
})
