import {
  GASP,
  type GASPInitialResponse,
  type GASPNode,
  type GASPOutput,
  type GASPRemote,
  type GASPStorage,
  LogLevel
} from '../GASP'
import { Transaction } from '@bsv/sdk'

const rawTx = '01000000000000000000'
const rawTxid = Transaction.fromHex(rawTx).id('hex')
const validGraphID = `${rawTxid}.0`

function node(overrides: Partial<GASPNode> = {}): GASPNode {
  return {
    graphID: validGraphID,
    rawTx,
    outputIndex: 0,
    ...overrides
  }
}

function inputMap(size: number): Record<string, { hash: string }> {
  return Object.fromEntries(
    Array.from({ length: size }, (_, outputIndex) => [
      `${rawTxid}.${outputIndex}`,
      { hash: 'hash' }
    ])
  )
}

function requestMap(size: number): Record<string, { metadata: boolean }> {
  return Object.fromEntries(
    Array.from({ length: size }, (_, outputIndex) => [
      `${rawTxid}.${outputIndex}`,
      { metadata: true }
    ])
  )
}

function storage(overrides: Partial<GASPStorage> = {}): GASPStorage {
  return {
    findKnownUTXOs: jest.fn().mockResolvedValue([]),
    hydrateGASPNode: jest.fn(),
    findNeededInputs: jest.fn().mockResolvedValue(undefined),
    appendToGraph: jest.fn().mockResolvedValue(undefined),
    validateGraphAnchor: jest.fn().mockResolvedValue(undefined),
    discardGraph: jest.fn().mockResolvedValue(undefined),
    finalizeGraph: jest.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

function remote(overrides: Partial<GASPRemote> = {}): GASPRemote {
  return {
    getInitialResponse: jest.fn().mockResolvedValue({ since: 0, UTXOList: [] }),
    getInitialReply: jest.fn(),
    requestNode: jest.fn(),
    submitNode: jest.fn(),
    ...overrides
  }
}

function gasp(local: GASPStorage, foreign: GASPRemote): GASP {
  return new GASP(local, foreign, 0, '[security] ', false, true, LogLevel.NONE)
}

describe('GASP hostile-peer boundary', () => {
  it.each([
    [{ since: 0, UTXOList: [{ txid: '__proto__', outputIndex: 0, score: 1 }] }, 'txid'],
    [{ since: 0, UTXOList: [{ txid: 'aa', outputIndex: -1, score: 1 }] }, 'output index'],
    [{ since: 0, UTXOList: [{ txid: 'aa', outputIndex: 0, score: -1 }] }, 'score'],
    [
      {
        since: 0,
        UTXOList: [
          { txid: 'aa', outputIndex: 0, score: 1 },
          { txid: 'aa', outputIndex: 0, score: 1 }
        ]
      },
      'Duplicate'
    ]
  ])('rejects malformed initial responses before graph processing', async (response, message) => {
    const processNode = jest.fn()
    const protocol = gasp(
      storage(),
      remote({
        getInitialResponse: jest.fn().mockResolvedValue(response),
        requestNode: processNode
      })
    )

    await expect(protocol.sync('peer.example', 10)).rejects.toThrow(message)
    expect(processNode).not.toHaveBeenCalled()
  })

  it('terminates a full page that cannot advance its pagination score', async () => {
    const response: GASPInitialResponse = {
      since: 0,
      UTXOList: [{ txid: 'aa', outputIndex: 0, score: 0 }]
    }
    const protocol = gasp(
      storage(),
      remote({
        getInitialResponse: jest.fn().mockResolvedValue(response),
        requestNode: jest.fn().mockRejectedValue(new Error('unavailable'))
      })
    )

    await expect(protocol.sync('peer.example', 1)).rejects.toThrow('without advancing')
  })

  it('does not commit a peer watermark when graph validation fails', async () => {
    const local = storage({
      validateGraphAnchor: jest.fn().mockRejectedValue(new Error('invalid anchor'))
    })
    const protocol = gasp(
      local,
      remote({
        getInitialResponse: jest.fn().mockResolvedValue({
          since: 0,
          UTXOList: [{ txid: rawTxid, outputIndex: 0, score: 999 }]
        }),
        requestNode: jest.fn().mockResolvedValue({
          graphID: `${rawTxid}.0`,
          rawTx,
          outputIndex: 0
        })
      })
    )

    await protocol.sync('peer.example', 10)
    expect(protocol.lastInteraction).toBe(0)
    expect(local.discardGraph).toHaveBeenCalledWith(`${rawTxid}.0`)
  })

  it('caps peer graph work at eight concurrent node requests', async () => {
    let active = 0
    let peak = 0
    const outputs = Array.from({ length: 20 }, (_, outputIndex) => ({
      txid: `tx_${outputIndex}`,
      outputIndex,
      score: outputIndex + 1
    }))
    const requestNode = jest.fn(
      async (graphID: string, _txid: string, outputIndex: number): Promise<GASPNode> => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 1))
        active--
        return { graphID, rawTx, outputIndex }
      }
    )
    const protocol = gasp(
      storage(),
      remote({
        getInitialResponse: jest.fn().mockResolvedValue({ since: 0, UTXOList: outputs }),
        requestNode
      })
    )

    await protocol.sync('peer.example', 100)
    expect(requestNode).toHaveBeenCalledTimes(20)
    expect(peak).toBeLessThanOrEqual(8)
  })

  it('rejects nodes and requested-input maps that are not correlated and canonical', async () => {
    const local = storage({
      hydrateGASPNode: jest.fn().mockResolvedValue({
        graphID: 'other.0',
        rawTx,
        outputIndex: 0
      }),
      findNeededInputs: jest.fn().mockResolvedValue({
        requestedInputs: { 'parent.0.extra': { metadata: true } }
      })
    })
    const protocol = gasp(local, remote())

    await expect(protocol.requestNode('root.0', 'root', 0, true)).rejects.toThrow('does not match')
    await expect(protocol.submitNode({ graphID: 'root.0', rawTx, outputIndex: 0 })).rejects.toThrow(
      'Invalid GASP outpoint'
    )
  })

  it('rejects malformed and oversized UTXO lists before iterating their entries', async () => {
    const protocol = gasp(storage(), remote())
    const validOutput = { txid: rawTxid, outputIndex: 0, score: 0 }

    await expect(protocol.getInitialReply(null as unknown as GASPInitialResponse)).rejects.toThrow(
      'Invalid initial response format'
    )
    await expect(
      protocol.getInitialReply({ since: 0, UTXOList: null as unknown as GASPOutput[] })
    ).rejects.toThrow('Invalid or oversized UTXO list format')
    await expect(
      protocol.getInitialReply({
        since: 0,
        UTXOList: Array.from({ length: 10_001 }, () => validOutput)
      })
    ).rejects.toThrow('Invalid or oversized UTXO list format')
    await expect(
      protocol.getInitialReply({
        since: 0,
        UTXOList: [null as unknown as GASPOutput]
      })
    ).rejects.toThrow('Invalid UTXO at index 0')
  })

  it.each([
    [node({ rawTx: '' }), 'GASP raw transaction is invalid'],
    [node({ rawTx: 'not-hex' }), 'GASP node raw transaction is invalid'],
    [node({ outputIndex: -1 }), 'GASP node output index is invalid'],
    [node({ proof: '' }), 'GASP node proof is invalid'],
    [node({ txMetadata: 1 as unknown as string }), 'GASP node txMetadata is invalid'],
    [node({ outputMetadata: '' }), 'GASP node outputMetadata is invalid'],
    [
      node({ inputs: [] as unknown as Record<string, { hash: string }> }),
      'Invalid GASP node input metadata'
    ],
    [node({ inputs: inputMap(10_001) }), 'Invalid GASP node input metadata'],
    [
      node({ inputs: { [validGraphID]: null as unknown as { hash: string } } }),
      'Invalid GASP node input metadata'
    ],
    [
      node({ inputs: { [validGraphID]: { hash: '' } } }),
      'GASP node input metadata hash is invalid'
    ],
    [node({ inputs: { [`${rawTxid}.0.extra`]: { hash: 'hash' } } }), 'Invalid GASP outpoint']
  ])('rejects malformed node fields with precise errors', async (invalidNode, message) => {
    const protocol = gasp(storage(), remote())

    await expect(protocol.submitNode(invalidNode)).rejects.toThrow(message)
  })

  it('rejects non-object nodes and every request-correlation mismatch', async () => {
    await expect(gasp(storage(), remote()).submitNode(null as unknown as GASPNode)).rejects.toThrow(
      'Invalid GASP node format'
    )

    const graphMismatch = gasp(
      storage({ hydrateGASPNode: jest.fn().mockResolvedValue(node({ graphID: `${rawTxid}.1` })) }),
      remote()
    )
    await expect(graphMismatch.requestNode(validGraphID, rawTxid, 0, true)).rejects.toThrow(
      'GASP node graphID does not match the request'
    )

    const outputMismatch = gasp(
      storage({ hydrateGASPNode: jest.fn().mockResolvedValue(node({ outputIndex: 1 })) }),
      remote()
    )
    await expect(outputMismatch.requestNode(validGraphID, rawTxid, 0, true)).rejects.toThrow(
      'GASP node output index does not match the request'
    )

    const transactionMismatch = gasp(
      storage({ hydrateGASPNode: jest.fn().mockResolvedValue(node()) }),
      remote()
    )
    await expect(transactionMismatch.requestNode(validGraphID, 'aa', 0, true)).rejects.toThrow(
      'GASP node transaction does not match the requested txid'
    )
  })

  it.each([
    [null, 'Invalid GASP node response'],
    [{ requestedInputs: [] }, 'Invalid GASP node response'],
    [{ requestedInputs: requestMap(10_001) }, 'Oversized GASP node response'],
    [{ requestedInputs: { [validGraphID]: null } }, 'Invalid GASP requested input'],
    [{ requestedInputs: { [validGraphID]: { metadata: 'yes' } } }, 'Invalid GASP requested input'],
    [{ requestedInputs: { [`${rawTxid}.0.extra`]: { metadata: true } } }, 'Invalid GASP outpoint']
  ])('rejects malformed requested-input responses precisely', async (response, message) => {
    const local = storage({
      findNeededInputs: jest.fn().mockResolvedValue(response)
    })

    await expect(gasp(local, remote()).submitNode(node())).rejects.toThrow(message)
  })
})
