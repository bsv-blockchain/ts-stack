import { toArray } from '@bsv/sdk/primitives/utils'
import { GASPNode, GASPNodeResponse, GASPStorage, GASPOutput } from '@bsv/gasp'
import { MerklePath, Transaction } from '@bsv/sdk'
import { Engine } from '../Engine.js'
import {
  assertGASPNode,
  assertHash,
  assertNonnegativeInteger,
  assertOutpoint,
  assertOutputIndex,
  assertTopic,
  validateAdmittanceInstructions
} from '../RemoteSecurity.js'

const DEFAULT_MAX_NODES_IN_GRAPH = 2048
const MAX_CONFIGURED_NODES_IN_GRAPH = 100_000
const DEFAULT_MAX_BYTES_IN_GRAPH = 64 * 1024 * 1024

/**
 * Represents a node in the temporary graph.
 */
export interface GraphNode {
  txid: string
  graphID: string
  rawTx: string
  outputIndex: number
  spentBy?: string
  proof?: string
  txMetadata?: string
  outputMetadata?: string
  inputs?: Record<string, { hash: string }>
  children: GraphNode[]
  parent?: GraphNode
}

export class OverlayGASPStorage implements GASPStorage {
  readonly temporaryGraphNodeRefs: Record<string, GraphNode> = Object.create(null) as Record<
    string,
    GraphNode
  >
  private readonly graphNodeCounts = new Map<string, number>()
  private readonly graphByteCounts = new Map<string, number>()
  private static activeAnchorValidations = 0
  private static readonly anchorValidationQueue: Array<() => void> = []
  private static activeFinalizations = 0
  private static readonly finalizationQueue: Array<() => void> = []
  private static readonly MAX_CONCURRENT_ANCHOR_VALIDATIONS = 4
  private static readonly MAX_CONCURRENT_FINALIZATIONS = 2

  constructor(
    public topic: string,
    public engine: Engine,
    public maxNodesInGraph?: number,
    public maxBytesInGraph: number = DEFAULT_MAX_BYTES_IN_GRAPH
  ) {
    assertTopic(topic, 'GASP storage topic')
    const nodeLimit = maxNodesInGraph ?? DEFAULT_MAX_NODES_IN_GRAPH
    if (
      !Number.isSafeInteger(nodeLimit) ||
      nodeLimit < 1 ||
      nodeLimit > MAX_CONFIGURED_NODES_IN_GRAPH
    ) {
      throw new TypeError(`maxNodesInGraph must be between 1 and ${MAX_CONFIGURED_NODES_IN_GRAPH}`)
    }
    if (!Number.isSafeInteger(maxBytesInGraph) || maxBytesInGraph < 1) {
      throw new TypeError('maxBytesInGraph must be a positive safe integer')
    }
    this.maxNodesInGraph = nodeLimit
  }

  private graphNodeKey(graphID: string, nodeID: string): string {
    return graphID === nodeID ? graphID : `${graphID}\u0000${nodeID}`
  }

  private graphNode(graphID: string, nodeID: string): GraphNode | undefined {
    return this.temporaryGraphNodeRefs[this.graphNodeKey(graphID, nodeID)]
  }

  private nodeByteLength(node: GASPNode): number {
    let length = node.graphID.length + node.rawTx.length + 16
    length += node.proof?.length ?? 0
    length += node.txMetadata?.length ?? 0
    length += node.outputMetadata?.length ?? 0
    for (const [outpoint, metadata] of Object.entries(node.inputs ?? {})) {
      length += outpoint.length + metadata.hash.length
    }
    return length
  }

  private static async acquireAnchorValidationSlot(): Promise<void> {
    if (
      OverlayGASPStorage.activeAnchorValidations >=
      OverlayGASPStorage.MAX_CONCURRENT_ANCHOR_VALIDATIONS
    ) {
      await new Promise<void>(resolve => {
        OverlayGASPStorage.anchorValidationQueue.push(resolve)
      })
      return
    }
    OverlayGASPStorage.activeAnchorValidations++
  }

