import { Transaction } from '@bsv/sdk'

/**
 * Represents the initial request made under the Graph Aware Sync Protocol.
 */
export type GASPInitialRequest = {
  /** GASP version. Currently 1. */
  version: number
  /** An optional timestamp (UNIX-1970-seconds) of the last time these two parties synced */
  since: number
  /** Optional limit on the number of UTXOs to return */
  limit?: number
}

/**
 * Represents an output in the GASP protocol.
 */
export type GASPOutput = {
  /** The transaction ID */
  txid: string
  /** The output index */
  outputIndex: number
  /** The score/timestamp for this output */
  score: number
}

/**
 * Represents the initial response made under the Graph Aware Sync Protocol.
 */
export type GASPInitialResponse = {
  /** A list of outputs witnessed by the recipient since the initial request's timestamp. If not provided, a complete list of outputs since the beginning of time is returned. Unconfirmed (non-timestamped) UTXOs are always returned. */
  UTXOList: GASPOutput[]
  /** A timestamp from when the responder wants to receive UTXOs in the other direction, back from the requester. */
  since: number
}

/** Represents the subsequent message sent in reply to the initial response. */
export type GASPInitialReply = {
  /** A list of outputs (excluding outputs received from the Initial Response), and ONLY after the timestamp from the initial response. We don't need to send back things from the initial response, since those were already seen by the counterparty. */
  UTXOList: GASPOutput[]
}

/**
 * Represents an output, its encompassing transaction, and the associated metadata, together with references to inputs and their metadata.
 */
export type GASPNode = {
  /** The graph ID to which this node belongs. */
  graphID: string
  /** The Bitcoin transaction in rawTX format. */
  rawTx: string
  /** The index of the output in the transaction. */
  outputIndex: number
  /** A BUMP proof for the transaction, if it is in a block. */
  proof?: string
  /** Metadata associated with the transaction, if it was requested. */
  txMetadata?: string
  /** Metadata associated with the output, if it was requested. */
  outputMetadata?: string
  /** A mapping of transaction inputs to metadata hashes, if metadata was requested. */
  inputs?: Record<string, { hash: string }>
}

/**
 * Denotes which input transactions are requested, and whether metadata needs to be sent.
 */
export type GASPNodeResponse = {
  requestedInputs: Record<string, { metadata: boolean }>
}

/**
 * Facilitates the finding of UTXOs, determination of needed inputs, temporary graph management, and eventual graph finalization.
 */
export interface GASPStorage {
  /**
   * Returns an array of transaction outpoints that are currently known to be unspent (given an optional timestamp).
   * Non-confirmed (non-timestamped) outputs should always be returned, regardless of the timestamp.
   * @param since The timestamp to find UTXOs after
   * @param limit Optional limit on the number of UTXOs to return
   * @returns A promise for an array of GASPOutput objects.
   */
  findKnownUTXOs: (since: number, limit?: number) => Promise<GASPOutput[]>
  /**
   * For a given txid and output index, returns the associated transaction, a merkle proof if the transaction is in a block, and metadata if if requested. If no metadata is requested, metadata hashes on inputs are not returned.
   * @param txid The transaction ID for the node to hydrate.
   * @param outputIndex The output index for the node to hydrate.
   * @param metadata Whether transaction and output metadata should be returned.
   * @returns The hydrated GASP node, with or without metadata.
   */
  hydrateGASPNode: (graphID: string, txid: string, outputIndex: number, metadata: boolean) => Promise<GASPNode>
  /**
   * For a given node, returns the inputs needed to complete the graph, including whether updated metadata is requested for those inputs.
   * @param tx The node for which needed inputs should be found.
   * @returns A promise for a mapping of requested input transactions and whether metadata should be provided for each.
  */
  findNeededInputs: (tx: GASPNode) => Promise<GASPNodeResponse | void>
  /**
   * Appends a new node to a temporary graph.
   * @param tx The node to append to this graph.
   * @param spentBy Unless this is the same node identified by the graph ID, denotes the TXID and input index for the node which spent this one, in 36-byte format.
   * @throws If the node cannot be appended to the graph, either because the graph ID is for a graph the recipient does not want or because the graph has grown to be too large before being finalized.
  */
  appendToGraph: (tx: GASPNode, spentBy?: string) => Promise<void>
  /**
   * Checks whether the given graph, in its current state, makes reference only to transactions that are proven in the blockchain, or already known by the recipient to be valid.
   * @param graphID The TXID and output index (in 36-byte format) for the UTXO at the tip of this graph.
   * @throws If the graph is not well-anchored.
   */
  validateGraphAnchor: (graphID: string) => Promise<void>
  /**
   * Deletes all data associated with a temporary graph that has failed to sync, if the graph exists.
   * @param graphID The TXID and output index (in 36-byte format) for the UTXO at the tip of this graph.
   */
  discardGraph: (graphID: string) => Promise<void>
  /**
   * Finalizes a graph, solidifying the new UTXO and its ancestors so that it will appear in the list of known UTXOs.
   * @param graphID The TXID and output index (in 36-byte format) for the UTXO at the tip of this graph.
   */
  finalizeGraph: (graphID: string) => Promise<void>
}

