import {
  Utils,
  PublicKey,
  PrivateKey,
  P2PKH,
  Script,
  OP,
  Random,
  SecurityLevel,
  Transaction,
  Beef
} from '@bsv/sdk'
import { WalletCore } from '../core/WalletCore'
import {
  DIDDocument,
  DIDVerificationMethod,
  DIDParseResult,
  DIDDocumentV2,
  DIDVerificationMethodV2,
  DIDService,
  DIDCreateOptions,
  DIDCreateResult,
  DIDResolutionResult,
  DIDChainState,
  DIDUpdateOptions
} from '../core/types'
import { DIDError } from '../core/errors'

// ============================================================================
// Constants
// ============================================================================

const BSVDID_MARKER = 'BSVDID'
const DID_PREFIX = 'did:bsv:'
const DID_CONTEXT = 'https://www.w3.org/ns/did/v1'
const VERIFICATION_KEY_TYPE = 'JsonWebKey2020'
const LEGACY_KEY_TYPE = 'EcdsaSecp256k1VerificationKey2019'

// ============================================================================
// Utility Functions
// ============================================================================

function base64url (bytes: number[]): string {
  let encoded = Utils.toBase64(bytes).split('+').join('-').split('/').join('_')
  while (encoded.endsWith('=')) {
    encoded = encoded.slice(0, -1)
  }
  return encoded
}

function pubKeyToJwk (compressedHex: string): { kty: string, crv: string, x: string, y: string } {
  const pubKey = PublicKey.fromString(compressedHex)
  const xBytes = pubKey.getX().toArray('be', 32)
  const yBytes = pubKey.getY().toArray('be', 32)
  return {
    kty: 'EC',
    crv: 'secp256k1',
    x: base64url(xBytes),
    y: base64url(yBytes)
  }
}

function buildOpReturn (identityCode: string, payload: string): Script {
  return new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray(BSVDID_MARKER, 'utf8'))
    .writeBin(Utils.toArray(identityCode, 'utf8'))
    .writeBin(Utils.toArray(payload, 'utf8'))
}

function generateIdentityCode (): string {
  return Utils.toHex(Random(16))
}

function parseOpReturnSegments (scriptHex: string): string[] {
  try {
    const script = Script.fromHex(scriptHex)
    const chunks = script.chunks
    // Find OP_RETURN — segments follow it
    let startIdx = -1
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].op === OP.OP_RETURN) {
        startIdx = i + 1
        break
      }
    }
    if (startIdx < 0) return []

    const segments: string[] = []
    for (let i = startIdx; i < chunks.length; i++) {
      if (chunks[i].data != null) {
        segments.push(new TextDecoder().decode(new Uint8Array(chunks[i].data ?? [])))
      }
    }
    return segments
  } catch {
    return []
  }
}

// ============================================================================
// DID Utility Class (standalone — no wallet dependency)
// ============================================================================

export class DID { // eslint-disable-line @typescript-eslint/no-extraneous-class
  /**
   * Parse a did:bsv: string and extract the identifier (txid).
   */
  static parse (didString: string): DIDParseResult {
    if (didString === '' || !didString.startsWith(DID_PREFIX)) {
      throw new DIDError(`Invalid DID: must start with "${DID_PREFIX}"`)
    }

    const identifier = didString.slice(DID_PREFIX.length)
    // Accept both legacy 66-char pubkey and new 64-char txid
    if (/^[0-9a-f]{64}$/.test(identifier)) {
      return { method: 'bsv', identifier }
    }
    if (/^[0-9a-fA-F]{66}$/.test(identifier)) {
      // Legacy pubkey-based DID
      return { method: 'bsv', identifier }
    }
    throw new DIDError('Invalid DID: identifier must be a 64-character lowercase hex txid or 66-character hex public key')
  }

  /**
   * Validate a did:bsv: string format.
   */
  static isValid (didString: string): boolean {
    try {
      DID.parse(didString)
      return true
    } catch {
      return false
    }
  }