  private static releaseAnchorValidationSlot(): void {
    OverlayGASPStorage.activeAnchorValidations--
    const next = OverlayGASPStorage.anchorValidationQueue.shift()
    if (next !== undefined) {
      OverlayGASPStorage.activeAnchorValidations++
      next()
    }
  }

  private static async acquireFinalizationSlot(): Promise<void> {
    if (OverlayGASPStorage.activeFinalizations >= OverlayGASPStorage.MAX_CONCURRENT_FINALIZATIONS) {
      await new Promise<void>(resolve => {
        OverlayGASPStorage.finalizationQueue.push(resolve)
      })
      return
    }
    OverlayGASPStorage.activeFinalizations++
  }

  private static releaseFinalizationSlot(): void {
    OverlayGASPStorage.activeFinalizations--
    const next = OverlayGASPStorage.finalizationQueue.shift()
    if (next !== undefined) {
      OverlayGASPStorage.activeFinalizations++
      next()
    }
  }

  /**
   *
   * @param since
   * @returns
   */
  async findKnownUTXOs(since: number): Promise<GASPOutput[]> {
    assertNonnegativeInteger(since, 'GASP since score')
    const UTXOs = await this.engine.storage.findUTXOsForTopic(this.topic, since)
    if (!Array.isArray(UTXOs)) throw new TypeError('Storage returned an invalid GASP UTXO list')
    return UTXOs.map((output, index) => {
      assertHash(output.txid, `GASP UTXO[${index}] txid`)
      assertOutputIndex(output.outputIndex, `GASP UTXO[${index}] output index`)
      assertNonnegativeInteger(output.score ?? 0, `GASP UTXO[${index}] score`)
      return {
        txid: output.txid,
        outputIndex: output.outputIndex,
        score: output.score ?? 0
      }
    })
  }

  /**
   * For a given txid and output index, returns the associated transaction, a merkle proof if the transaction is in a block, and metadata if if requested. If no metadata is requested, metadata hashes on inputs are not returned.
   * @param graphID
   * @param txid
   * @param outputIndex
   * @param metadata
   * @returns
   */
  async hydrateGASPNode(
    graphID: string,
    txid: string,
    outputIndex: number,
    _metadata: boolean
  ): Promise<GASPNode> {
    assertOutpoint(graphID, 'GASP graphID')
    assertHash(txid, 'GASP txid')
    assertOutputIndex(outputIndex, 'GASP output index')
    const output = await this.engine.storage.findOutput(
      txid,
      outputIndex,
      this.topic,
      undefined,
      true
    )

    if (output?.beef === undefined) {
      throw new Error('No matching output found!')
    }
    if (output.topic !== this.topic) {
      throw new Error('Stored GASP output is not admitted to the requested topic')
    }

    const tx = Transaction.fromBEEF(output.beef)
    if (tx.id('hex').toLowerCase() !== txid.toLowerCase() || outputIndex >= tx.outputs.length) {
      throw new Error('Stored GASP output does not match its transaction')
    }
    const rawTx = tx.toHex()

    const node: GASPNode = {
      rawTx,
      graphID,
      outputIndex
    }
    if (tx.merklePath !== undefined) {
      node.proof = tx.merklePath.toHex()
    }

    return node
  }