/**
 * The communications mechanism between a local GASP instance and a foreign GASP instance.
 */
export interface GASPRemote {
  /** Given an outgoing initial request, send the request to the foreign instance and obtain their initial response. */
  getInitialResponse: (request: GASPInitialRequest) => Promise<GASPInitialResponse>
  /** Given an outgoing initial response, obtain the reply from the foreign instance. */
  getInitialReply: (response: GASPInitialResponse) => Promise<GASPInitialReply>
  /** Given an outgoing txid, outputIndex and optional metadata, request the associated GASP node from the foreign instane. */
  requestNode: (graphID: string, txid: string, outputIndex: number, metadata: boolean) => Promise<GASPNode>
  /** Given an outgoing node, send the node to the foreign instance and determine which additional inputs (if any) they request in response. */
  submitNode: (node: GASPNode) => Promise<GASPNodeResponse | void>
}

export class GASPVersionMismatchError extends Error {
  code: 'ERR_GASP_VERSION_MISMATCH'
  currentVersion: number
  foreignVersion: number

  constructor(message: string, currentVersion: number, foreignVersion: number) {
    super(message)
    this.code = 'ERR_GASP_VERSION_MISMATCH'
    this.currentVersion = currentVersion
    this.foreignVersion = foreignVersion
  }
}

/**
 * Log levels for controlling output verbosity.
 */
export enum LogLevel {
  NONE = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4
}

/**
 * Main class implementing the Graph Aware Sync Protocol.
 */
export class GASP implements GASPRemote {
  version: number
  storage: GASPStorage
  remote: GASPRemote
  lastInteraction: number

  /**
   * @deprecated Retained for backwards compatibility. Use `logLevel` and the new logging methods instead.
   */
  log: boolean

  /**
   * The log level: NONE, ERROR, WARN, INFO, DEBUG.
   */
  logLevel: LogLevel

  logPrefix: string
  unidirectional: boolean

  /**
   * When true, run tasks sequentially rather than using Promise.all (parallel).
   */
  sequential: boolean

  /**
   *
   * @param storage The GASP Storage interface to use
   * @param remote The GASP Remote interface to use
   * @param lastInteraction The timestamp when we last interacted with this remote party
   * @param logPrefix Optional prefix for log messages
   * @param log Whether to log messages (backwards-compatibility only)
   * @param unidirectional Whether to disable the "reply" side and do pull-only
   * @param logLevel The log level for the instance
   * @param sequential Whether to run tasks sequentially (avoid Promise.all) or in parallel
   */
  constructor(
    storage: GASPStorage,
    remote: GASPRemote,
    lastInteraction = 0,
    logPrefix = '[GASP] ',
    log = false,
    unidirectional = false,
    logLevel: LogLevel = LogLevel.INFO,
    sequential = false
  ) {
    this.storage = storage
    this.remote = remote
    this.lastInteraction = lastInteraction
    this.version = 1
    this.logPrefix = logPrefix
    this.log = log
    this.unidirectional = unidirectional
    this.logLevel = logLevel
    this.sequential = sequential

    this.validateTimestamp(this.lastInteraction)
    this.logData(`GASP initialized with version: ${this.version}, lastInteraction: ${this.lastInteraction}, unidirectional: ${this.unidirectional}, logLevel: ${LogLevel[this.logLevel]}, sequential: ${this.sequential}`)
  }

  /**
   * Helper method to execute callbacks either in parallel or sequentially, 
   * depending on the `sequential` flag.
   */
  private async runConcurrently<T>(
    items: T[],
    callback: (item: T) => Promise<void>
  ): Promise<void> {
    if (this.sequential) {
      // Run sequentially
      for (const item of items) {
        await callback(item)
      }
    } else {
      // Run in parallel
      await Promise.all(items.map(callback))
    }
  }

