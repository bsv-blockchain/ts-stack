import { BASM_ZERO_HASH } from '../BASM'
import { blockHash, blockHeight, fixture, topic } from './BASMReconciliationFixture'

afterEach(() => jest.restoreAllMocks())

describe('BASM reconciliation when the peer is not ahead', () => {
  it('matches two empty topics without asking the peer for anchors', async () => {
    const f = fixture()
    f.responses['/requestTopicAnchorTip'] = { topic, blockHeight: -1, tac: BASM_ZERO_HASH }
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('matched')
    expect(report.message).toBe('Topic anchor tips match')
    expect(report.localTip).toEqual({ topic, blockHeight: -1, tac: BASM_ZERO_HASH })
    expect(report.remoteTip).toEqual({ topic, blockHeight: -1, tac: BASM_ZERO_HASH })
    // An empty remote tip has no anchor to cross-check, so the range endpoint
    // must not be called and no local anchor lookup may happen either.
    expect(f.requests.map(request => request.path)).toEqual(['/requestTopicAnchorTip'])
    expect(f.storage.findTopicBlockAnchor).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('re-verifies the local anchor behind an equal, matching tip', async () => {
    const f = fixture()
    f.storage.findTopicAnchorTip.mockResolvedValue({ topic, blockHeight, tac: f.anchor.tac })
    f.storage.findTopicBlockAnchor.mockResolvedValue(f.anchor)
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('matched')
    expect(report.message).toBe('Topic anchor tips match')
    expect(f.storage.findTopicBlockAnchor).toHaveBeenCalledWith(topic, blockHeight)
    expect(f.engine.topicAnchorHeaderResolver).toHaveBeenCalledWith(blockHeight)
    expect(f.requests.some(request => request.path === '/requestAdmittedList')).toBe(false)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('reports historical divergence when the local tip is ahead with a different TAC', async () => {
    const f = fixture()
    f.storage.findTopicAnchorTip.mockResolvedValue({
      topic,
      blockHeight: blockHeight + 1,
      tac: 'cd'.repeat(32)
    })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('diverged')
    expect(report.message).toContain('Remote tip is not ahead')
    // Divergence is not an anchor failure: the local tip is never re-verified.
    expect(f.storage.findTopicBlockAnchor).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('fails closed when the local tip has no stored anchor', async () => {
    const f = fixture()
    f.storage.findTopicAnchorTip.mockResolvedValue({ topic, blockHeight, tac: f.anchor.tac })
    f.storage.findTopicBlockAnchor.mockResolvedValue(undefined)
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.errorCode).toBe('BASM_INVALID_RESPONSE')
    expect(report.message).toBe('Local BASM tip lacks its anchor')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('fails closed when the backend reports a tip it cannot produce an anchor for', async () => {
    const f = fixture()
    f.storage.findTopicAnchorTip.mockResolvedValue({ topic, blockHeight, tac: f.anchor.tac })
    // A backend with tip support but no per-block anchor lookup must not have
    // its equal-height tip accepted on the peer's word alone.
    delete (f.storage as { findTopicBlockAnchor?: unknown }).findTopicBlockAnchor
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.errorCode).toBe('BASM_INVALID_RESPONSE')
    expect(report.message).toBe('Local BASM tip lacks its anchor')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('fails closed when the stored anchor disagrees with the local tip TAC', async () => {
    const f = fixture()
    f.storage.findTopicAnchorTip.mockResolvedValue({ topic, blockHeight, tac: f.anchor.tac })
    f.storage.findTopicBlockAnchor.mockResolvedValue({ ...f.anchor, tac: 'ef'.repeat(32) })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.errorCode).toBe('BASM_INVALID_RESPONSE')
    expect(report.message).toBe('Local BASM tip lacks its anchor')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('fails closed when the equal-height local anchor is not canonical', async () => {
    const f = fixture()
    f.storage.findTopicAnchorTip.mockResolvedValue({ topic, blockHeight, tac: f.anchor.tac })
    f.storage.findTopicBlockAnchor.mockResolvedValue(f.anchor)
    f.engine.topicAnchorHeaderResolver = async height => ({
      blockHeight: height,
      blockHash: 'cd'.repeat(32)
    })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.message).toBe('BASM anchor block hash is not canonical')
    expect(f.submit).not.toHaveBeenCalled()
  })
})

describe('BASM reconciliation outcome reporting', () => {
  it('reports "matched" when the admitted page brings the local tip up to the remote tip', async () => {
    const f = fixture()
    f.storage.findTopicAnchorTip
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ topic, blockHeight, tac: f.anchor.tac, blockHash })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('matched')
    expect(report.fetchedTxCount).toBe(2)
    expect(report.localTip).toEqual({ topic, blockHeight, tac: f.anchor.tac, blockHash })
    expect(f.submit).toHaveBeenCalledTimes(2)
  })

  it('reports "advanced" when the local tip still trails after the page is applied', async () => {
    const f = fixture()
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('advanced')
    expect(report.localTip).toEqual({ topic, blockHeight: -1, tac: BASM_ZERO_HASH })
    expect(f.submit).toHaveBeenCalledTimes(2)
  })

  it('stringifies a non-Error failure without inventing an error code', async () => {
    const f = fixture()
    f.storage.findTopicAnchorTip.mockRejectedValue('peer storage is offline')
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.message).toBe('peer storage is offline')
    expect(report.errorCode).toBeUndefined()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('surfaces a BASM_UNSUPPORTED storage gap as a classified sync error', async () => {
    const f = fixture()
    // A backend that cannot answer tip queries at all.
    delete (f.storage as { findTopicAnchorTip?: unknown }).findTopicAnchorTip
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.errorCode).toBe('BASM_UNSUPPORTED')
    expect(report.message).toBe('Storage does not support BASM topic anchor tips')
    expect(f.submit).not.toHaveBeenCalled()
  })
})