  /**
   * For a given node, returns the inputs needed to complete the graph, including whether updated metadata is requested for those inputs.
   * @param tx The node for which needed inputs should be found.
   * @returns A promise for a mapping of requested input transactions and whether metadata should be provided for each.
   */
  async findNeededInputs(tx: GASPNode): Promise<GASPNodeResponse | undefined> {
    // If there is no Merkle proof, we always need the inputs
    const response: GASPNodeResponse = {
      requestedInputs: Object.create(null) as Record<string, { metadata: boolean }>
    }
    const parsedTx = Transaction.fromHex(tx.rawTx)
    const nodeLimit = this.maxNodesInGraph ?? DEFAULT_MAX_NODES_IN_GRAPH
    if (parsedTx.inputs.length > nodeLimit) {
      throw new Error('GASP transaction input count exceeds the graph node limit')
    }
    if (tx.proof === undefined) {
      for (const input of parsedTx.inputs) {
        response.requestedInputs[`${input.sourceTXID ?? ''}.${input.sourceOutputIndex}`] = {
          metadata: false
        }
      }

      return await this.stripAlreadyKnownInputs(response)
    }

    // Attempt to check if the current transaction is admissible
    parsedTx.merklePath = MerklePath.fromHex(tx.proof)
    const admittanceResult = validateAdmittanceInstructions(
      await this.engine.managers[this.topic].identifyAdmissibleOutputs(
        parsedTx.toBEEF(),
        [],
        typeof tx.txMetadata === 'string' ? toArray(tx.txMetadata) : undefined,
        'historical-tx',
        { dryRun: true }
      ),
      parsedTx,
      []
    )
    if (
      !admittanceResult.outputsToAdmit.includes(tx.outputIndex) &&
      this.engine.managers[this.topic] !== undefined &&
      typeof this.engine.managers[this.topic].identifyNeededInputs === 'function'
    ) {
      // The transaction is not admissible, get inputs needed for further verification
      // TopicManagers should implement a function to identify which inputs are needed.
      try {
        const neededInputs =
          (await this.engine.managers[this.topic].identifyNeededInputs?.(parsedTx.toBEEF())) ?? []
        if (!Array.isArray(neededInputs) || neededInputs.length > nodeLimit) {
          throw new TypeError('Topic manager returned an invalid or oversized needed-input list')
        }
        for (const input of neededInputs) {
          if (typeof input !== 'object' || input === null) {
            throw new TypeError('Topic manager returned an invalid needed input')
          }
          assertHash(input.txid, 'Topic manager needed-input txid')
          assertOutputIndex(input.outputIndex, 'Topic manager needed-input output index')
          response.requestedInputs[`${input.txid}.${input.outputIndex}`] = {
            metadata: false
          }
        }
        return await this.stripAlreadyKnownInputs(response)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        console.error(
          `An error occurred when identifying needed inputs for transaction: ${parsedTx.id('hex')}.${tx.outputIndex}: ${message}`
        )
        // Cut off the graph in case of an error here.
      }
      // By default, if the topic manager isn't able to stipulate needed inputs, only the inputs necessary for SPV are requested.
    }
    // Everything else falls through to returning undefined/void, which will terminate the synchronization at this point.
  }

  /**
   * Ensures that no inputs are requested from foreign nodes before sending any GASP response
   * Also terminates graphs if the response would be empty.
   */
  private async stripAlreadyKnownInputs(
    response: GASPNodeResponse | undefined
  ): Promise<GASPNodeResponse | undefined> {
    if (response === undefined) {
      return response
    }
    for (const inputNodeId of Object.keys(response.requestedInputs)) {
      const [txid, outputIndex] = inputNodeId.split('.')
      const found = await this.engine.storage.findOutput(txid, Number(outputIndex), this.topic)
      if (found !== null && found !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete response.requestedInputs[inputNodeId]
      }
    }
    if (Object.keys(response.requestedInputs).length === 0) {
      return undefined
    }
    return response
  }