  /**
   * Create a DID string from a transaction ID.
   */
  static fromTxid (txid: string): string {
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      throw new DIDError('Invalid txid: must be 64 lowercase hex characters')
    }
    return `${DID_PREFIX}${txid}`
  }

  /**
   * Build a W3C DID Document (V2 spec-compliant, JsonWebKey2020).
   */
  static buildDocument (
    txid: string,
    subjectPubKeyHex: string,
    controllerDID?: string,
    services?: DIDService[]
  ): DIDDocumentV2 {
    const did = DID.fromTxid(txid)
    const jwk = pubKeyToJwk(subjectPubKeyHex)

    const verificationMethod: DIDVerificationMethodV2 = {
      id: `${did}#subject-key`,
      type: VERIFICATION_KEY_TYPE,
      controller: did,
      publicKeyJwk: jwk
    }

    const doc: DIDDocumentV2 = {
      '@context': DID_CONTEXT,
      id: did,
      verificationMethod: [verificationMethod],
      authentication: [`${did}#subject-key`]
    }

    if (controllerDID != null && controllerDID !== '') {
      doc.controller = controllerDID
    }

    if ((services != null) && services.length > 0) {
      doc.service = services
    }

    return doc
  }

  /**
   * @deprecated Use DID.buildDocument() for spec-compliant documents.
   * Generate a legacy DID Document from an identity key (compressed public key hex).
   */
  static fromIdentityKey (identityKey: string): DIDDocument {
    if (identityKey === '' || !/^[0-9a-fA-F]{66}$/.test(identityKey)) {
      throw new DIDError('Invalid identity key: must be a 66-character hex compressed public key')
    }

    const did = `${DID_PREFIX}${identityKey}`
    const keyId = `${did}#key-1`

    const verificationMethod: DIDVerificationMethod = {
      id: keyId,
      type: LEGACY_KEY_TYPE,
      controller: did,
      publicKeyHex: identityKey
    }

    return {
      '@context': [DID_CONTEXT],
      id: did,
      controller: did,
      verificationMethod: [verificationMethod],
      authentication: [keyId],
      assertionMethod: [keyId]
    }
  }

  /**
   * Get the certificate type used for DID persistence.
   */
  static getCertificateType (): string {
    return Utils.toBase64(Utils.toArray('did:bsv', 'utf8'))
  }
}

// ============================================================================
// Wallet-integrated DID methods
// ============================================================================

export function createDIDMethods (core: WalletCore): ReturnType<typeof _buildDIDMethods> {
  return _buildDIDMethods(core)
}

