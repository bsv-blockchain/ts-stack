/* eslint-env jest */
jest.mock('@bsv/sdk', () => {
  // Simple hash function to generate a consistent "txid" from a string
  const mockHash = (input: string): string => {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Convert to 32-byte hex string (64 chars), padded with zeros
    return hash.toString(16).padStart(64, '0');
  };

  // Mock Transaction class
  class MockTransaction {
    private rawTx: string;

    constructor(rawTx: string) {
      this.rawTx = rawTx;
    }

    // Mock the id method to return a hex "txid" based on rawTx
    id(format: 'hex' | 'binary' = 'hex'): string {
      if (format !== 'hex') {
        throw new Error('Only hex format is mocked');
      }
      // Use the rawTx value to generate a consistent txid
      return mockHash(this.rawTx);
    }

    // Static method to create a Transaction from hex
    static fromHex(hex: string): MockTransaction {
      return new MockTransaction(hex);
    }
  }

  return {
    Transaction: MockTransaction,
  };
});

import { GASP, GASPInitialRequest, GASPNode, GASPNodeResponse, GASPStorage, GASPRemote, GASPInitialReply, GASPInitialResponse, GASPOutput } from '../GASP'

type Graph = {
    graphID: string,
    time: number,
    txid: string,
    outputIndex: number,
    rawTx: string,
    inputs: Record<string, Graph>
}

// Used to construct a non-functional remote that will be replaced after being constructed.
// Useful when directly using another GASP instance as a remote.
const throwawayRemote: GASPRemote = {
    getInitialResponse: function (request: GASPInitialRequest): Promise<GASPInitialResponse> {
        throw new Error('Function not implemented.')
    },
    getInitialReply: function (response: GASPInitialResponse): Promise<GASPInitialReply> {
        throw new Error('Function not implemented.')
    },
    requestNode: function (graphID: string, txid: string, outputIndex: number, metadata: boolean): Promise<GASPNode> {
        throw new Error('Function not implemented.')
    },
    submitNode: function (node: GASPNode): Promise<void | GASPNodeResponse> {
        throw new Error('Function not implemented.')
    }
}

class MockStorage implements GASPStorage {
    knownStore: Array<Graph>
    tempGraphStore: Record<string, Graph>
    updateCallback: Function
    logPrefix: string
    log: boolean

    constructor(knownStore: Array<Graph> = [], tempGraphStore: Record<string, Graph> = {}, updateCallback: Function = () => { }, logPrefix = '[Storage] ', log = false) {
        this.knownStore = knownStore
        this.tempGraphStore = tempGraphStore
        this.updateCallback = updateCallback
        this.logPrefix = logPrefix
        this.log = log

        // Initialize methods with default implementations
        this.findKnownUTXOs = jest.fn(this.findKnownUTXOs.bind(this))
        this.hydrateGASPNode = jest.fn(this.hydrateGASPNode.bind(this))
        this.findNeededInputs = jest.fn(this.findNeededInputs.bind(this))
        this.appendToGraph = jest.fn(this.appendToGraph.bind(this))
        this.validateGraphAnchor = jest.fn(this.validateGraphAnchor.bind(this))
        this.discardGraph = jest.fn(this.discardGraph.bind(this))
        this.finalizeGraph = jest.fn(this.finalizeGraph.bind(this))
    }

    private logData(...data: any): void {
        if (this.log) {
            console.log(this.logPrefix, ...data)
        }
    }

    async findKnownUTXOs(since: number, limit?: number): Promise<GASPOutput[]> {
        const utxos = this.knownStore
            .filter(x => !x.time || x.time > since) // Include UTXOs with no timestamp or timestamps greater than 'since'
            .sort((a, b) => (a.time || 0) - (b.time || 0)) // Sort by time ascending
            .map(x => ({ txid: x.txid, outputIndex: x.outputIndex, score: x.time }))
        this.logData('findKnownUTXOs', since, utxos)
        return limit ? utxos.slice(0, limit) : utxos
    }