  /**
   * Appends a new node to a temporary graph.
   * @param tx The node to append to this graph.
   * @param spentBy Unless this is the same node identified by the graph ID, denotes the TXID and input index for the node which spent this one, in 36-byte format.
   * @throws If the node cannot be appended to the graph, either because the graph ID is for a graph the recipient does not want or because the graph has grown to be too large before being finalized.
   */
  async appendToGraph(tx: GASPNode, spentBy?: string | undefined): Promise<void> {
    const parsedTx = Transaction.fromHex(tx.rawTx)
    const txid = parsedTx.id('hex')
    assertGASPNode(tx, { graphID: tx.graphID, txid, outputIndex: tx.outputIndex })
    if (tx.outputIndex >= parsedTx.outputs.length) {
      throw new Error('GASP node output index does not exist in its transaction')
    }
    const nodeID = `${txid}.${tx.outputIndex}`
    const nodeLimit = this.maxNodesInGraph ?? DEFAULT_MAX_NODES_IN_GRAPH
    if (parsedTx.inputs.length > nodeLimit) {
      throw new Error('GASP transaction input count exceeds the graph node limit')
    }
    const nodeCount = this.graphNodeCounts.get(tx.graphID) ?? 0
    if (nodeCount >= nodeLimit) {
      throw new Error('The max number of nodes in transaction graph has been reached!')
    }
    const nodeBytes = this.nodeByteLength(tx)
    const graphBytes = this.graphByteCounts.get(tx.graphID) ?? 0
    if (graphBytes + nodeBytes > this.maxBytesInGraph) {
      throw new Error('The max byte size of the transaction graph has been reached!')
    }
    if (tx.proof !== undefined) {
      parsedTx.merklePath = MerklePath.fromHex(tx.proof)
    }

    // Given the passed in node, append to the temp graph
    // Use the spentBy param which should be a txid.inputIndex for the node which spent this one in 36-byte format
    const newGraphNode: GraphNode = {
      txid,
      graphID: tx.graphID,
      rawTx: tx.rawTx,
      outputIndex: tx.outputIndex,
      proof: tx.proof,
      txMetadata: tx.txMetadata,
      outputMetadata: tx.outputMetadata,
      inputs: tx.inputs,
      children: []
    }

    // If spentBy is undefined, then we know it's the root node.
    if (spentBy === undefined) {
      if (nodeID !== tx.graphID) {
        throw new Error('The root GASP node does not match its graph ID')
      }
      if (this.graphNode(tx.graphID, nodeID) !== undefined) {
        throw new Error('The GASP graph already contains this node')
      }
      this.temporaryGraphNodeRefs[this.graphNodeKey(tx.graphID, nodeID)] = newGraphNode
    } else {
      assertOutpoint(spentBy, 'GASP parent outpoint')
      // Find the parent node based on spentBy
      const parentNode = this.graphNode(tx.graphID, spentBy)

      if (parentNode === undefined) {
        throw new Error(`Parent node with GraphID ${spentBy} not found`)
      }
      if (this.graphNode(tx.graphID, nodeID) !== undefined) {
        throw new Error('The GASP graph already contains this node')
      }
      const parentTransaction = Transaction.fromHex(parentNode.rawTx)
      const isReferencedInput = parentTransaction.inputs.some(
        input =>
          (input.sourceTXID ?? input.sourceTransaction?.id('hex'))?.toLowerCase() ===
            txid.toLowerCase() && input.sourceOutputIndex === tx.outputIndex
      )
      if (!isReferencedInput) {
        throw new Error('The GASP child node is not an input of its declared parent')
      }
      // Set parent-child relationship
      parentNode.children.push(newGraphNode)
      newGraphNode.parent = parentNode
      this.temporaryGraphNodeRefs[this.graphNodeKey(tx.graphID, nodeID)] = newGraphNode
    }
    this.graphNodeCounts.set(tx.graphID, nodeCount + 1)
    this.graphByteCounts.set(tx.graphID, graphBytes + nodeBytes)
  }

  private previousCoinIndexes(tx: Transaction, coins: Set<string>): number[] {
    const previousCoins: number[] = []
    for (const [inputIndex, input] of tx.inputs.entries()) {
      const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
      if (sourceTXID == null || sourceTXID === '') continue
      if (coins.has(`${sourceTXID.toLowerCase()}.${input.sourceOutputIndex}`)) {
        previousCoins.push(Number(inputIndex))
      }
    }
    return previousCoins
  }

