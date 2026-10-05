import assert from 'node:assert/strict'
import test from 'node:test'
import { createMandalaEngineOutputs } from './mandalaEngineOutputs.js'

test('reads unspent admitted outputs and pages them in outpoint order', async () => {
  const storage = {
    async findOutput(txid: string, outputIndex: number, topic?: string, spent?: boolean) {
      assert.equal(topic, 'tm_mandala')
      assert.equal(spent, false)
      if (txid === 'aa' && outputIndex === 1) {
        return { txid, outputIndex, outputScript: [1, 2], satoshis: 1 }
      }
      return null
    },
    async findUTXOsForTopic(topic: string) {
      assert.equal(topic, 'tm_mandala')
      return [
        { txid: 'bb', outputIndex: 0, outputScript: [9], satoshis: 1 },
        { txid: 'aa', outputIndex: 2, outputScript: [8], satoshis: 1 },
        { txid: 'aa', outputIndex: 1, outputScript: [7], satoshis: 1 }
      ]
    }
  }
  let ready = false
  const outputs = createMandalaEngineOutputs(() => {
    if (!ready) throw new Error('engine unavailable')
    return storage
  })

  await assert.rejects(outputs.findAdmittedOutput('aa', 1, 'tm_mandala'), /engine unavailable/)
  ready = true
  assert.deepEqual(await outputs.findAdmittedOutput('aa', 1, 'tm_mandala'), {
    lockingScript: [1, 2],
    satoshis: 1
  })
  assert.equal(await outputs.findAdmittedOutput('missing', 0, 'tm_mandala'), null)
  assert.deepEqual(await outputs.listUnspentAdmittedOutputs('tm_mandala', null, 2), [
    { txid: 'aa', outputIndex: 1 },
    { txid: 'aa', outputIndex: 2 }
  ])
  assert.deepEqual(
    await outputs.listUnspentAdmittedOutputs('tm_mandala', { txid: 'aa', outputIndex: 2 }, 2),
    [{ txid: 'bb', outputIndex: 0 }]
  )
})