  /**
   * Legacy log method for backwards compatibility only.  
   * Internally, logs at INFO level if `log === true`.
   */
  private logData(...data: any): void {
    if (this.log) {
      this.infoLog(...data)
    }
  }

  /**
   * New recommended methods for logging, respecting the logLevel.
   */
  private errorLog(...data: any): void {
    if (this.logLevel >= LogLevel.ERROR) {
      console.error(this.logPrefix, '[ERROR]', ...data)
    }
  }

  private warnLog(...data: any): void {
    if (this.logLevel >= LogLevel.WARN) {
      console.warn(this.logPrefix, '[WARN]', ...data)
    }
  }

  private infoLog(...data: any): void {
    if (this.logLevel >= LogLevel.INFO) {
      console.info(this.logPrefix, '[INFO]', ...data)
    }
  }

  private debugLog(...data: any): void {
    if (this.logLevel >= LogLevel.DEBUG) {
      console.debug(this.logPrefix, '[DEBUG]', ...data)
    }
  }

  private validateTimestamp(timestamp: number): void {
    if (typeof timestamp !== 'number' || isNaN(timestamp) || timestamp < 0 || !Number.isInteger(timestamp)) {
      throw new Error('Invalid timestamp format')
    }
  }

  /**
   * Computes a 36-byte structure from a transaction ID and output index.
   * @param txid The transaction ID.
   * @param index The output index.
   * @returns A string representing the 36-byte structure.
   */
  private compute36ByteStructure(txid: string, index: number): string {
    const result = `${txid}.${index.toString()}`
    this.debugLog(`Computed 36-byte structure: ${result} from txid: ${txid}, index: ${index}`)
    return result
  }

  /**
   * Deconstructs a 36-byte structure into a transaction ID and output index.
   * @param outpoint The 36-byte structure.
   * @returns An object containing the transaction ID and output index.
   */
  private deconstruct36ByteStructure(outpoint: string): { txid: string, outputIndex: number } {
    const [txid, index] = outpoint.split('.')
    const result = {
      txid,
      outputIndex: parseInt(index, 10)
    }
    this.debugLog(`Deconstructed 36-byte structure: ${outpoint} into txid: ${txid}, outputIndex: ${result.outputIndex}`)
    return result
  }

  /**
   * Computes the transaction ID for a given transaction.
   * @param tx The transaction string.
   * @returns The computed transaction ID.
   */
  private computeTXID(tx: string): string {
    const txid = Transaction.fromHex(tx).id('hex')
    this.debugLog(`Computed TXID: ${txid} from transaction: ${tx}`)
    return txid
  }

  /**
   * Synchronizes the transaction data between the local and remote participants.
   * @param host Host identifier for sync state management
   * @param limit Optional limit for the number of UTXOs to fetch per page (default: 1000)
   */
  async sync(host: string, limit?: number): Promise<void> {
    this.infoLog(`Starting sync process. Last interaction timestamp: ${this.lastInteraction}`)

    const localUTXOs = await this.storage.findKnownUTXOs(0)
    // Find which UTXOs we already have
    const knownOutpoints = new Set<string>()
    for (const utxo of await this.storage.findKnownUTXOs(0)) {
      knownOutpoints.add(this.compute36ByteStructure(utxo.txid, utxo.outputIndex))
    }
    const sharedOutpoints = new Set<string>()

    let initialResponse: GASPInitialResponse
    do {
      const initialRequest = await this.buildInitialRequest(this.lastInteraction, limit)
      initialResponse = await this.remote.getInitialResponse(initialRequest)

      const ingestQueue: GASPOutput[] = []
      for (const utxo of initialResponse.UTXOList) {
        if (utxo.score !== undefined && utxo.score > this.lastInteraction) {
          this.lastInteraction = utxo.score
        }
        const outpoint = this.compute36ByteStructure(utxo.txid, utxo.outputIndex)
        if (knownOutpoints.has(outpoint)) {
          sharedOutpoints.add(outpoint)
          knownOutpoints.delete(outpoint)
        } else if (!sharedOutpoints.has(outpoint)) {
          ingestQueue.push(utxo)
        }
      }
      this.infoLog(`Processing page with ${initialResponse.UTXOList.length} UTXOs (since: ${initialResponse.since})`)

      await this.runConcurrently(
        ingestQueue,
        async UTXO => {
          try {
            this.infoLog(`Requesting node for UTXO: ${JSON.stringify(UTXO)}`)
            const outpoint = this.compute36ByteStructure(UTXO.txid, UTXO.outputIndex)
            const resolvedNode = await this.remote.requestNode(
              outpoint,
              UTXO.txid,
              UTXO.outputIndex,
              true
            )
            this.debugLog(`Received unspent graph node from remote: ${JSON.stringify(resolvedNode)}`)
            await this.processIncomingNode(resolvedNode)
            await this.completeGraph(resolvedNode.graphID)
            sharedOutpoints.add(outpoint)
          } catch (e) {
            this.warnLog(`Error with incoming UTXO ${UTXO.txid}.${UTXO.outputIndex}: ${(e as Error).message}`)
          }
        }
      )
    } while (limit && initialResponse.UTXOList.length >= limit)

    // 2. Only do the “reply” half if unidirectional is disabled
    if (!this.unidirectional) {
      await this.runConcurrently(
        localUTXOs.filter(utxo =>
          utxo.score >= initialResponse.since &&
          !sharedOutpoints.has(this.compute36ByteStructure(utxo.txid, utxo.outputIndex))
        ),
        async UTXO => {
          try {
            this.infoLog(`Hydrating GASP node for UTXO: ${JSON.stringify(UTXO)}`)
            const outgoingNode = await this.storage.hydrateGASPNode(
              this.compute36ByteStructure(UTXO.txid, UTXO.outputIndex),
              UTXO.txid,
              UTXO.outputIndex,
              true
            )
            this.debugLog(`Sending unspent graph node for remote: ${JSON.stringify(outgoingNode)}`)
            await this.processOutgoingNode(outgoingNode)
          } catch (e) {
            this.warnLog(`Error with outgoing UTXO ${UTXO.txid}.${UTXO.outputIndex}: ${(e as Error).message}`)
          }
        })
    }
    this.infoLog('Sync completed!')
  }