  private async admitHistoricalBEEF(
    beef: number[],
    coins: Set<string>,
    spentOutpoints: Set<string>
  ): Promise<void> {
    const tx = Transaction.fromBEEF(beef)
    const previousCoins = this.previousCoinIndexes(tx, coins)
    const inputOutpoints: string[] = []
    for (const input of tx.inputs) {
      const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
      if (sourceTXID == null || sourceTXID === '') {
        throw new Error('Historical GASP transaction contains an unresolved input')
      }
      const outpoint = `${sourceTXID.toLowerCase()}.${input.sourceOutputIndex}`
      if (spentOutpoints.has(outpoint)) {
        throw new Error(`Historical GASP graph contains a conflicting spend of ${outpoint}`)
      }
      inputOutpoints.push(outpoint)
    }
    const admittanceInstructions = validateAdmittanceInstructions(
      await this.engine.managers[this.topic].identifyAdmissibleOutputs(
        beef,
        previousCoins,
        undefined,
        'historical-tx',
        { dryRun: true }
      ),
      tx,
      previousCoins
    )
    for (const outpoint of inputOutpoints) {
      spentOutpoints.add(outpoint)
      coins.delete(outpoint)
    }
    for (const outputIndex of admittanceInstructions.outputsToAdmit) {
      coins.add(`${tx.id('hex').toLowerCase()}.${outputIndex}`)
    }
  }

  /**
   * Checks whether the given graph, in its current state, makes reference only to transactions that are proven in the blockchain, or already known by the recipient to be valid.
   * Additionally, in a breadth-first manner (ensuring that all inputs for any given node are processed before nodes that spend them), it ensures that the root node remains valid according to the rules of the overlay's topic manager,
   * while considering any coins which the Manager had previously indicated were either valid or invalid.
   * @param graphID The TXID and output index (in 36-byte format) for the UTXO at the tip of this graph.
   * @throws If the graph is not well-anchored, according to the rules of Bitcoin or the rules of the Overlay Topic Manager.
   */
  async validateGraphAnchor(graphID: string): Promise<void> {
    await OverlayGASPStorage.acquireAnchorValidationSlot()
    try {
      const rootNode = this.temporaryGraphNodeRefs[graphID]
      if (rootNode === undefined) {
        throw new Error(`Graph node with ID ${graphID} not found`)
      }

      // Check that the root node is Bitcoin-valid.
      const beef = this.getBEEFForNode(rootNode)
      const spvTx = Transaction.fromBEEF(beef)
      const isBitcoinValid = await spvTx.verify(this.engine.chainTracker)
      if (!isBitcoinValid) {
        throw new Error('The graph is not well-anchored according to the rules of Bitcoin.')
      }

      // Then, ensure the node is Overlay-valid.
      const beefs = this.computeOrderedBEEFsForGraph(graphID)

      // coins: a Set of all historical coins to retain (no need to remove them), used to emulate topical admittance of previous inputs over time.
      const coins = new Set<string>()
      const spentOutpoints = new Set<string>()

      // Submit all historical BEEFs in order through the topic manager, tracking what would be retained until we submit the root node last.
      // If, at the end, the root node is admitted, we have a valid overlay-specific graph.
      for (const beef of beefs) {
        await this.admitHistoricalBEEF(beef, coins, spentOutpoints)
      }
      // After sending through all the graph's BEEFs...
      // If the root node is now a coin, we have acceptance by the overlay.
      // Otherwise, throw.
      if (!coins.has(graphID)) {
        throw new Error(
          'This graph did not result in topical admittance of the root node. Rejecting.'
        )
      }
    } finally {
      OverlayGASPStorage.releaseAnchorValidationSlot()
    }
  }

  /**
   * Deletes all data associated with a temporary graph that has failed to sync, if the graph exists.
   * @param graphID The TXID and output index (in 36-byte format) for the UTXO at the tip of this graph.
   */
  async discardGraph(graphID: string): Promise<void> {
    for (const [nodeId, graphRef] of Object.entries(this.temporaryGraphNodeRefs)) {
      if (graphRef.graphID === graphID) {
        // Delete child node
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete this.temporaryGraphNodeRefs[nodeId]
      }
    }
    this.graphNodeCounts.delete(graphID)
    this.graphByteCounts.delete(graphID)
  }