function _buildDIDMethods (core: WalletCore): {
  createDID: (options?: DIDCreateOptions) => Promise<DIDCreateResult>
  resolveDID: (didString: string) => Promise<DIDResolutionResult>
  _resolveFromBasket: (didString: string) => Promise<DIDResolutionResult | null>
  _resolveViaWhatsOnChain: (txid: string) => Promise<DIDResolutionResult>
  updateDID: (options: DIDUpdateOptions) => Promise<DIDCreateResult>
  deactivateDID: (didString: string) => Promise<{ txid: string }>
  listDIDs: () => Promise<DIDChainState[]>
  getDID: () => DIDDocument
  registerDID: (options: { persist?: boolean }) => Promise<DIDDocument>
} {
  /**
   * Build a P2PKH locking script for a tracking output (goes into basket).
   * Locked to the wallet's own identity key so it's recognized as spendable.
   */
  function buildTrackingScript (): string {
    const identityKey = core.getIdentityKey()
    const address = PublicKey.fromString(identityKey).toAddress()
    return new P2PKH().lock(address).toHex()
  }

  /**
   * Spend a chain UTXO using the signableTransaction flow.
   * Follows the same pattern as sendToken in tokens.ts.
   */
  async function spendChainOutput (params: {
    client: any
    basket: string
    currentOutpoint: string
    chainKeyHex: string
    description: string
    newOutputs: Array<{
      lockingScript: string
      satoshis: number
      outputDescription: string
      basket?: string
      customInstructions?: string
      tags?: string[]
    }>
  }): Promise<{ txid: string, tx: any }> {
    const { client, basket, currentOutpoint, chainKeyHex, description, newOutputs } = params
    const chainKey = PrivateKey.fromHex(chainKeyHex)

    // Get BEEF for the chain UTXO
    const result = await client.listOutputs({
      basket,
      include: 'entire transactions',
      includeCustomInstructions: true
    } as any)

    const beef = new Beef()
    beef.mergeBeef((result).BEEF as number[])
    const inputBEEF = beef.toBinary()

    // Create action with custom input (chain UTXO to spend)
    const response = await client.createAction({
      description,
      inputBEEF,
      inputs: [{
        outpoint: currentOutpoint,
        unlockingScriptLength: 108, // P2PKH: sig 73 + push 1 + pubkey 33 + push 1
        inputDescription: 'DID chain UTXO'
      }],
      outputs: newOutputs,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    } as any)

    if ((response)?.signableTransaction == null) {
      throw new DIDError('Expected signableTransaction for chain spend')
    }

    const signable = (response).signableTransaction
    const txToSign = Transaction.fromBEEF(signable.tx)
    txToSign.inputs[0].unlockingScriptTemplate = new P2PKH().unlock(chainKey, 'all', false)
    await txToSign.sign()

    const unlockingScript = txToSign.inputs[0].unlockingScript?.toHex()
    if (unlockingScript == null || unlockingScript === '') throw new DIDError('Failed to generate unlocking script')

    const finalResult = await client.signAction({
      reference: signable.reference,
      spends: { 0: { unlockingScript } }
    })

    return {
      txid: (finalResult).txid ?? '',
      tx: (finalResult).tx
    }
  }

  return {
    /**
     * Create a spec-compliant did:bsv DID with UTXO chain linking.
     *
     * TX0 (issuance): P2PKH chain UTXO (out 0) + OP_RETURN marker (out 1).
     *   The txid becomes the DID identifier.
     * TX1 (document): Spends TX0 out 0, creates new chain UTXO (out 0) +
     *   OP_RETURN with DID Document (out 1).
     *
     * This produces a followable output-0-spend chain that external resolvers
     * (WhatsOnChain, Teranode Universal Resolver) can discover.
     */
    async createDID (options?: DIDCreateOptions): Promise<DIDCreateResult> {
      try {
        const client = core.getClient()
        const basket = options?.basket ?? core.defaults.didBasket
        const identityCode = options?.identityCode ?? generateIdentityCode()
        const protocolID = core.defaults.didProtocolID as [SecurityLevel, string]

        // Generate chain key — random PrivateKey for UTXO chain linking
        const chainKey = PrivateKey.fromRandom()
        const chainKeyHex = chainKey.toHex()
        const chainAddress = chainKey.toPublicKey().toAddress()

        // Derive subject key
        const { publicKey: subjectKey } = await client.getPublicKey({
          protocolID,
          keyID: `${identityCode}-subject`,
          counterparty: 'anyone'
        })

        // === TX0: Issuance (chain UTXO + OP_RETURN marker) ===
        const chainLockingScript = new P2PKH().lock(chainAddress).toHex()
        const opReturnIssuance = buildOpReturn(identityCode, '1')

        const issuanceResult = await client.createAction({
          description: `DID issuance (${identityCode})`,
          outputs: [
            {
              lockingScript: chainLockingScript,
              satoshis: 1,
              outputDescription: 'DID chain UTXO',
              basket,
              customInstructions: JSON.stringify({
                type: 'did-issuance',
                identityCode,
                chainKeyHex,
                subjectKey,
                status: 'pending'
              }),
              tags: ['did', 'did-chain']
            },
            {
              lockingScript: opReturnIssuance.toHex(),
              satoshis: 0,
              outputDescription: 'DID issuance marker'
            }
          ],
          options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
        })

        const issuanceTxid = issuanceResult.txid ?? ''
        if (issuanceTxid === '') {
          throw new DIDError('Issuance transaction did not return a txid')
        }

        const did = DID.fromTxid(issuanceTxid)

        // Build document now that we know the DID
        const document = DID.buildDocument(
          issuanceTxid,
          subjectKey,
          did, // self-sovereign: controller = self
          options?.services
        )

        // === TX1: Document (spend issuance out 0 via signableTransaction) ===
        const issuanceOutpoint = `${issuanceTxid}.0`

        // Ensure issuance output is tracked in basket (retry up to 3x)
        let found = false
        for (let attempt = 0; attempt < 3; attempt++) {
          const listResult = await client.listOutputs({
            basket,
            include: 'locking scripts',
            includeCustomInstructions: true
          } as any)
          const outputs = listResult?.outputs ?? []
          found = outputs.some((o: any) => o.outpoint === issuanceOutpoint)
          if (found) break
          await new Promise(resolve => setTimeout(resolve, 500))
        }

        if (!found) { // eslint-disable-line @typescript-eslint/strict-boolean-expressions
          throw new DIDError('Issuance output not found in basket after retries')
        }

        const documentJson = JSON.stringify(document)
        const opReturnDocument = buildOpReturn(identityCode, documentJson)

        await spendChainOutput({
          client,
          basket,
          currentOutpoint: issuanceOutpoint,
          chainKeyHex,
          description: `DID document for ${did}`,
          newOutputs: [
            {
              lockingScript: new P2PKH().lock(chainAddress).toHex(),
              satoshis: 1,
              outputDescription: 'DID chain UTXO',
              basket,
              customInstructions: JSON.stringify({
                type: 'did-document',
                did,
                identityCode,
                chainKeyHex,
                subjectKey,
                issuanceTxid,
                status: 'active'
              }),
              tags: ['did', 'did-chain']
            },
            {
              lockingScript: opReturnDocument.toHex(),
              satoshis: 0,
              outputDescription: 'DID Document'
            }
          ]
        })

        return {
          did,
          txid: issuanceTxid,
          identityCode,
          document
        }
      } catch (error) {
        if (error instanceof DIDError) throw error
        throw new DIDError(`DID creation failed: ${(error as Error).message}`)
      }
    },

    /**
     * Resolve a did:bsv DID to its DID Document.
     * Tries Teranode Universal Resolver first, falls back to WhatsOnChain.
     */
    async resolveDID (didString: string): Promise<DIDResolutionResult> {
      const parsed = DID.parse(didString)

      // Legacy pubkey-based DID — return legacy document
      if (parsed.identifier.length === 66) {
        const legacyDoc = DID.fromIdentityKey(parsed.identifier)
        return {
          didDocument: {
            '@context': DID_CONTEXT,
            id: legacyDoc.id,
            controller: legacyDoc.controller,
            verificationMethod: legacyDoc.verificationMethod.map(vm => ({
              id: vm.id,
              type: vm.type,
              controller: vm.controller,
              publicKeyJwk: pubKeyToJwk(vm.publicKeyHex)
            })),
            authentication: legacyDoc.authentication
          },
          didDocumentMetadata: {},
          didResolutionMetadata: { contentType: 'application/did+ld+json' }
        }
      }

      // Check local basket first — fastest resolution for our own DIDs
      try {
        const localResult = await this._resolveFromBasket(didString)
        if (localResult != null) return localResult
      } catch {
        // Fall through to external resolvers
      }

      // Try server-side proxy (bypasses CORS for browser clients)
      // The proxy handles nChain → WoC fallback internally, so one call is enough.
      const proxyUrl = core.defaults.didProxyUrl
      if (proxyUrl != null && proxyUrl !== '') {
        try {
          const response = await fetch(`${proxyUrl}?did=${encodeURIComponent(didString)}`)
          if (response.ok) {
            const data: any = await response.json()
            if ((data.didDocument != null) || (data.didDocumentMetadata?.deactivated === true)) {
              return data as DIDResolutionResult
            }
          }
        } catch {
          // Proxy unavailable — fall through to direct resolvers
        }
      }

      // No proxy configured (server-side SDK usage) — try resolvers directly
      const resolverUrl = core.defaults.didResolverUrl
      if (resolverUrl != null && resolverUrl !== '') {
        try {
          const response = await fetch(`${resolverUrl}/1.0/identifiers/${didString}`)
          if (response.ok) {
            const data: any = await response.json()
            return {
              didDocument: data.didDocument ?? data,
              didDocumentMetadata: data.didDocumentMetadata ?? {},
              didResolutionMetadata: {
                contentType: 'application/did+ld+json',
                ...(data.didResolutionMetadata ?? {})
              }
            }
          }
          if (response.status === 410) {
            const data: any = await response.json().catch(() => ({}))
            return {
              didDocument: data.didDocument ?? null,
              didDocumentMetadata: { deactivated: true, ...(data.didDocumentMetadata ?? {}) },
              didResolutionMetadata: {
                contentType: 'application/did+ld+json',
                ...(data.didResolutionMetadata ?? {})
              }
            }
          }
        } catch {
          // Resolver unavailable — fall through to WhatsOnChain
        }
      }

      // WhatsOnChain direct fallback (server-side only — CORS-blocked in browsers)
      return await this._resolveViaWhatsOnChain(parsed.identifier)
    },

    /**
     * Resolve a DID from the local basket (for DIDs we own).
     * @internal
     */
    async _resolveFromBasket (didString: string): Promise<DIDResolutionResult | null> {
      const client = core.getClient()
      const basket = core.defaults.didBasket

      const listResult = await client.listOutputs({
        basket,
        include: 'locking scripts',
        includeCustomInstructions: true
      } as any)

      const outputs = listResult?.outputs ?? []

      // Find the latest state for this DID (may have multiple outputs: doc, update, deactivate)
      let latestCI: any = null
      for (const output of outputs) {
        if ((output as any).customInstructions == null) continue
        try {
          const ci = JSON.parse((output as any).customInstructions)
          if (ci.did !== didString) continue
          // Pick the latest by preferring deactivated > active, and later entries
          latestCI = ci
        } catch {}
      }

      if (latestCI == null) return null

      if (latestCI.status === 'deactivated') {
        // Try to reconstruct last known document
        const doc = (latestCI.subjectKey != null)
          ? DID.buildDocument(latestCI.issuanceTxid, latestCI.subjectKey, didString)
          : null
        return {
          didDocument: doc,
          didDocumentMetadata: { deactivated: true },
          didResolutionMetadata: { contentType: 'application/did+ld+json' }
        }
      }

      // Build document from stored metadata
      if ((latestCI.subjectKey != null) && (latestCI.issuanceTxid != null)) {
        const services = latestCI.services ?? undefined
        const document = DID.buildDocument(latestCI.issuanceTxid, latestCI.subjectKey, didString, services)

        // If additional keys stored, add them
        if (latestCI.additionalKeys != null) {
          for (let i = 0; i < latestCI.additionalKeys.length; i++) {
            const jwk = pubKeyToJwk(latestCI.additionalKeys[i])
            document.verificationMethod.push({
              id: `${didString}#key-${i + 2}`,
              type: VERIFICATION_KEY_TYPE,
              controller: didString,
              publicKeyJwk: jwk
            })
          }
        }

        return {
          didDocument: document,
          didDocumentMetadata: {},
          didResolutionMetadata: { contentType: 'application/did+ld+json' }
        }
      }

      return null
    },

    /**
     * Resolve a DID by following the UTXO chain on WhatsOnChain.
     * @internal
     */
    async _resolveViaWhatsOnChain (txid: string): Promise<DIDResolutionResult> {
      const notFound: DIDResolutionResult = {
        didDocument: null,
        didDocumentMetadata: {},
        didResolutionMetadata: { error: 'notFound', message: 'DID not found on chain' }
      }

      try {
        let currentTxid = txid
        let lastDocument: DIDDocumentV2 | null = null
        let lastDocTxid: string | undefined
        let created: string | undefined
        let updated: string | undefined
        let foundIssuance = false
        const maxHops = 100 // safety limit
        const visited = new Set<string>()

        // Rate-limited fetch to avoid WoC 429 errors (browser has strict limits)
        let lastWocCall = 0
        const wocFetch = async (url: string): Promise<Response> => {
          const elapsed = Date.now() - lastWocCall
          if (lastWocCall > 0 && elapsed < 350) {
            await new Promise(resolve => setTimeout(resolve, 350 - elapsed))
          }
          lastWocCall = Date.now()
          return await fetch(url)
        }

        for (let hop = 0; hop < maxHops; hop++) {
          if (visited.has(currentTxid)) break
          visited.add(currentTxid)
          // Fetch the transaction
          const txResp = await wocFetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${currentTxid}`)
          if (!txResp.ok) return notFound
          const txData: any = await txResp.json()

          if (created == null) {
            created = (txData.time != null) ? new Date(txData.time * 1000).toISOString() : undefined
          }

          // Parse OP_RETURN outputs to find BSVDID segments
          let segments: string[] = []
          for (const vout of (txData.vout as any[] | null) ?? []) {
            const hex = vout?.scriptPubKey?.hex as string | undefined
            if (hex == null || hex === '') continue
            const s = parseOpReturnSegments(hex)
            if (s.length >= 3 && s[0] === BSVDID_MARKER) {
              segments = s
              break
            }
          }

          if (segments.length >= 3) {
            const payload = segments[2]

            // Check transaction type based on payload
            if (payload === '3') {
              // Revocation tx
              return {
                didDocument: lastDocument,
                didDocumentMetadata: {
                  created,
                  updated,
                  deactivated: true,
                  versionId: currentTxid
                },
                didResolutionMetadata: { contentType: 'application/did+ld+json' }
              }
            }

            if (payload === '2') {
              // Funding tx — continue following chain
            } else if (payload === '1') {
              // Issuance tx — continue following chain
              foundIssuance = true
            } else {
              // Assume it's a document (JSON payload)
              try {
                lastDocument = JSON.parse(payload) as DIDDocumentV2
                lastDocTxid = currentTxid
                updated = (txData.time != null) ? new Date(txData.time * 1000).toISOString() : undefined
              } catch {
                // Not valid JSON — skip
              }
            }
          }

          // Check if output 0 is spent → follow the chain
          let nextTxid: string | null = null

          // Strategy 1: spend endpoint (fast path)
          try {
            const spendResp = await wocFetch(
              `https://api.whatsonchain.com/v1/bsv/main/tx/${currentTxid}/out/0/spend`
            )
            if (spendResp.ok && spendResp.status !== 404) {
              const spendData: any = await spendResp.json()
              nextTxid = spendData?.txid ?? null
            }
          } catch { /* fall through to address history */ }

          // Strategy 2: address history fallback (WoC spend index is unreliable)
          // The chain key address is random and unique to this DID, so any
          // other TX at that address is a chain TX — no per-TX verification needed.
          if (nextTxid == null) {
            const out0Addr = txData.vout?.[0]?.scriptPubKey?.addresses?.[0]
            if (out0Addr != null) {
              try {
                const histResp = await wocFetch(
                  `https://api.whatsonchain.com/v1/bsv/main/address/${String(out0Addr)}/history`
                )
                if (histResp.ok) {
                  const history = await histResp.json() as Array<{ tx_hash: string, height: number }>
                  // Sort descending by height — most recent TX first.
                  // Pick the latest chain TX to skip intermediate hops
                  // (the main loop will parse its BSVDID markers).
                  const candidates = history
                    .filter(e => !visited.has(e.tx_hash))
                    .sort((a, b) => (b.height !== 0 ? b.height : 0) - (a.height !== 0 ? a.height : 0))
                  if (candidates.length > 0) {
                    nextTxid = candidates[0].tx_hash
                  }
                }
              } catch { /* address history unavailable */ }
            }
          }

          if (nextTxid == null) break

          currentTxid = nextTxid
        }

        if (lastDocument != null) {
          return {
            didDocument: lastDocument,
            didDocumentMetadata: {
              created,
              updated,
              versionId: lastDocTxid
            },
            didResolutionMetadata: { contentType: 'application/did+ld+json' }
          }
        }

        // Found issuance TX but document hasn't propagated yet
        if (foundIssuance) {
          return {
            didDocument: null,
            didDocumentMetadata: { created },
            didResolutionMetadata: {
              error: 'notYetAvailable',
              message: 'DID issuance found on chain but document transaction has not propagated yet. Try again shortly.'
            }
          }
        }

        return notFound
      } catch (error) {
        return {
          didDocument: null,
          didDocumentMetadata: {},
          didResolutionMetadata: {
            error: 'internalError',
            message: `WhatsOnChain resolution failed: ${(error as Error).message}`
          }
        }
      }
    },

    /**
     * Update a DID document by spending the current chain UTXO.
     * Creates a new chain UTXO (out 0) + OP_RETURN with updated document (out 1).
     */
    async updateDID (options: DIDUpdateOptions): Promise<DIDCreateResult> {
      try {
        const client = core.getClient()
        DID.parse(options.did)
        const basket = core.defaults.didBasket

        // Find current chain state from basket
        const listResult = await client.listOutputs({
          basket,
          include: 'locking scripts',
          includeCustomInstructions: true
        } as any)

        const outputs = listResult?.outputs ?? []
        let chainCI: any = null
        let chainOutpoint: string = ''

        for (const output of outputs) {
          if ((output as any).customInstructions == null) continue
          try {
            const ci = JSON.parse((output as any).customInstructions)
            if (ci.did === options.did && ci.status === 'active') {
              chainCI = ci
              chainOutpoint = output.outpoint
            }
          } catch {}
        }

        if (chainCI == null) {
          throw new DIDError(`No active chain state found for ${options.did}`)
        }

        const { identityCode, subjectKey, issuanceTxid, chainKeyHex } = chainCI
        if (chainKeyHex == null || chainKeyHex === '') {
          throw new DIDError('Chain key not found in output metadata — cannot spend chain UTXO')
        }

        const chainKey = PrivateKey.fromHex(chainKeyHex)
        const chainAddress = chainKey.toPublicKey().toAddress()

        // Build the updated document
        const document = DID.buildDocument(
          issuanceTxid,
          subjectKey,
          options.did,
          options.services
        )

        // If additional verification keys requested, add them
        if (options.additionalKeys != null) {
          for (let i = 0; i < options.additionalKeys.length; i++) {
            const jwk = pubKeyToJwk(options.additionalKeys[i])
            document.verificationMethod.push({
              id: `${options.did}#key-${i + 2}`,
              type: VERIFICATION_KEY_TYPE,
              controller: options.did,
              publicKeyJwk: jwk
            })
          }
        }

        const documentJson = JSON.stringify(document)
        const opReturnDocument = buildOpReturn(identityCode, documentJson)

        // Spend current chain UTXO → new chain UTXO + updated document
        await spendChainOutput({
          client,
          basket,
          currentOutpoint: chainOutpoint,
          chainKeyHex,
          description: `DID update for ${options.did}`,
          newOutputs: [
            {
              lockingScript: new P2PKH().lock(chainAddress).toHex(),
              satoshis: 1,
              outputDescription: 'DID chain UTXO (updated)',
              basket,
              customInstructions: JSON.stringify({
                type: 'did-update',
                did: options.did,
                identityCode,
                chainKeyHex,
                subjectKey,
                issuanceTxid,
                services: options.services,
                additionalKeys: options.additionalKeys,
                status: 'active'
              }),
              tags: ['did', 'did-chain']
            },
            {
              lockingScript: opReturnDocument.toHex(),
              satoshis: 0,
              outputDescription: 'DID Document (updated)'
            }
          ]
        })

        return {
          did: options.did,
          txid: issuanceTxid,
          identityCode,
          document
        }
      } catch (error) {
        if (error instanceof DIDError) throw error
        throw new DIDError(`DID update failed: ${(error as Error).message}`)
      }
    },

    /**
     * Deactivate (revoke) a DID by spending the chain UTXO.
     * Out 0: OP_RETURN revocation marker (chain terminates).
     * Out 1: P2PKH to wallet identity key (local bookkeeping).
     */
    async deactivateDID (didString: string): Promise<{ txid: string }> {
      try {
        const client = core.getClient()
        DID.parse(didString)
        const basket = core.defaults.didBasket

        // Find current chain state
        const listResult = await client.listOutputs({
          basket,
          include: 'locking scripts',
          includeCustomInstructions: true
        } as any)

        const outputs = listResult?.outputs ?? []
        let chainCI: any = null
        let chainOutpoint: string = ''

        for (const output of outputs) {
          if ((output as any).customInstructions == null) continue
          try {
            const ci = JSON.parse((output as any).customInstructions)
            if (ci.did === didString && ci.status === 'active') {
              chainCI = ci
              chainOutpoint = output.outpoint
            }
          } catch {}
        }

        if (chainCI == null) {
          throw new DIDError(`No active chain state found for ${didString}`)
        }

        const { identityCode, chainKeyHex } = chainCI
        if (chainKeyHex == null || chainKeyHex === '') {
          throw new DIDError('Chain key not found in output metadata — cannot spend chain UTXO')
        }

        const revocationScript = buildOpReturn(identityCode, '3')
        const trackingScript = buildTrackingScript()

        // Spend chain UTXO → OP_RETURN revocation (out 0, terminates chain) +
        // P2PKH tracker (out 1, local bookkeeping)
        const result = await spendChainOutput({
          client,
          basket,
          currentOutpoint: chainOutpoint,
          chainKeyHex,
          description: `DID revocation for ${didString}`,
          newOutputs: [
            {
              lockingScript: revocationScript.toHex(),
              satoshis: 0,
              outputDescription: 'DID revocation marker'
            },
            {
              lockingScript: trackingScript,
              satoshis: 1,
              outputDescription: 'DID chain tracker (deactivated)',
              basket,
              customInstructions: JSON.stringify({
                type: 'did-revocation',
                did: didString,
                identityCode,
                subjectKey: chainCI.subjectKey,
                issuanceTxid: chainCI.issuanceTxid,
                status: 'deactivated'
              }),
              tags: ['did', 'did-chain']
            }
          ]
        })

        return { txid: result.txid }
      } catch (error) {
        if (error instanceof DIDError) throw error
        throw new DIDError(`DID deactivation failed: ${(error as Error).message}`)
      }
    },

    /**
     * List all DIDs owned by this wallet.
     */
    async listDIDs (): Promise<DIDChainState[]> {
      try {
        const client = core.getClient()
        const basket = core.defaults.didBasket

        const listResult = await client.listOutputs({
          basket,
          include: 'locking scripts',
          includeCustomInstructions: true
        } as any)

        const outputs = listResult?.outputs ?? []
        const didMap = new Map<string, DIDChainState>()

        for (const output of outputs) {
          if ((output as any).customInstructions == null) continue
          try {
            const ci = JSON.parse((output as any).customInstructions)
            if ((ci.did == null) || (ci.identityCode == null)) continue

            // Skip pending issuance outputs (consumed by document TX)
            if (ci.status === 'pending') continue

            // Always overwrite with the latest entry (later outputs = newer state)
            didMap.set(ci.did, {
              did: ci.did,
              identityCode: ci.identityCode,
              issuanceTxid: ci.issuanceTxid ?? ci.did?.replace('did:bsv:', ''),
              currentOutpoint: output.outpoint,
              status: ci.status === 'deactivated' ? 'deactivated' : 'active',
              created: ci.created ?? new Date().toISOString(),
              updated: ci.updated ?? new Date().toISOString()
            })
          } catch {}
        }

        return Array.from(didMap.values())
      } catch (error) {
        throw new DIDError(`Failed to list DIDs: ${(error as Error).message}`)
      }
    },

    /**
     * @deprecated Use createDID() for spec-compliant DIDs.
     * Get this wallet's legacy DID Document (identity-key based).
     */
    getDID (): DIDDocument {
      return DID.fromIdentityKey(core.getIdentityKey())
    },

    /**
     * @deprecated Use createDID() for spec-compliant DIDs.
     * Register a legacy DID as a BSV certificate.
     */
    async registerDID (options?: { persist?: boolean }): Promise<DIDDocument> {
      const { Certifier } = await import('./certification')
      const identityKey = core.getIdentityKey()
      const didDoc = DID.fromIdentityKey(identityKey)

      if (options?.persist !== false) {
        try {
          const certifier = await Certifier.create({
            certificateType: DID.getCertificateType()
          })

          await certifier.certify(core, {
            didId: didDoc.id,
            didType: 'identity',
            version: '1.0',
            created: new Date().toISOString(),
            isDID: 'true'
          })
        } catch (error) {
          throw new DIDError(`DID registration failed: ${(error as Error).message}`)
        }
      }

      return didDoc
    }
  }
}