  /**
   * Builds the initial request for the sync process.
   * @param since The timestamp to sync from
   * @param limit The limit for the number of UTXOs to fetch
   * @returns A promise for the initial request object.
   */
  async buildInitialRequest(since: number, limit?: number): Promise<GASPInitialRequest> {
    const request: GASPInitialRequest = {
      version: this.version,
      since,
      limit
    }
    this.debugLog(`Built initial request: ${JSON.stringify(request)}`)
    return request
  }

  /**
   * Builds the initial response based on the received request.
   * @param request The initial request object.
   * @returns A promise for an initial response
   */
  async getInitialResponse(request: GASPInitialRequest): Promise<GASPInitialResponse> {
    this.infoLog(`Received initial request: ${JSON.stringify(request)}`)
    if (request.version !== this.version) {
      const error = new GASPVersionMismatchError(
        `GASP version mismatch. Current version: ${this.version}, foreign version: ${request.version}`,
        this.version,
        request.version
      )
      this.errorLog(`GASP version mismatch error: ${error.message}`)
      throw error
    }
    this.validateTimestamp(request.since)
    const response = {
      since: this.lastInteraction,
      UTXOList: await this.storage.findKnownUTXOs(request.since, request.limit)
    }
    this.debugLog(`Built initial response: ${JSON.stringify(response)}`)
    return response
  }

  /**
   * Builds the initial reply based on the received response.
   * @param response The initial response object.
   * @returns A promise for an initial reply
   */
  async getInitialReply(response: GASPInitialResponse): Promise<GASPInitialReply> {
    this.infoLog(`Received initial response: ${JSON.stringify(response)}`)
    const knownUTXOs = await this.storage.findKnownUTXOs(response.since)
    const filteredUTXOs = knownUTXOs.filter(
      x => !response.UTXOList.some(y => y.txid === x.txid && y.outputIndex === x.outputIndex)
    )
    const reply = {
      UTXOList: filteredUTXOs
    }
    this.debugLog(`Built initial reply: ${JSON.stringify(reply)}`)
    return reply
  }

  /**
   * Provides a requested node to a foreign instance who requested it.
   */
  async requestNode(graphID: string, txid: string, outputIndex: number, metadata: boolean): Promise<GASPNode> {
    this.infoLog(`Remote is requesting node with graphID: ${graphID}, txid: ${txid}, outputIndex: ${outputIndex}, metadata: ${metadata}`)
    const node = await this.storage.hydrateGASPNode(graphID, txid, outputIndex, metadata)
    this.debugLog(`Returning node: ${JSON.stringify(node)}`)
    return node
  }

