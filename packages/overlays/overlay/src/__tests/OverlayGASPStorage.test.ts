import { GraphNode, OverlayGASPStorage } from '../GASP/OverlayGASPStorage'
import { Transaction, MerklePath } from '@bsv/sdk'
import { GASPNode } from '@bsv/gasp'

describe('OverlayGASPStorage', () => {
  let overlayStorage: OverlayGASPStorage
  let mockEngine: any

  beforeEach(() => {
    mockEngine = { storage: { findOutput: jest.fn(() => undefined), findUTXOsForTopic: jest.fn() }, managers: {} }
    overlayStorage = new OverlayGASPStorage('test-topic', mockEngine)
  })

  describe('appendToGraph', () => {
    it('should append a new node to an empty graph', async () => {
      const mockTx = {
        rawTx: '001122',
        outputIndex: 0,
        graphID: 'txid123.0'
      }

      // Use actual Transaction implementation
      const parsedTx = Transaction.fromHex(mockTx.rawTx)

      await overlayStorage.appendToGraph(mockTx)

      expect(Object.keys(overlayStorage.temporaryGraphNodeRefs).length).toBe(1)
      expect(overlayStorage.temporaryGraphNodeRefs['txid123.0'].txid).toBe(parsedTx.id('hex'))
    })

    it('throws error when max nodes are exceeded', async () => {
      overlayStorage.maxNodesInGraph = 1
      const graphNode: GraphNode = { txid: 'txid123', children: [], rawTx: '', graphID: 'txid4321.2', outputIndex: 0 }
      overlayStorage.temporaryGraphNodeRefs['txid123.0'] = graphNode

      const mockTx = {
        rawTx: '334455',
        outputIndex: 1,
        graphID: 'txid234.1'
      }

      await expect(overlayStorage.appendToGraph(mockTx)).rejects.toThrow('The max number of nodes in transaction graph has been reached!')
    })
  })

  describe('findKnownUTXOs', () => {
    it('should return known UTXOs since a given timestamp', async () => {
      const mockUTXOs = [{ txid: 'txid1', outputIndex: 0, score: 0 }, { txid: 'txid2', outputIndex: 1, score: 0 }]
      mockEngine.storage.findUTXOsForTopic.mockResolvedValue(mockUTXOs)

      const result = await overlayStorage.findKnownUTXOs(1234567890)

      expect(result).toEqual([
        { txid: 'txid1', outputIndex: 0, score: 0 },
        { txid: 'txid2', outputIndex: 1, score: 0 }
      ])
      expect(mockEngine.storage.findUTXOsForTopic).toHaveBeenCalledWith('test-topic', 1234567890)
    })

    it('should handle errors correctly', async () => {
      mockEngine.storage.findUTXOsForTopic.mockRejectedValue(new Error('Database error'))

      await expect(overlayStorage.findKnownUTXOs(1234567890)).rejects.toThrow('Database error')
    })
  })

  describe('hydrateGASPNode', () => {
    it('should throw an error if no output is found', async () => {
      await expect(overlayStorage.hydrateGASPNode('graphID', 'txid', 0, false)).rejects.toThrow('No matching output found!')
    })
    // TODO: Further test coverage
  })

  describe('findNeededInputs', () => {
    // TODO: Write more complicated test cases
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
      Transaction.fromHex = jest.fn().mockReturnValue(parsedTx)

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
        toBEEF: jest.fn(),
        id: jest.fn().mockReturnValue('txid123'),
        merklePath: {}
      }
      Transaction.fromHex = jest.fn().mockReturnValue(parsedTx)
      MerklePath.fromHex = jest.fn().mockReturnValue(parsedTx.merklePath)

      mockEngine.managers['test-topic'] = {
        identifyAdmissibleOutputs: jest.fn().mockResolvedValue({
          outputsToAdmit: []
        }),
        identifyNeededInputs: jest.fn().mockResolvedValue([{ txid: 'neededTxid', outputIndex: 1 }])
      }

      const result = await overlayStorage.findNeededInputs(mockTx)

      expect(result).toEqual({
        requestedInputs: { 'neededTxid.1': { metadata: false } }
      })
    })

    it.each([
      [new Error('manager failed'), 'manager failed'],
      ['manager failed as a string', 'manager failed as a string']
    ])('terminates the graph and logs normalized identifyNeededInputs errors', async (failure, message) => {
      const mockTx: GASPNode = {
        rawTx: '001122',
        proof: 'someproof',
        graphID: 'txid123.0',
        outputIndex: 0
      }
      const parsedTx = {
        inputs: [],
        toBEEF: jest.fn().mockReturnValue([1, 2, 3]),
        id: jest.fn().mockReturnValue('txid123'),
        merklePath: {}
      }
      Transaction.fromHex = jest.fn().mockReturnValue(parsedTx)
      MerklePath.fromHex = jest.fn().mockReturnValue(parsedTx.merklePath)
      mockEngine.managers['test-topic'] = {
        identifyAdmissibleOutputs: jest.fn().mockResolvedValue({
          outputsToAdmit: []
        }),
        identifyNeededInputs: jest.fn().mockRejectedValue(failure)
      }
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

      await expect(overlayStorage.findNeededInputs(mockTx)).resolves.toBeUndefined()

      expect(consoleError).toHaveBeenCalledWith(
        `An error occurred when identifying needed inputs for transaction: txid123.0: ${message}`
      )
      consoleError.mockRestore()
    })
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
        id: jest.fn().mockReturnValue('parent-txid')
      }
      const rootTx = {
        inputs: [{ sourceTXID: 'parent-txid', sourceOutputIndex: 0 }],
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
        .mockResolvedValueOnce({ outputsToAdmit: [0] })
        .mockResolvedValueOnce({ outputsToAdmit: [0] })
      mockEngine.managers['test-topic'] = { identifyAdmissibleOutputs }
      mockEngine.chainTracker = { name: 'test-chain-tracker' }

      await expect(overlayStorage.validateGraphAnchor(rootGraphID)).resolves.toBeUndefined()

      expect(verify).toHaveBeenCalledWith(mockEngine.chainTracker)
      expect(identifyAdmissibleOutputs).toHaveBeenNthCalledWith(
        1,
        parentBEEF,
        [],
        undefined,
        'historical-tx'
      )
      expect(identifyAdmissibleOutputs).toHaveBeenNthCalledWith(
        2,
        rootBEEF,
        [0],
        undefined,
        'historical-tx'
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
          id: jest.fn().mockReturnValue('root-txid')
        } as unknown as Transaction)
      jest.spyOn(overlayStorage as any, 'getBEEFForNode').mockReturnValue([9])
      jest.spyOn(overlayStorage as any, 'computeOrderedBEEFsForGraph').mockReturnValue([rootBEEF])
      mockEngine.managers['test-topic'] = {
        identifyAdmissibleOutputs: jest.fn().mockResolvedValue({ outputsToAdmit: [] })
      }

      await expect(overlayStorage.validateGraphAnchor(rootGraphID)).rejects.toThrow(
        'This graph did not result in topical admittance of the root node. Rejecting.'
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

  it('should handle non-existent graphID', async () => {
    await overlayStorage.discardGraph('nonexistent.0')

    expect(Object.keys(overlayStorage.temporaryGraphNodeRefs).length).toBe(0)
  })
})
