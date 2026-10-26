import { GraphNode, OverlayGASPStorage } from '../GASP/OverlayGASPStorage'
import { Transaction, MerklePath, Script, UnlockingScript } from '@bsv/sdk'
import { GASPNode } from '@bsv/gasp'

describe('OverlayGASPStorage', () => {
  let overlayStorage: OverlayGASPStorage
  let mockEngine: any

  beforeEach(() => {
    mockEngine = {
      storage: { findOutput: jest.fn(() => undefined), findUTXOsForTopic: jest.fn() },
      managers: {}
    }
    overlayStorage = new OverlayGASPStorage('test-topic', mockEngine)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    ['an empty topic', '', undefined, undefined, 'GASP storage topic is invalid'],
    ['a zero node limit', 'test-topic', 0, undefined, 'maxNodesInGraph'],
    ['a fractional node limit', 'test-topic', 1.5, undefined, 'maxNodesInGraph'],
    ['an excessive node limit', 'test-topic', 100_001, undefined, 'maxNodesInGraph'],
    ['a zero byte limit', 'test-topic', 1, 0, 'maxBytesInGraph'],
    ['a fractional byte limit', 'test-topic', 1, 1.5, 'maxBytesInGraph']
  ])('rejects %s before retaining graph state', (_label, topic, nodeLimit, byteLimit, message) => {
    expect(() => new OverlayGASPStorage(topic, mockEngine, nodeLimit, byteLimit)).toThrow(
      message as string
    )
  })

  it('reserves queued semaphore slots before admitting new work', async () => {
    const storageClass = OverlayGASPStorage as any
    storageClass.activeAnchorValidations = 0
    storageClass.anchorValidationQueue.length = 0

    await Promise.all(
      Array.from({ length: 4 }, async () => {
        await storageClass.acquireAnchorValidationSlot()
      })
    )
    let queuedResolved = false
    const queued = storageClass.acquireAnchorValidationSlot().then(() => {
      queuedResolved = true
    })
    await Promise.resolve()
    expect(queuedResolved).toBe(false)

    storageClass.releaseAnchorValidationSlot()
    let bargerResolved = false
    const barger = storageClass.acquireAnchorValidationSlot().then(() => {
      bargerResolved = true
    })
    await queued

    expect(storageClass.activeAnchorValidations).toBe(4)
    expect(bargerResolved).toBe(false)
    expect(storageClass.anchorValidationQueue).toHaveLength(1)

    for (let index = 0; index < 4; index++) {
      storageClass.releaseAnchorValidationSlot()
    }
    await barger
    storageClass.releaseAnchorValidationSlot()
    expect(storageClass.activeAnchorValidations).toBe(0)
    expect(storageClass.anchorValidationQueue).toHaveLength(0)
  })

  it('reserves queued finalization slots and restores the semaphore', async () => {
    const storageClass = OverlayGASPStorage as any
    storageClass.activeFinalizations = 0
    storageClass.finalizationQueue.length = 0

    await Promise.all(
      Array.from({ length: 2 }, async () => {
        await storageClass.acquireFinalizationSlot()
      })
    )
    let queuedResolved = false
    const queued = storageClass.acquireFinalizationSlot().then(() => {
      queuedResolved = true
    })
    await Promise.resolve()
    expect(queuedResolved).toBe(false)

    storageClass.releaseFinalizationSlot()
    await queued
    expect(storageClass.activeFinalizations).toBe(2)

    storageClass.releaseFinalizationSlot()
    storageClass.releaseFinalizationSlot()
    expect(storageClass.activeFinalizations).toBe(0)
    expect(storageClass.finalizationQueue).toHaveLength(0)
  })

  describe('appendToGraph', () => {
    it('should append a new node to an empty graph', async () => {
      const parsedTx = new Transaction(
        1,
        [],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
        0
      )
      const mockTx = {
        rawTx: parsedTx.toHex(),
        outputIndex: 0,
        graphID: `${parsedTx.id('hex')}.0`
      }

      await overlayStorage.appendToGraph(mockTx)

      expect(Object.keys(overlayStorage.temporaryGraphNodeRefs)).toHaveLength(1)
      expect(overlayStorage.temporaryGraphNodeRefs[mockTx.graphID].txid).toBe(parsedTx.id('hex'))
    })

    it('throws error when max nodes are exceeded', async () => {
      overlayStorage.maxNodesInGraph = 1
      const parsedTx = new Transaction(
        1,
        [],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
        0
      )
      const graphID = `${parsedTx.id('hex')}.0`
      ;(overlayStorage as any).graphNodeCounts.set(graphID, 1)
      const mockTx = {
        rawTx: parsedTx.toHex(),
        outputIndex: 0,
        graphID
      }

      await expect(overlayStorage.appendToGraph(mockTx)).rejects.toThrow(
        'The max number of nodes in transaction graph has been reached!'
      )
    })

    it('uses a prototype-free store and rejects graph identity confusion', async () => {
      expect(Object.getPrototypeOf(overlayStorage.temporaryGraphNodeRefs)).toBeNull()
      const parsedTx = new Transaction(
        1,
        [],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
        0
      )

      await expect(
        overlayStorage.appendToGraph({
          rawTx: parsedTx.toHex(),
          outputIndex: 0,
          graphID: `${'11'.repeat(32)}.0`
        })
      ).rejects.toThrow('root GASP node does not match')
    })

    it('enforces aggregate graph byte limits', async () => {
      const parsedTx = new Transaction(
        1,
        [],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
        0
      )
      const bounded = new OverlayGASPStorage('test-topic', mockEngine, 10, 1)

      await expect(
        bounded.appendToGraph({
          rawTx: parsedTx.toHex(),
          outputIndex: 0,
          graphID: `${parsedTx.id('hex')}.0`
        })
      ).rejects.toThrow('max byte size')
    })

    it('rejects a child that is not an input of its declared parent', async () => {
      const parent = new Transaction(
        1,
        [],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
        0
      )
      const parentID = `${parent.id('hex')}.0`
      await overlayStorage.appendToGraph({
        rawTx: parent.toHex(),
        outputIndex: 0,
        graphID: parentID
      })
      const unrelatedChild = new Transaction(
        1,
        [],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_FALSE') }],
        0
      )

      await expect(
        overlayStorage.appendToGraph(
          {
            rawTx: unrelatedChild.toHex(),
            outputIndex: 0,
            graphID: parentID
          },
          parentID
        )
      ).rejects.toThrow('not an input')
    })

    it('binds a child to the exact graph and rejects duplicate insertion', async () => {
      const child = new Transaction(
        1,
        [],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
        0
      )
      const parent = new Transaction(
        1,
        [
          {
            sourceTXID: child.id('hex'),
            sourceOutputIndex: 0,
            unlockingScript: new UnlockingScript([])
          }
        ],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
        0
      )
      const graphID = `${parent.id('hex')}.0`
      const childNode = { rawTx: child.toHex(), outputIndex: 0, graphID }

      await overlayStorage.appendToGraph({ rawTx: parent.toHex(), outputIndex: 0, graphID })
      await overlayStorage.appendToGraph(childNode, graphID)

      expect(Object.keys(overlayStorage.temporaryGraphNodeRefs)).toHaveLength(2)
      expect(overlayStorage.temporaryGraphNodeRefs[`${graphID}\u0000${child.id('hex')}.0`]).toEqual(
        expect.objectContaining({ parent: expect.objectContaining({ graphID }) })
      )
      await expect(overlayStorage.appendToGraph(childNode, graphID)).rejects.toThrow(
        'already contains this node'
      )
    })

    it('rejects missing parents, nonexistent outputs, and oversized input fan-out', async () => {
      const leaf = new Transaction(
        1,
        [],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
        0
      )
      const missingParent = `${'44'.repeat(32)}.0`
      await expect(
        overlayStorage.appendToGraph(
          { rawTx: leaf.toHex(), outputIndex: 0, graphID: `${'55'.repeat(32)}.0` },
          missingParent
        )
      ).rejects.toThrow('not found')

      await expect(
        overlayStorage.appendToGraph({
          rawTx: leaf.toHex(),
          outputIndex: 1,
          graphID: `${leaf.id('hex')}.1`
        })
      ).rejects.toThrow('output index does not exist')

      const fanOut = new Transaction(
        1,
        [
          {
            sourceTXID: '66'.repeat(32),
            sourceOutputIndex: 0,
            unlockingScript: new UnlockingScript([])
          },
          {
            sourceTXID: '77'.repeat(32),
            sourceOutputIndex: 0,
            unlockingScript: new UnlockingScript([])
          }
        ],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
        0
      )
      const bounded = new OverlayGASPStorage('test-topic', mockEngine, 1)
      await expect(
        bounded.appendToGraph({
          rawTx: fanOut.toHex(),
          outputIndex: 0,
          graphID: `${fanOut.id('hex')}.0`
        })
      ).rejects.toThrow('input count exceeds')
    })
  })

  describe('findKnownUTXOs', () => {
    it('should return known UTXOs since a given timestamp', async () => {
      const mockUTXOs = [
        { txid: '11'.repeat(32), outputIndex: 0, score: 0 },
        { txid: '22'.repeat(32), outputIndex: 1, score: 0 }
      ]
      mockEngine.storage.findUTXOsForTopic.mockResolvedValue(mockUTXOs)

      const result = await overlayStorage.findKnownUTXOs(1234567890)

      expect(result).toEqual([
        { txid: '11'.repeat(32), outputIndex: 0, score: 0 },
        { txid: '22'.repeat(32), outputIndex: 1, score: 0 }
      ])
      expect(mockEngine.storage.findUTXOsForTopic).toHaveBeenCalledWith('test-topic', 1234567890)
    })

    it('should handle errors correctly', async () => {
      mockEngine.storage.findUTXOsForTopic.mockRejectedValue(new Error('Database error'))

      await expect(overlayStorage.findKnownUTXOs(1234567890)).rejects.toThrow('Database error')
    })

    it.each([
      ['a non-array result', null, 'invalid GASP UTXO list'],
      ['an invalid txid', [{ txid: 'bad', outputIndex: 0, score: 0 }], '32 bytes of hex'],
      [
        'an invalid output index',
        [{ txid: '11'.repeat(32), outputIndex: -1, score: 0 }],
        'output index'
      ],
      ['an invalid score', [{ txid: '11'.repeat(32), outputIndex: 0, score: -1 }], 'score']
    ])('rejects storage returning %s', async (_label, result, message) => {
      mockEngine.storage.findUTXOsForTopic.mockResolvedValue(result)
      await expect(overlayStorage.findKnownUTXOs(0)).rejects.toThrow(message as string)
    })

    it.each([-1, 1.5, Number.POSITIVE_INFINITY])(
      'rejects invalid since score %s before storage',
      async since => {
        await expect(overlayStorage.findKnownUTXOs(since)).rejects.toThrow('non-negative')
        expect(mockEngine.storage.findUTXOsForTopic).not.toHaveBeenCalled()
      }
    )
  })

  describe('hydrateGASPNode', () => {
    it('should throw an error if no output is found', async () => {
      const txid = '11'.repeat(32)
      await expect(overlayStorage.hydrateGASPNode(`${txid}.0`, txid, 0, false)).rejects.toThrow(
        'No matching output found!'
      )
      expect(mockEngine.storage.findOutput).toHaveBeenCalledWith(
        txid,
        0,
        'test-topic',
        undefined,
        true
      )
    })

    it('hydrates only a transaction and output bound to the requested topic', async () => {
      const transaction = new Transaction(
        1,
        [],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
        0
      )
      const requestedTxid = transaction.id('hex')
      mockEngine.storage.findOutput.mockResolvedValue({
        txid: requestedTxid,
        outputIndex: 0,
        topic: 'test-topic',
        beef: transaction.toBEEF()
      })

      await expect(
        overlayStorage.hydrateGASPNode(`${requestedTxid}.0`, requestedTxid, 0, false)
      ).resolves.toEqual({
        graphID: `${requestedTxid}.0`,
        outputIndex: 0,
        rawTx: transaction.toHex()
      })

      mockEngine.storage.findOutput.mockResolvedValue({
        txid: requestedTxid,
        outputIndex: 0,
        topic: 'other-topic',
        beef: transaction.toBEEF()
      })
      await expect(
        overlayStorage.hydrateGASPNode(`${requestedTxid}.0`, requestedTxid, 0, false)
      ).rejects.toThrow('not admitted to the requested topic')
    })

    it('rejects stored BEEF that does not bind the requested transaction or output', async () => {
      const stored = new Transaction(
        1,
        [],
        [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
        0
      )
      mockEngine.storage.findOutput.mockResolvedValue({
        txid: '88'.repeat(32),
        outputIndex: 0,
        topic: 'test-topic',
        beef: stored.toBEEF()
      })
      await expect(
        overlayStorage.hydrateGASPNode(`${'88'.repeat(32)}.0`, '88'.repeat(32), 0, false)
      ).rejects.toThrow('does not match its transaction')

      mockEngine.storage.findOutput.mockResolvedValue({
        txid: stored.id('hex'),
        outputIndex: 1,
        topic: 'test-topic',
        beef: stored.toBEEF()
      })
      await expect(
        overlayStorage.hydrateGASPNode(`${stored.id('hex')}.1`, stored.id('hex'), 1, false)
      ).rejects.toThrow('does not match its transaction')
    })
  })

  describe('findNeededInputs', () => {
    it('should return inputs needed for further verification when no proof is present', async () => {
      const mockTx: GASPNode = {
        rawTx: '001122',
        proof: undefined,
        graphID: 'txid123.0',
        outputIndex: 0
      }

      const parsedTx = {
        inputs: [{ sourceTXID: 'inputTxid1', sourceOutputIndex: 0 }],
        toBEEF: jest.fn(),
        id: jest.fn().mockReturnValue('txid123')
      }
      jest.spyOn(Transaction, 'fromHex').mockReturnValue(parsedTx as unknown as Transaction)

      const result = await overlayStorage.findNeededInputs(mockTx)

      expect(result).toEqual({
        requestedInputs: { 'inputTxid1.0': { metadata: false } }
      })
    })

    it('should return inputs needed for further verification when proof is present', async () => {
      const mockTx: GASPNode = {
        rawTx: '001122',
        proof: 'someproof',
        graphID: 'txid123.0',
        outputIndex: 0
      }

      const parsedTx = {
        inputs: [{ sourceTXID: 'neededTxid', sourceOutputIndex: 1 }],
        outputs: [{}],
        toBEEF: jest.fn(),
        id: jest.fn().mockReturnValue('txid123'),
        merklePath: {}
      }
      jest.spyOn(Transaction, 'fromHex').mockReturnValue(parsedTx as unknown as Transaction)
      jest
        .spyOn(MerklePath, 'fromHex')
        .mockReturnValue(parsedTx.merklePath as unknown as MerklePath)

      mockEngine.managers['test-topic'] = {
        identifyAdmissibleOutputs: jest.fn().mockResolvedValue({
          outputsToAdmit: [],
          coinsToRetain: []
        }),
        identifyNeededInputs: jest
          .fn()
          .mockResolvedValue([{ txid: '11'.repeat(32), outputIndex: 1 }])
      }

      const result = await overlayStorage.findNeededInputs(mockTx)

      expect(result).toEqual({
        requestedInputs: { [`${'11'.repeat(32)}.1`]: { metadata: false } }
      })
    })

    it.each([
      [new Error('manager failed'), 'manager failed'],
      ['manager failed as a string', 'manager failed as a string']
    ])(
      'terminates the graph and logs normalized identifyNeededInputs errors',
      async (failure, message) => {
        const mockTx: GASPNode = {
          rawTx: '001122',
          proof: 'someproof',
          graphID: 'txid123.0',
          outputIndex: 0
        }
        const parsedTx = {
          inputs: [],
          outputs: [{}],
          toBEEF: jest.fn().mockReturnValue([1, 2, 3]),
          id: jest.fn().mockReturnValue('txid123'),
          merklePath: {}
        }
        jest.spyOn(Transaction, 'fromHex').mockReturnValue(parsedTx as unknown as Transaction)
        jest
          .spyOn(MerklePath, 'fromHex')
          .mockReturnValue(parsedTx.merklePath as unknown as MerklePath)
        mockEngine.managers['test-topic'] = {
          identifyAdmissibleOutputs: jest.fn().mockResolvedValue({
            outputsToAdmit: [],
            coinsToRetain: []
          }),
          identifyNeededInputs: jest.fn().mockRejectedValue(failure)
        }
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

        await expect(overlayStorage.findNeededInputs(mockTx)).resolves.toBeUndefined()

        expect(consoleError).toHaveBeenCalledWith(
          `An error occurred when identifying needed inputs for transaction: txid123.0: ${message}`
        )
        consoleError.mockRestore()
      }
    )
  })

  describe('validateGraphAnchor', () => {
    const rootGraphID = 'root-txid.0'
    const rootNode: GraphNode = {
      txid: 'root-txid',
      graphID: rootGraphID,
      rawTx: 'root-raw-tx',
      outputIndex: 0,
      children: []
    }

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('submits historical transactions in order with admitted previous-coin indexes', async () => {
      overlayStorage.temporaryGraphNodeRefs[rootGraphID] = rootNode
      const anchorBEEF = [9]
      const parentBEEF = [1]
      const rootBEEF = [2]
      const verify = jest.fn().mockResolvedValue(true)
      const parentTx = {
        inputs: [],
        outputs: [{}],
        id: jest.fn().mockReturnValue('parent-txid')
      }
      const rootTx = {
        inputs: [{ sourceTXID: 'parent-txid', sourceOutputIndex: 0 }],
        outputs: [{}],
        id: jest.fn().mockReturnValue('root-txid')
      }
      jest
        .spyOn(Transaction, 'fromBEEF')
        .mockReturnValueOnce({ verify } as unknown as Transaction)
        .mockReturnValueOnce(parentTx as unknown as Transaction)
        .mockReturnValueOnce(rootTx as unknown as Transaction)
      jest.spyOn(overlayStorage as any, 'getBEEFForNode').mockReturnValue(anchorBEEF)
      jest
        .spyOn(overlayStorage as any, 'computeOrderedBEEFsForGraph')
        .mockReturnValue([parentBEEF, rootBEEF])
      const identifyAdmissibleOutputs = jest
        .fn()
        .mockResolvedValueOnce({ outputsToAdmit: [0], coinsToRetain: [] })
        .mockResolvedValueOnce({ outputsToAdmit: [0], coinsToRetain: [] })
      mockEngine.managers['test-topic'] = { identifyAdmissibleOutputs }
      mockEngine.chainTracker = { name: 'test-chain-tracker' }

      await expect(overlayStorage.validateGraphAnchor(rootGraphID)).resolves.toBeUndefined()

      expect(verify).toHaveBeenCalledWith(mockEngine.chainTracker)
      expect(identifyAdmissibleOutputs).toHaveBeenNthCalledWith(
        1,
        parentBEEF,
        [],
        undefined,
        'historical-tx',
        { dryRun: true }
      )
      expect(identifyAdmissibleOutputs).toHaveBeenNthCalledWith(
        2,
        rootBEEF,
        [0],
        undefined,
        'historical-tx',
        { dryRun: true }
      )
    })

    it('rejects a Bitcoin-invalid graph before topical admittance', async () => {
      overlayStorage.temporaryGraphNodeRefs[rootGraphID] = rootNode
      jest.spyOn(Transaction, 'fromBEEF').mockReturnValue({
        verify: jest.fn().mockResolvedValue(false)
      } as unknown as Transaction)
      jest.spyOn(overlayStorage as any, 'getBEEFForNode').mockReturnValue([9])
      const identifyAdmissibleOutputs = jest.fn()
      mockEngine.managers['test-topic'] = { identifyAdmissibleOutputs }

      await expect(overlayStorage.validateGraphAnchor(rootGraphID)).rejects.toThrow(
        'The graph is not well-anchored according to the rules of Bitcoin.'
      )
      expect(identifyAdmissibleOutputs).not.toHaveBeenCalled()
    })

    it('rejects a graph whose root output is not topically admitted', async () => {
      overlayStorage.temporaryGraphNodeRefs[rootGraphID] = rootNode
      const rootBEEF = [2]
      jest
        .spyOn(Transaction, 'fromBEEF')
        .mockReturnValueOnce({
          verify: jest.fn().mockResolvedValue(true)
        } as unknown as Transaction)
        .mockReturnValueOnce({
          inputs: [],
          outputs: [{}],
          id: jest.fn().mockReturnValue('root-txid')
        } as unknown as Transaction)
      jest.spyOn(overlayStorage as any, 'getBEEFForNode').mockReturnValue([9])
      jest.spyOn(overlayStorage as any, 'computeOrderedBEEFsForGraph').mockReturnValue([rootBEEF])
      mockEngine.managers['test-topic'] = {
        identifyAdmissibleOutputs: jest
          .fn()
          .mockResolvedValue({ outputsToAdmit: [], coinsToRetain: [] })
      }

      await expect(overlayStorage.validateGraphAnchor(rootGraphID)).rejects.toThrow(
        'This graph did not result in topical admittance of the root node. Rejecting.'
      )
    })

    it('rejects conflicting spends within one historical graph', async () => {
      overlayStorage.temporaryGraphNodeRefs[rootGraphID] = rootNode
      const verify = jest.fn().mockResolvedValue(true)
      const parentTx = {
        inputs: [],
        outputs: [{}],
        id: jest.fn().mockReturnValue('parent-txid')
      }
      const firstSpend = {
        inputs: [{ sourceTXID: 'parent-txid', sourceOutputIndex: 0 }],
        outputs: [{}],
        id: jest.fn().mockReturnValue('first-spend')
      }
      const conflictingSpend = {
        inputs: [{ sourceTXID: 'parent-txid', sourceOutputIndex: 0 }],
        outputs: [{}],
        id: jest.fn().mockReturnValue('root-txid')
      }
      jest
        .spyOn(Transaction, 'fromBEEF')
        .mockReturnValueOnce({ verify } as unknown as Transaction)
        .mockReturnValueOnce(parentTx as unknown as Transaction)
        .mockReturnValueOnce(firstSpend as unknown as Transaction)
        .mockReturnValueOnce(conflictingSpend as unknown as Transaction)
      jest.spyOn(overlayStorage as any, 'getBEEFForNode').mockReturnValue([9])
      jest
        .spyOn(overlayStorage as any, 'computeOrderedBEEFsForGraph')
        .mockReturnValue([[1], [2], [3]])
      mockEngine.managers['test-topic'] = {
        identifyAdmissibleOutputs: jest.fn().mockResolvedValue({
          outputsToAdmit: [0],
          coinsToRetain: []
        })
      }
      mockEngine.chainTracker = {}

      await expect(overlayStorage.validateGraphAnchor(rootGraphID)).rejects.toThrow(
        'conflicting spend'
      )
    })
  })

  describe('discardGraph', () => {
    it('should discard the graph and its nodes', async () => {
      const graphNode1: GraphNode = {
        txid: 'txid123',
        graphID: 'txid123.0',
        rawTx: 'rawTxData',
        outputIndex: 0,
        children: [],
        parent: undefined
      }
      overlayStorage.temporaryGraphNodeRefs['txid123.0'] = graphNode1

      const parentNode: GraphNode = {
        txid: 'txid123',
        graphID: 'txid123.0',
        rawTx: 'rawTxData',
        outputIndex: 0,
        children: []
      }
      const graphNode2: GraphNode = {
        txid: 'txid124',
        graphID: 'txid123.0',
        rawTx: 'rawTxData',
        outputIndex: 1,
        children: [],
        parent: parentNode
      }
      overlayStorage.temporaryGraphNodeRefs['txid124.0'] = graphNode2

      await overlayStorage.discardGraph('txid123.0')

      expect(overlayStorage.temporaryGraphNodeRefs['txid123.0']).toBeUndefined()
      expect(overlayStorage.temporaryGraphNodeRefs['txid124.0']).toBeUndefined()
    })
  })

  describe('finalizeGraph', () => {
    it('releases temporary graph state after successful finalization', async () => {
      const graphID = '11'.repeat(32) + '.0'
      const root: GraphNode = {
        txid: '11'.repeat(32),
        graphID,
        rawTx: '01000000000000000000',
        outputIndex: 0,
        children: []
      }
      overlayStorage.temporaryGraphNodeRefs[graphID] = root
      jest.spyOn(overlayStorage as any, 'computeOrderedBEEFsForGraph').mockReturnValue([[1]])
      mockEngine.submit = jest.fn().mockResolvedValue({})

      await overlayStorage.finalizeGraph(graphID)

      expect(mockEngine.submit).toHaveBeenCalledTimes(1)
      expect(Object.keys(overlayStorage.temporaryGraphNodeRefs)).toHaveLength(0)
    })

    it('retains graph state and releases its slot when finalization fails', async () => {
      const graphID = '22'.repeat(32) + '.0'
      const root: GraphNode = {
        txid: '22'.repeat(32),
        graphID,
        rawTx: '01000000000000000000',
        outputIndex: 0,
        children: []
      }
      overlayStorage.temporaryGraphNodeRefs[graphID] = root
      jest.spyOn(overlayStorage as any, 'computeOrderedBEEFsForGraph').mockReturnValue([[1]])
      mockEngine.submit = jest.fn().mockRejectedValue(new Error('durable submit failed'))
      const storageClass = OverlayGASPStorage as any

      await expect(overlayStorage.finalizeGraph(graphID)).rejects.toThrow('durable submit failed')

      expect(overlayStorage.temporaryGraphNodeRefs[graphID]).toBe(root)
      expect(storageClass.activeFinalizations).toBe(0)
      expect(storageClass.finalizationQueue).toHaveLength(0)
    })

    it('rejects a missing or cyclic graph while restoring its finalization slot', async () => {
      const storageClass = OverlayGASPStorage as any
      await expect(overlayStorage.finalizeGraph(`${'33'.repeat(32)}.0`)).rejects.toThrow(
        'Unable to find root node'
      )
      expect(storageClass.activeFinalizations).toBe(0)

      const graphID = `${'44'.repeat(32)}.0`
      const root: GraphNode = {
        txid: '44'.repeat(32),
        graphID,
        rawTx: '01000000000000000000',
        outputIndex: 0,
        children: []
      }
      root.children.push(root)
      overlayStorage.temporaryGraphNodeRefs[graphID] = root
      mockEngine.submit = jest.fn()

      await expect(overlayStorage.finalizeGraph(graphID)).rejects.toThrow(
        'Cycle detected in temporary GASP graph'
      )
      expect(mockEngine.submit).not.toHaveBeenCalled()
      expect(storageClass.activeFinalizations).toBe(0)
    })
  })

  it('rejects an unproven graph node whose required input is absent', () => {
    const transaction = new Transaction(
      1,
      [
        {
          sourceTXID: '99'.repeat(32),
          sourceOutputIndex: 0,
          unlockingScript: new UnlockingScript([])
        }
      ],
      [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
      0
    )
    const graphID = `${transaction.id('hex')}.0`
    const node: GraphNode = {
      txid: transaction.id('hex'),
      graphID,
      rawTx: transaction.toHex(),
      outputIndex: 0,
      children: []
    }

    expect(() => (overlayStorage as any).getBEEFForNode(node)).toThrow(
      'Required input node for unproven parent not found'
    )
  })

  it('should handle non-existent graphID', async () => {
    await overlayStorage.discardGraph('nonexistent.0')

    expect(Object.keys(overlayStorage.temporaryGraphNodeRefs)).toHaveLength(0)
  })
})