  /**
   * Finalizes a graph, solidifying the new UTXO and its ancestors so that it will appear in the list of known UTXOs.
   * @param graphID The TXID and output index (in 36-byte format) for the UTXO at the root of this graph.
   */
  async finalizeGraph(graphID: string): Promise<void> {
    await OverlayGASPStorage.acquireFinalizationSlot()
    try {
      const beefs = this.computeOrderedBEEFsForGraph(graphID)

      // Submit all historical BEEFs in order, finalizing the graph for the current UTXO.
      // We skip SPV verification here because validateGraphAnchor has already done it.
      for (const beef of beefs) {
        await this.engine.submit(
          {
            beef,
            topics: [this.topic]
          },
          () => {},
          'historical-tx-no-spv'
        )
      }
      await this.discardGraph(graphID)
    } finally {
      OverlayGASPStorage.releaseFinalizationSlot()
    }
  }

  /**
   * Computes an ordered set of BEEFs for the graph with the given graph IDs
   * @param {string} graphID — The ID of the graph for which BEEFs are required
   * @returns Ordered BEEFs for the graph
   */
  private computeOrderedBEEFsForGraph(graphID: string): number[][] {
    const beefs: number[][] = []
    const foundRoot = this.graphNode(graphID, graphID)
    if (foundRoot == null) {
      throw new Error('Unable to find root node in graph for finalization!')
    }
    const complete = new Set<string>()
    const visiting = new Set<string>()
    const stack: Array<{ node: GraphNode; expanded: boolean }> = [
      { node: foundRoot, expanded: false }
    ]
    while (stack.length > 0) {
      const current = stack.pop()!
      const nodeID = `${current.node.txid}.${current.node.outputIndex}`
      if (current.expanded) {
        visiting.delete(nodeID)
        if (!complete.has(nodeID)) {
          beefs.push(this.getBEEFForNode(current.node))
          complete.add(nodeID)
        }
        continue
      }
      if (complete.has(nodeID)) continue
      if (visiting.has(nodeID)) throw new Error('Cycle detected in temporary GASP graph')
      visiting.add(nodeID)
      stack.push({ node: current.node, expanded: true })
      for (let index = current.node.children.length - 1; index >= 0; index--) {
        stack.push({ node: current.node.children[index], expanded: false })
      }
    }
    return beefs
  }

  /**
   * Computes a full BEEF for a given graph node, based on the temporary graph store.
   * @param node Graph node for which BEEF is needed.
   * @returns BEEF array, including all proofs on inputs.
   */
  private getBEEFForNode(node: GraphNode): number[] {
    // Given a node, hydrate its merkle proof or all inputs, returning a reference to the hydrated node's Transaction object
    const hydrator = (node: GraphNode): Transaction => {
      const tx = Transaction.fromHex(node.rawTx)
      if (node.proof != null && node.proof !== '') {
        tx.merklePath = MerklePath.fromHex(node.proof)
        return tx // Transaction with proof, end of the line.
      }
      // For each input, look it up and recurse.
      for (const [inputIndex, input] of tx.inputs.entries()) {
        const foundNode = this.graphNode(
          node.graphID,
          `${input.sourceTXID ?? ''}.${input.sourceOutputIndex}`
        )
        if (foundNode == null) {
          throw new Error(
            'Required input node for unproven parent not found in temporary graph store. Ensure, for every parent of any given already-proven node (kept for Overlay-specific historical reasons), that a proof is also provided on those inputs. While implicitly they are valid by virtue of their descendents being proven in the blockchain, BEEF serialization will still fail when winding forward the topical UTXO set histories during sync.'
          )
        }
        tx.inputs[inputIndex].sourceTransaction = hydrator(foundNode)
      }
      return tx
    }

    const finalTX = hydrator(node)
    return finalTX.toBEEF()
  }
}