  /**
   * Provides a set of inputs we care about after processing a new incoming node.
   * Also finalizes or discards a graph if no additional data is requested from the foreign instance.
   */
  async submitNode(node: GASPNode): Promise<GASPNodeResponse | void> {
    this.infoLog(`Remote party is submitting node: ${JSON.stringify(node)}`)
    await this.storage.appendToGraph(node)
    const requestedInputs = await this.storage.findNeededInputs(node)
    this.debugLog(`Requested inputs: ${JSON.stringify(requestedInputs)}`)
    if (!requestedInputs) {
      await this.completeGraph(node.graphID)
    }
    return requestedInputs
  }

  /**
   * Handles the completion of a newly-synced graph
   * @param {string} graphID The ID of the newly-synced graph
   */
  async completeGraph(graphID: string): Promise<void> {
    this.infoLog(`Completing newly-synced graph: ${graphID}`)
    try {
      await this.storage.validateGraphAnchor(graphID)
      this.debugLog(`Graph validated for node: ${graphID}`)
      await this.storage.finalizeGraph(graphID)
      this.infoLog(`Graph finalized for node: ${graphID}`)
    } catch (e) {
      this.warnLog(`Error validating graph: ${(e as Error).message}. Discarding graph for node: ${graphID}`)
      await this.storage.discardGraph(graphID)
    }
  }

  /**
   * Processes an incoming node from the remote participant.
   * @param node The incoming GASP node.
   * @param spentBy The 36-byte structure of the node that spent this one, if applicable.
   */
  private async processIncomingNode(node: GASPNode, spentBy?: string, seenNodes = new Set()): Promise<void> {
    const nodeId = `${this.computeTXID(node.rawTx)}.${node.outputIndex}`
    this.debugLog(`Processing incoming node: ${JSON.stringify(node)}, spentBy: ${spentBy}`)
    if (seenNodes.has(nodeId)) {
      this.debugLog(`Node ${nodeId} already processed, skipping.`)
      return // Prevent infinite recursion
    }
    seenNodes.add(nodeId)
    await this.storage.appendToGraph(node, spentBy)
    const neededInputs = await this.storage.findNeededInputs(node)
    this.debugLog(`Needed inputs for node ${nodeId}: ${JSON.stringify(neededInputs)}`)
    if (neededInputs) {
      await this.runConcurrently(
        Object.entries(neededInputs.requestedInputs),
        async ([outpoint, { metadata }]) => {
          const { txid, outputIndex } = this.deconstruct36ByteStructure(outpoint)
          this.infoLog(`Requesting new node for txid: ${txid}, outputIndex: ${outputIndex}, metadata: ${metadata}`)
          const newNode = await this.remote.requestNode(node.graphID, txid, outputIndex, metadata)
          this.debugLog(`Received new node: ${JSON.stringify(newNode)}`)
          await this.processIncomingNode(
            newNode,
            this.compute36ByteStructure(this.computeTXID(node.rawTx), node.outputIndex),
            seenNodes
          )
        }
      )
    }
  }

  /**
   * Processes an outgoing node to the remote participant.
   * @param node The outgoing GASP node.
   */
  private async processOutgoingNode(node: GASPNode, seenNodes = new Set()): Promise<void> {
    if (this.unidirectional) {
      this.debugLog(`Skipping outgoing node processing in unidirectional mode.`)
      return
    }

    const nodeId = `${this.computeTXID(node.rawTx)}.${node.outputIndex}`
    this.debugLog(`Processing outgoing node: ${JSON.stringify(node)}`)
    if (seenNodes.has(nodeId)) {
      this.debugLog(`Node ${nodeId} already processed, skipping.`)
      return // Prevent infinite recursion
    }
    seenNodes.add(nodeId)

    // Attempt to submit the node to the remote
    const response = await this.remote.submitNode(node)
    this.debugLog(`Received response for submitted node: ${JSON.stringify(response)}`)
    if (response) {
      await this.runConcurrently(
        Object.entries(response.requestedInputs),
        async ([outpoint, { metadata }]) => {
          const { txid, outputIndex } = this.deconstruct36ByteStructure(outpoint)
          try {
            this.infoLog(`Hydrating node for txid: ${txid}, outputIndex: ${outputIndex}, metadata: ${metadata}`)
            const hydratedNode = await this.storage.hydrateGASPNode(node.graphID, txid, outputIndex, metadata)
            this.debugLog(`Hydrated node: ${JSON.stringify(hydratedNode)}`)
            await this.processOutgoingNode(hydratedNode, seenNodes)
          } catch (e) {
            this.errorLog(`Error hydrating node: ${(e as Error).message}`)
            // If we can't send the outgoing node, we just stop. The remote won't validate the anchor, and their temporary graph will be discarded.
            return
          }
        }
      )
    }
  }
}