    async hydrateGASPNode(graphID: string, txid: string, outputIndex: number, metadata: boolean): Promise<GASPNode> {
        const found = this.knownStore.find(x => x.txid === txid && x.outputIndex === outputIndex)
        if (!found) {
            throw new Error('Not found')
        }
        this.logData('hydrateGASPNode', graphID, txid, outputIndex, metadata, found)
        return {
            graphID,
            rawTx: found.rawTx,
            outputIndex: found.outputIndex,
            proof: 'mock_proof', // Mock proof
            txMetadata: metadata ? 'mock_tx_metadata' : undefined,
            outputMetadata: metadata ? 'mock_output_metadata' : undefined,
            inputs: metadata ? { 'mock_input': { hash: 'mock_hash' } } : undefined
        }
    }

    async findNeededInputs(tx: GASPNode): Promise<void | GASPNodeResponse> {
        this.logData('findNeededInputs', tx)
        // For testing, assume no additional inputs are needed, unless specified
        if (tx.graphID.includes('recursive')) {
            return {
                requestedInputs: {
                    'recursive_txid.1': { metadata: true }
                }
            }
        }
        return
    }

    async appendToGraph(tx: GASPNode, spentBy?: string | undefined): Promise<void> {
        this.logData('appendToGraph', tx, spentBy)
        this.tempGraphStore[tx.graphID] = {
            ...tx,
            time: Date.now(),
            txid: tx.graphID.split('.')[0],
            inputs: {}
        }
    }

    async validateGraphAnchor(graphID: string): Promise<void> {
        this.logData('validateGraphAnchor', graphID)
        // Allow validation to pass
    }

    async discardGraph(graphID: string): Promise<void> {
        this.logData('discardGraph', graphID)
        delete this.tempGraphStore[graphID]
    }

    async finalizeGraph(graphID: string): Promise<void> {
        const tempGraph = this.tempGraphStore[graphID]
        if (tempGraph) {
            this.logData('finalizeGraph', graphID, tempGraph)
            // Check if UTXO already exists to prevent duplicates
            const exists = this.knownStore.some(k => 
                k.txid === tempGraph.txid && k.outputIndex === tempGraph.outputIndex
            )
            if (!exists) {
                this.knownStore.push(tempGraph)
            }
            this.updateCallback()
            delete this.tempGraphStore[graphID]
        } else {
            this.logData('no graph to finalize', graphID, tempGraph)
        }
    }

    
    // Mock topic property for testing
    topic: string = 'test-topic'
}

const mockUTXO = {
    graphID: 'mock_sender1_txid1.0',
    rawTx: 'mock_sender1_rawtx1',
    outputIndex: 0,
    time: 111,
    txid: 'mock_sender1_txid1',
    inputs: {}
}

const mockInputNode = {
    graphID: 'mock_sender1_txid1.0',
    rawTx: 'deadbeef01010101',
    outputIndex: 0,
    time: 222,
    txid: 'mock_sender1_txid2',
    inputs: {}
}

const mockUTXOWithInput = {
    ...mockUTXO,
    inputs: {
        'mock_sender1_txid2.0': mockInputNode
    }
}

// Helper to compare UTXOs by txid and outputIndex only
const compareUTXOs = (utxos1: GASPOutput[], utxos2: GASPOutput[]) => {
    const normalized1 = utxos1.map(u => ({ txid: u.txid, outputIndex: u.outputIndex }))
    const normalized2 = utxos2.map(u => ({ txid: u.txid, outputIndex: u.outputIndex }))
    return expect(normalized1).toEqual(normalized2)
}

describe('GASP', () => {
    afterEach(() => {
        jest.resetAllMocks()
    })
    it('Fails to sync if versions are wrong', async () => {
        const originalError = console.error
        console.error = jest.fn()
        const storage1 = new MockStorage()
        const storage2 = new MockStorage()
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2
        gasp1.version = 2
        await expect(gasp1.sync('test-host')).rejects.toThrow(new Error('GASP version mismatch. Current version: 1, foreign version: 2'))
        expect(console.error).toHaveBeenCalledWith('[GASP #2] ', '[ERROR]', 'GASP version mismatch error: GASP version mismatch. Current version: 1, foreign version: 2')
        console.error = originalError
    })
    it('Synchronizes a single UTXO from Alice to Bob', async () => {
        const storage1 = new MockStorage([mockUTXO])
        const storage2 = new MockStorage()
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2
        await gasp1.sync('test-host')
        expect((await storage2.findKnownUTXOs(0)).length).toBe(1)
        compareUTXOs(await storage2.findKnownUTXOs(0), await storage1.findKnownUTXOs(0))
    })
    it('Synchronizes a single UTXO from Bob to Alice', async () => {
        const storage1 = new MockStorage()
        const storage2 = new MockStorage([mockUTXO])
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2
        await gasp1.sync('test-host')
        expect((await storage1.findKnownUTXOs(0)).length).toBe(1)
        compareUTXOs(await storage1.findKnownUTXOs(0), await storage2.findKnownUTXOs(0))
    })
    it('Discards graphs that do not validate from Alice to Bob', async () => {
        const storage1 = new MockStorage([mockUTXO])
        const storage2 = new MockStorage()
        storage2.validateGraphAnchor = jest.fn().mockImplementation((graphID: string) => {
            throw new Error('Invalid graph anchor.')
        })
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2
        await gasp1.sync('test-host')
        expect((await storage2.findKnownUTXOs(0)).length).toBe(0)
        expect(storage2.discardGraph).toHaveBeenCalledWith('mock_sender1_txid1.0')
    })
    it('Discards graphs that do not validate from Bob to Alice', async () => {
        const storage1 = new MockStorage()
        const storage2 = new MockStorage([mockUTXO])
        storage1.validateGraphAnchor = jest.fn().mockImplementation((graphID: string) => {
            throw new Error('Invalid graph anchor.')
        })
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2
        await gasp1.sync('test-host')
        expect((await storage1.findKnownUTXOs(0)).length).toBe(0)
        expect(storage1.discardGraph).toHaveBeenCalledWith('mock_sender1_txid1.0')
    })
    it('Synchronizes a deep UTXO from Bob to Alice', async () => {
        const storage1 = new MockStorage()
        storage1.findNeededInputs = jest.fn().mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
            return {
                requestedInputs: {
                    'mock_sender1_txid2.0': {
                        metadata: true
                    }
                }
            }
        })
        const storage2 = new MockStorage([mockUTXOWithInput])
        storage2.hydrateGASPNode = jest.fn().mockReturnValueOnce(mockUTXO).mockReturnValueOnce(mockInputNode)
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2
        await gasp1.sync('test-host')
        expect((await storage1.findKnownUTXOs(0)).length).toBe(1)
        compareUTXOs(await storage1.findKnownUTXOs(0), await storage2.findKnownUTXOs(0))
    })
    it('Synchronizes a deep UTXO from Alice to Bob', async () => {
        const storage2 = new MockStorage()
        storage2.findNeededInputs = jest.fn().mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
            return {
                requestedInputs: {
                    'mock_sender1_txid2.0': {
                        metadata: true
                    }
                }
            }
        })
        const storage1 = new MockStorage([mockUTXOWithInput])
        storage1.hydrateGASPNode = jest.fn().mockReturnValueOnce(mockUTXO).mockReturnValueOnce(mockInputNode)
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2
        await gasp1.sync('test-host')
        expect((await storage2.findKnownUTXOs(0)).length).toBe(1)
        compareUTXOs(await storage2.findKnownUTXOs(0), await storage1.findKnownUTXOs(0))
    })
    it('Synchronizes multiple graphs from Alice to Bob', async () => {
        const mockUTXO2 = {
            graphID: 'mock_sender2_txid1.0',
            rawTx: 'mock_sender2_rawtx1',
            outputIndex: 0,
            time: 222,
                    txid: 'mock_sender2_txid1',
            inputs: {}
        }

        const storage1 = new MockStorage([mockUTXO, mockUTXO2])
        const storage2 = new MockStorage()
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2
        await gasp1.sync('test-host')
        expect((await storage2.findKnownUTXOs(0)).length).toBe(2)
        compareUTXOs(await storage2.findKnownUTXOs(0), await storage1.findKnownUTXOs(0))
    })
    it('Synchronizes a graph with recursive inputs from Bob to Alice', async () => {
        const recursiveInputNode = {
            graphID: 'recursive_txid.1',
            rawTx: 'recursive_rawtx',
            outputIndex: 1,
            time: 333,
                    txid: 'recursive_txid',
            inputs: {}
        }

        const complexUTXOWithInput = {
            ...mockUTXOWithInput,
            inputs: {
                ...mockUTXOWithInput.inputs,
                'recursive_txid.1': recursiveInputNode
            }
        }

        const storage1 = new MockStorage()
        storage1.findNeededInputs = jest.fn().mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
            return {
                requestedInputs: {
                    'mock_sender1_txid2.0': {
                        metadata: true
                    }
                }
            }
        }).mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
            return {
                requestedInputs: {
                    'recursive_txid.1': {
                        metadata: true
                    }
                }
            }
        })
        const storage2 = new MockStorage([complexUTXOWithInput])
        storage2.hydrateGASPNode = jest.fn()
            .mockReturnValueOnce(mockUTXO)
            .mockReturnValueOnce(mockInputNode)
            .mockReturnValueOnce(recursiveInputNode)
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2
        await gasp1.sync('test-host')
        expect((await storage1.findKnownUTXOs(0)).length).toBe(1)
        compareUTXOs(await storage1.findKnownUTXOs(0), await storage2.findKnownUTXOs(0))
    })
    it('Synchronizes only UTXOs created after the specified since timestamp', async () => {
        const oldUTXO = {
            graphID: 'old_txid.0',
            rawTx: 'old_rawtx',
            outputIndex: 0,
            time: 100,
            txid: 'old_txid',
            inputs: {}
        }

        const newUTXO = {
            graphID: 'new_txid.1',
            rawTx: 'new_rawtx',
            outputIndex: 1,
            time: 200,
            txid: 'new_txid',
            inputs: {}
        }

        const storage1 = new MockStorage([oldUTXO, newUTXO])
        const storage2 = new MockStorage()
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 150, '[GASP #2] ') // Setting the `since` timestamp to 150
        gasp1.remote = gasp2
        await gasp1.sync('test-host')

        // Ensure only the new UTXO is synchronized
        const syncedUTXOs = await storage2.findKnownUTXOs(0)
        expect(syncedUTXOs.length).toBe(1)
        expect(syncedUTXOs.map(u => ({ txid: u.txid, outputIndex: u.outputIndex }))).toEqual([{ txid: 'new_txid', outputIndex: 1 }])
    })
    it('Will not sync unnecessary graphs', async () => {
        const storage1 = new MockStorage([mockUTXO])
        const storage2 = new MockStorage([mockUTXO])
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2
        await gasp1.sync('test-host')
        expect((await storage1.findKnownUTXOs(0)).length).toBe(1)
        expect((await storage2.findKnownUTXOs(0)).length).toBe(1)
        expect(storage1.finalizeGraph).not.toHaveBeenCalled()
        expect(storage2.finalizeGraph).not.toHaveBeenCalled()
        compareUTXOs(await storage2.findKnownUTXOs(0), await storage1.findKnownUTXOs(0))
    })
    it('Handles invalid timestamp format gracefully', async () => {
        const storage1 = new MockStorage()
        expect(() => new GASP(storage1, throwawayRemote, -1)).toThrow('Invalid timestamp format')
    })

    it('Handles missing UTXO during node hydration', async () => {
        const storage1 = new MockStorage()
        const storage2 = new MockStorage([mockUTXO])
        storage2.hydrateGASPNode = jest.fn().mockRejectedValueOnce(new Error('Not found'))
        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2
        await gasp1.sync('test-host')
        expect((await storage2.findKnownUTXOs(0)).length).not.toEqual((await storage1.findKnownUTXOs(0)).length)
    })
    it('Handles multiple UTXOs with mixed success and failure', async () => {
        const invalidUTXO = {
            graphID: 'invalid_txid.0',
            rawTx: 'invalid_rawtx',
            outputIndex: 0,
            time: 150,
            txid: 'invalid_txid',
            inputs: {}
        }

        const storage1 = new MockStorage([mockUTXO, invalidUTXO])
        const storage2 = new MockStorage()
        storage1.hydrateGASPNode = jest.fn().mockImplementation(async (graphID: string, txid: string, outputIndex: number, metadata: boolean) => {
            if (txid === 'invalid_txid') {
                throw new Error('Invalid transaction')
            }
            return {
                graphID,
                rawTx: mockUTXO.rawTx,
                outputIndex,
                proof: 'mock_proof',
                txMetadata: metadata ? 'mock_tx_metadata' : undefined,
                outputMetadata: metadata ? 'mock_output_metadata' : undefined,
                inputs: metadata ? { 'mock_input': { hash: 'mock_hash' } } : undefined
            }
        })

        const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
        const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
        gasp1.remote = gasp2

        await gasp1.sync('test-host')

        const syncedUTXOs = await storage2.findKnownUTXOs(0)
        expect(syncedUTXOs.length).toBe(1)
        expect(syncedUTXOs.map(u => ({ txid: u.txid, outputIndex: u.outputIndex }))).toEqual([{ txid: 'mock_sender1_txid1', outputIndex: 0 }])
    })
    describe('Not that this should ever happen in Bitcoin, but...', () => {
        it('Prevents infinite recursion with cyclically referencing nodes', async () => {
            const cyclicNode1 = {
                graphID: 'cyclic_txid1.0',
                rawTx: 'cyclic_rawtx1',
                outputIndex: 0,
                time: 300,
                txid: 'cyclic_txid1',
                inputs: {
                    'cyclic_txid2.0': {
                        graphID: 'cyclic_txid2.0',
                        rawTx: 'deadbeef2024',
                        outputIndex: 0,
                        time: 300,
                        txid: 'cyclic_txid2',
                        inputs: {
                            'cyclic_txid1.0': {
                                graphID: 'cyclic_txid1.0',
                                rawTx: 'cyclic_rawtx1',
                                outputIndex: 0,
                                time: 300,
                                txid: 'cyclic_txid1',
                                inputs: {}
                            }
                        }
                    }
                }
            }

            const storage1 = new MockStorage([cyclicNode1])
            const storage2 = new MockStorage()

            storage2.findNeededInputs = jest.fn().mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                return {
                    requestedInputs: {
                        'cyclic_txid2.0': {
                            metadata: true
                        }
                    }
                }
            }).mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                return {
                    requestedInputs: {
                        'cyclic_txid1.0': {
                            metadata: true
                        }
                    }
                }
            }).mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                return {
                    requestedInputs: {
                        'cyclic_txid2.0': {
                            metadata: true
                        }
                    }
                }
            })
            storage1.hydrateGASPNode = jest.fn()
                .mockReturnValueOnce(cyclicNode1)
                .mockReturnValueOnce(cyclicNode1.inputs['cyclic_txid2.0'])
                .mockReturnValueOnce(cyclicNode1)
                .mockReturnValueOnce(cyclicNode1.inputs['cyclic_txid2.0'])

            const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
            const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
            gasp1.remote = gasp2
            await gasp1.sync('test-host')

            // No UTXOs were synced between the parties
            expect((await storage2.findKnownUTXOs(0)).length).toBe(0)
            // The sync process did not complete
            expect((await storage2.findKnownUTXOs(0)).length).not.toEqual((await storage1.findKnownUTXOs(0)).length)
            // Two nodes were appended to the temporary graph
            expect(storage2.appendToGraph).toHaveBeenCalledTimes(2)
            // Two nodes are in temporary storage, the ones that were sent
            expect(Object.keys(storage2.tempGraphStore).length).toEqual(2)
        })
        it('Prevents infinite recursion with cyclically referencing nodes the other direction', async () => {
            const cyclicNode1 = {
                graphID: 'cyclic_txid1.0',
                rawTx: 'cyclic_rawtx1',
                outputIndex: 0,
                time: 300,
                txid: 'cyclic_txid1',
                inputs: {
                    'cyclic_txid2.0': {
                        graphID: 'cyclic_txid2.0',
                        rawTx: 'deadbeef2024',
                        outputIndex: 0,
                        time: 300,
                        txid: 'cyclic_txid2',
                        inputs: {
                            'cyclic_txid1.0': {
                                graphID: 'cyclic_txid1.0',
                                rawTx: 'cyclic_rawtx1',
                                outputIndex: 0,
                                time: 300,
                                txid: 'cyclic_txid1',
                                inputs: {}
                            }
                        }
                    }
                }
            }

            const storage1 = new MockStorage()
            const storage2 = new MockStorage([cyclicNode1])

            storage1.findNeededInputs = jest.fn().mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                return {
                    requestedInputs: {
                        'cyclic_txid2.0': {
                            metadata: true
                        }
                    }
                }
            }).mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                return {
                    requestedInputs: {
                        'cyclic_txid1.0': {
                            metadata: true
                        }
                    }
                }
            }).mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                return {
                    requestedInputs: {
                        'cyclic_txid2.0': {
                            metadata: true
                        }
                    }
                }
            })
            storage2.hydrateGASPNode = jest.fn()
                .mockReturnValueOnce(cyclicNode1)
                .mockReturnValueOnce(cyclicNode1.inputs['cyclic_txid2.0'])
                .mockReturnValueOnce(cyclicNode1)
                .mockReturnValueOnce(cyclicNode1.inputs['cyclic_txid2.0'])

            const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
            const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
            gasp1.remote = gasp2
            await gasp1.sync('test-host')

            // This direction, the UTXO does sync because the recipient is able to proceed to graph finalization after refusing to process duplicative data.
            expect((await storage1.findKnownUTXOs(0)).length).toBe(1)
            expect((await storage1.findKnownUTXOs(0)).length).toBe(1)
            expect(storage1.appendToGraph).toHaveBeenCalledTimes(2)
        })
        it('Prevents infinite recursion with complex cyclic dependencies', async () => {
            const cyclicNodeA = {
                graphID: 'cyclicA_txid.0',
                rawTx: 'cyclicA_rawtx',
                outputIndex: 0,
                time: 300,
                txid: 'cyclicA_txid',
                inputs: {
                    'cyclicB_txid.0': {
                        graphID: 'cyclicB_txid.0',
                        rawTx: 'cyclicB_rawtx',
                        outputIndex: 0,
                        time: 300,
                        txid: 'cyclicB_txid',
                        inputs: {
                            'cyclicA_txid.0': {
                                graphID: 'cyclicA_txid.0',
                                rawTx: 'cyclicA_rawtx',
                                outputIndex: 0,
                                time: 300,
                                txid: 'cyclicA_txid',
                                inputs: {}
                            }
                        }
                    }
                }
            }

            const cyclicNodeB = {
                graphID: 'cyclicB_txid.0',
                rawTx: 'cyclicB_rawtx',
                outputIndex: 0,
                time: 300,
                txid: 'cyclicB_txid',
                inputs: {
                    'cyclicC_txid.0': {
                        graphID: 'cyclicC_txid.0',
                        rawTx: 'cyclicC_rawtx',
                        outputIndex: 0,
                        time: 300,
                        txid: 'cyclicC_txid',
                        inputs: {
                            'cyclicA_txid.0': {
                                graphID: 'cyclicA_txid.0',
                                rawTx: 'cyclicA_rawtx',
                                outputIndex: 0,
                                time: 300,
                                txid: 'cyclicA_txid',
                                inputs: {}
                            }
                        }
                    }
                }
            };

            const cyclicNodeC = {
                graphID: 'cyclicC_txid.0',
                rawTx: 'cyclicC_rawtx',
                outputIndex: 0,
                time: 300,
                txid: 'cyclicC_txid',
                inputs: {
                    'cyclicA_txid.0': {
                        graphID: 'cyclicA_txid.0',
                        rawTx: 'cyclicA_rawtx',
                        outputIndex: 0,
                        time: 300,
                        txid: 'cyclicA_txid',
                        inputs: {}
                    }
                }
            };

            const storage1 = new MockStorage([cyclicNodeA]);
            const storage2 = new MockStorage();

            storage2.findNeededInputs = jest.fn()
                .mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                    return {
                        requestedInputs: {
                            'cyclicB_txid.0': {
                                metadata: true
                            }
                        }
                    };
                })
                .mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                    return {
                        requestedInputs: {
                            'cyclicC_txid.0': {
                                metadata: true
                            }
                        }
                    };
                })
                .mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                    return {
                        requestedInputs: {
                            'cyclicA_txid.0': {
                                metadata: true
                            }
                        }
                    };
                });

            storage1.hydrateGASPNode = jest.fn()
                .mockReturnValueOnce(cyclicNodeA)
                .mockReturnValueOnce(cyclicNodeB)
                .mockReturnValueOnce(cyclicNodeC)
                .mockReturnValueOnce(cyclicNodeA);

            const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
            const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
            gasp1.remote = gasp2;

            await gasp1.sync('test-host');

            expect((await storage2.findKnownUTXOs(0)).length).toBe(0);
            expect((await storage2.findKnownUTXOs(0)).length).not.toEqual((await storage1.findKnownUTXOs(0)).length);
            expect(storage2.appendToGraph).toHaveBeenCalledTimes(3);
            expect(Object.keys(storage2.tempGraphStore).length).toEqual(3);
        })

        it('Prevents infinite recursion with complex cyclic dependencies in the other direction', async () => {
            const cyclicNodeA = {
                graphID: 'cyclicA_txid.0',
                rawTx: 'cyclicA_rawtx',
                outputIndex: 0,
                time: 300,
                txid: 'cyclicA_txid',
                inputs: {
                    'cyclicB_txid.0': {
                        graphID: 'cyclicB_txid.0',
                        rawTx: 'cyclicB_rawtx',
                        outputIndex: 0,
                        time: 300,
                        txid: 'cyclicB_txid',
                        inputs: {
                            'cyclicA_txid.0': {
                                graphID: 'cyclicA_txid.0',
                                rawTx: 'cyclicA_rawtx',
                                outputIndex: 0,
                                time: 300,
                                txid: 'cyclicA_txid',
                                inputs: {}
                            }
                        }
                    }
                }
            };

            const cyclicNodeB = {
                graphID: 'cyclicB_txid.0',
                rawTx: 'cyclicB_rawtx',
                outputIndex: 0,
                time: 300,
                txid: 'cyclicB_txid',
                inputs: {
                    'cyclicC_txid.0': {
                        graphID: 'cyclicC_txid.0',
                        rawTx: 'cyclicC_rawtx',
                        outputIndex: 0,
                        time: 300,
                        txid: 'cyclicC_txid',
                        inputs: {
                            'cyclicA_txid.0': {
                                graphID: 'cyclicA_txid.0',
                                rawTx: 'cyclicA_rawtx',
                                outputIndex: 0,
                                time: 300,
                                txid: 'cyclicA_txid',
                                inputs: {}
                            }
                        }
                    }
                }
            };

            const cyclicNodeC = {
                graphID: 'cyclicC_txid.0',
                rawTx: 'cyclicC_rawtx',
                outputIndex: 0,
                time: 300,
                txid: 'cyclicC_txid',
                inputs: {
                    'cyclicA_txid.0': {
                        graphID: 'cyclicA_txid.0',
                        rawTx: 'cyclicA_rawtx',
                        outputIndex: 0,
                        time: 300,
                        txid: 'cyclicA_txid',
                        inputs: {}
                    }
                }
            };

            const storage1 = new MockStorage();
            const storage2 = new MockStorage([cyclicNodeA]);

            storage1.findNeededInputs = jest.fn()
                .mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                    return {
                        requestedInputs: {
                            'cyclicB_txid.0': {
                                metadata: true
                            }
                        }
                    };
                })
                .mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                    return {
                        requestedInputs: {
                            'cyclicC_txid.0': {
                                metadata: true
                            }
                        }
                    };
                })
                .mockImplementationOnce(async (n: GASPNode): Promise<GASPNodeResponse> => {
                    return {
                        requestedInputs: {
                            'cyclicA_txid.0': {
                                metadata: true
                            }
                        }
                    };
                });

            storage2.hydrateGASPNode = jest.fn()
                .mockReturnValueOnce(cyclicNodeA)
                .mockReturnValueOnce(cyclicNodeB)
                .mockReturnValueOnce(cyclicNodeC)
                .mockReturnValueOnce(cyclicNodeA);

            const gasp1 = new GASP(storage1, throwawayRemote, 0, '[GASP #1] ')
            const gasp2 = new GASP(storage2, gasp1, 0, '[GASP #2] ')
            gasp1.remote = gasp2;

            await gasp1.sync('test-host');

            expect((await storage1.findKnownUTXOs(0)).length).toBe(1);
            expect((await storage1.findKnownUTXOs(0)).length).toBe(1);
            expect(storage1.appendToGraph).toHaveBeenCalledTimes(3);
        })
    })

    describe('Unidirectional Sync Tests', () => {
        it('Pull-only from Bob to Alice (Alice is unidirectional client)', async () => {
            // Alice has a UTXO that Bob does not have
            const aliceUTXO = {
                graphID: 'alice_txid.0',
                rawTx: 'alice_rawtx',
                outputIndex: 0,
                time: 999,
                txid: 'alice_txid',
                inputs: {}
            }

            // Bob has a UTXO that Alice does not have
            const bobUTXO = {
                graphID: 'bob_txid.1',
                rawTx: 'bob_rawtx',
                outputIndex: 1,
                time: 1000,
                txid: 'bob_txid',
                inputs: {}
            }

            // Alice's storage
            const storageAlice = new MockStorage([aliceUTXO])

            // Bob's storage
            const storageBob = new MockStorage([bobUTXO])

            // Alice is the one calling sync() with unidirectional = true,
            // meaning "pull-only from Bob's perspective"
            const gaspAlice = new GASP(storageAlice, throwawayRemote, 0, '[GASP-Alice] ', false, true)
            // Bob is normal, but he doesn't call `sync`. He is the remote from Alice's perspective
            const gaspBob = new GASP(storageBob, gaspAlice, 0, '[GASP-Bob] ')

            // Alice uses Bob as the remote
            gaspAlice.remote = gaspBob

            // Let Alice do a unidirectional sync from Bob
            await gaspAlice.sync('test-host')

            // Expect that Bob's UTXO has arrived in Alice's store
            expect((await storageAlice.findKnownUTXOs(0)).map(u => ({ txid: u.txid, outputIndex: u.outputIndex }))).toEqual([
                { txid: 'alice_txid', outputIndex: 0 },
                { txid: 'bob_txid', outputIndex: 1 }
            ])

            // But, Bob does NOT get Alice's UTXO, because unidirectional means no "reply" from Alice
            expect((await storageBob.findKnownUTXOs(0)).map(u => ({ txid: u.txid, outputIndex: u.outputIndex }))).toEqual([
                { txid: 'bob_txid', outputIndex: 1 }
            ])
        })

        it('Pull-only from Alice to Bob (Bob is unidirectional client)', async () => {
            // Alice has a UTXO that Bob does not have
            const aliceUTXO = {
                graphID: 'alice_txid.0',
                rawTx: 'alice_rawtx',
                outputIndex: 0,
                time: 999,
                txid: 'alice_txid',
                inputs: {}
            }

            // Bob has a UTXO that Alice does not have
            const bobUTXO = {
                graphID: 'bob_txid.1',
                rawTx: 'bob_rawtx',
                outputIndex: 1,
                time: 1000,
                txid: 'bob_txid',
                inputs: {}
            }

            // Storage for each
            const storageAlice = new MockStorage([aliceUTXO])
            const storageBob = new MockStorage([bobUTXO])

            // Bob is the one calling sync() with unidirectional = true
            // Means Bob only pulls from Alice, but doesn't push his own data
            const gaspBob = new GASP(storageBob, throwawayRemote, 0, '[GASP-Bob] ', false, true)
            const gaspAlice = new GASP(storageAlice, gaspBob, 0, '[GASP-Alice] ')

            // Bob uses Alice as his remote
            gaspBob.remote = gaspAlice

            // Bob does a unidirectional sync from Alice
            await gaspBob.sync('test-host')

            // Expect that Alice's UTXO has arrived in Bob's store
            expect((await storageBob.findKnownUTXOs(0)).map(u => ({ txid: u.txid, outputIndex: u.outputIndex }))).toEqual([
                { txid: 'bob_txid', outputIndex: 1 },
                { txid: 'alice_txid', outputIndex: 0 }
            ])

            // But, Alice does NOT get Bob's UTXO, because Bob never pushes it in unidirectional mode
            expect((await storageAlice.findKnownUTXOs(0)).map(u => ({ txid: u.txid, outputIndex: u.outputIndex }))).toEqual([
                { txid: 'alice_txid', outputIndex: 0 }
            ])
        })
    })
})
