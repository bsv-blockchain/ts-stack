import {
  WalletInterface,
  Utils,
  PushDrop,
  LockingScript,
  Transaction,
  WalletProtocol,
  Base64String,
  PubKeyHex,
  Beef,
  Validation,
  WalletEncryptArgs,
  WalletDecryptArgs,
  CreateHmacArgs,
  VerifyHmacArgs,
  CreateSignatureArgs,
  VerifySignatureArgs,
  InternalizeActionArgs,
  ListOutputsArgs,
  RelinquishOutputArgs,
  GetPublicKeyArgs,
  CreateActionArgs,
  ListOutputsResult,
  ListActionsArgs,
  ListActionsResult
} from '@bsv/sdk'

import { parseBrc114ActionTimeLabels } from './utility/brc114ActionTimeLabels'

/// /// TODO: ADD SUPPORT FOR ADMIN COUNTERPARTIES BASED ON WALLET STORAGE
/// ///       PROHIBITION OF SPECIAL OPERATIONS IS ALSO CRITICAL.
/// /// !!!!!!!! SECURITY-CRITICAL ADDITION — DO NOT USE UNTIL IMPLEMENTED.

function deepEqual (object1: any, object2: any): boolean {
  if (object1 === null || object1 === undefined || object2 === null || object2 === undefined) {
    return object1 === object2
  }
  const keys1 = Object.keys(object1)
  const keys2 = Object.keys(object2)

  if (keys1.length !== keys2.length) {
    return false
  }

  for (const key of keys1) {
    const val1 = object1[key]
    const val2 = object2[key]
    const areObjects = isObject(val1) && isObject(val2)
    if ((areObjects && !deepEqual(val1, val2)) || (!areObjects && val1 !== val2)) {
      return false
    }
  }

  return true
}

function isObject (object: any): boolean {
  return object != null && typeof object === 'object'
}

/** Line item type for spending authorization requests. */
export type LineItemType = 'input' | 'output' | 'fee'

/** Security level for DPACP protocol permissions. */
export type SecurityLevel = 0 | 1 | 2

/**
 * A permissions module handles request/response transformation for a specific P-protocol or P-basket scheme under BRC-98/99.
 * Modules are registered in the config mapped by their scheme ID.
 */
export interface PermissionsModule {
  /**
   * Transforms the request before it's passed to the underlying wallet.
   * Can check and enforce permissions, throw errors, or modify any arguments as needed prior to invocation.
   *
   * @param req - The incoming request with method, args, and originator
   * @returns Transformed arguments that will be passed to the underlying wallet
   */
  onRequest: (req: { method: string, args: object, originator: string }) => Promise<{ args: object }>

  /**
   * Transforms the response from the underlying wallet before returning to caller.
   *
   * @param res - The response from the underlying wallet
   * @param context - Metadata about the original request (method, originator)
   * @returns Transformed response to return to the caller
   */
  onResponse: (
    res: any,
    context: {
      method: string
      originator: string
    }
  ) => Promise<any>
}

/**
 * Describes a group of permissions that can be requested together.
 * This structure is based on BRC-73.
 */
export interface GroupedPermissions {
  description?: string
  spendingAuthorization?: {
    amount: number
    description: string
  }
  protocolPermissions?: Array<{
    protocolID: WalletProtocol
    counterparty?: string
    description: string
  }>
  basketAccess?: Array<{
    basket: string
    description: string
  }>
  certificateAccess?: Array<{
    type: string
    fields: string[]
    verifierPublicKey: string
    description: string
  }>
}

/**
 * The object passed to the UI when a grouped permission is requested.
 */
export interface GroupedPermissionRequest {
  originator: string
  requestID: string
  permissions: GroupedPermissions
}

/**
 * Signature for functions that handle a grouped permission request event.
 */
export type GroupedPermissionEventHandler = (request: GroupedPermissionRequest) => void | Promise<void>

export interface CounterpartyPermissions {
  description?: string
  protocols: Array<{
    protocolName: string
    protocolID?: WalletProtocol
    description?: string
  }>
}

export interface CounterpartyPermissionRequest {
  originator: string
  requestID: string
  counterparty: PubKeyHex
  counterpartyLabel?: string
  permissions: CounterpartyPermissions
}

export type CounterpartyPermissionEventHandler = (request: CounterpartyPermissionRequest) => void | Promise<void>

/**
 * Describes a single requested permission that the user must either grant or deny.
 *
 * Four categories of permission are supported, each with a unique protocol:
 *  1) protocol - "DPACP" (Domain Protocol Access Control Protocol)
 *  2) basket   - "DBAP"  (Domain Basket Access Protocol)
 *  3) certificate - "DCAP" (Domain Certificate Access Protocol)
 *  4) spending - "DSAP"  (Domain Spending Authorization Protocol)
 *
 * This model underpins "requests" made to the user for permission, which the user can
 * either grant or deny. The manager can then create on-chain tokens (PushDrop outputs)
 * if permission is granted. Denying requests cause the underlying operation to throw,
 * and no token is created. An "ephemeral" grant is also possible, denoting a one-time
 * authorization without an associated persistent on-chain token.
 */
export interface PermissionRequest {
  type: 'protocol' | 'basket' | 'certificate' | 'spending'
  originator: string // The domain or FQDN of the requesting application
  displayOriginator?: string // Optional raw/original originator string for UI purposes
  usageType?: string // The usage context of the request (used for prompt coalescing)
  privileged?: boolean // For "protocol" or "certificate" usage, indicating privileged key usage
  protocolID?: WalletProtocol // For type='protocol': BRC-43 style (securityLevel, protocolName)
  counterparty?: string // For type='protocol': e.g. target public key or "self"/"anyone"

  basket?: string // For type='basket': the basket name being requested

  certificate?: {
    // For type='certificate': details about the cert usage
    verifier: string
    certType: string
    fields: string[]
  }

  spending?: {
    // For type='spending': details about the requested spend
    satoshis: number
    lineItems?: Array<{
      type: LineItemType
      description: string
      satoshis: number
    }>
  }

  reason?: string // Human-readable explanation for requesting permission
  renewal?: boolean // Whether this request is for renewing an expired token
  previousToken?: PermissionToken // If renewing an expired permission, reference to the old token
}

/**
 * Signature for functions that handle a permission request event, e.g. "Please ask the user to allow basket X".
 */
export type PermissionEventHandler = (request: PermissionRequest & { requestID: string }) => void | Promise<void>

/**
 * Data structure representing an on-chain permission token.
 * It is typically stored as a single unspent PushDrop output in a special "internal" admin basket belonging to
 * the user, held in their underlying wallet.
 *
 * It can represent any of the four permission categories by having the relevant fields:
 *  - DPACP: originator, privileged, protocol, securityLevel, counterparty
 *  - DBAP:  originator, basketName
 *  - DCAP:  originator, privileged, verifier, certType, certFields
 *  - DSAP:  originator, authorizedAmount
 */
export interface PermissionToken {
  /** The transaction ID where this token resides. */
  txid: string

  /** The current transaction encapsulating the token. */
  tx: number[]

  /** The output index within that transaction. */
  outputIndex: number

  /** The exact script hex for the locking script. */
  outputScript: string

  /** The amount of satoshis assigned to the permission output (often 1). */
  satoshis: number

  /** The originator domain or FQDN that is allowed to use this permission. */
  originator: string

  /**
   * The raw, unnormalized originator string captured at the time the permission
   * token was created. This is preserved so we can continue to recognize legacy
   * permissions that were stored with different casing or explicit default ports.
   */
  rawOriginator?: string

  /** The expiration time for this token in UNIX epoch seconds. (0 or omitted for spending authorizations, which are indefinite) */
  expiry: number

  /** Whether this token grants privileged usage (for protocol or certificate). */
  privileged?: boolean

  /** The protocol name, if this is a DPACP token. */
  protocol?: string

  /** The security level (0,1,2) for DPACP. */
  securityLevel?: SecurityLevel

  /** The counterparty, for DPACP. */
  counterparty?: string

  /** The name of a basket, if this is a DBAP token. */
  basketName?: string

  /** The certificate type, if this is a DCAP token. */
  certType?: string

  /** The certificate fields that this token covers, if DCAP token. */
  certFields?: string[]

  /** The "verifier" public key string, if DCAP. */
  verifier?: string

  /** For DSAP, the maximum authorized spending for the month. */
  authorizedAmount?: number
}

/**
 * A map from each permission type to a special "admin basket" name used for storing
 * the tokens. The tokens themselves are unspent transaction outputs (UTXOs) with a
 * specialized PushDrop script that references the originator, expiry, etc.
 */
const BASKET_MAP = {
  protocol: 'admin protocol-permission',
  basket: 'admin basket-access',
  certificate: 'admin certificate-access',
  spending: 'admin spending-authorization'
}

/**
 * The set of callbacks that external code can bind to, e.g. to display UI prompts or logs
 * when a permission is requested.
 */
export interface WalletPermissionsManagerCallbacks {
  onProtocolPermissionRequested?: PermissionEventHandler[]
  onBasketAccessRequested?: PermissionEventHandler[]
  onCertificateAccessRequested?: PermissionEventHandler[]
  onSpendingAuthorizationRequested?: PermissionEventHandler[]
  onGroupedPermissionRequested?: GroupedPermissionEventHandler[]
  onCounterpartyPermissionRequested?: CounterpartyPermissionEventHandler[]
}

/**
 * Configuration object for the WalletPermissionsManager. If a given option is `false`,
 * the manager will skip or alter certain permission checks or behaviors.
 *
 * By default, all of these are `true` unless specified otherwise. This is the most secure configuration.
 */
export interface PermissionsManagerConfig {
  /**
   * A map of P-basket/protocol permission scheme modules.
   *
   * Keys are scheme IDs (e.g., "btms"), values are PermissionsModule instances.
   *
   * Each module handles basket/protocol names of the form: `p <schemeID> <rest...>`
   *
   * The WalletPermissionManager detects P-prefix baskets/protocols and delegates
   * request/response transformation to the corresponding module.
   *
   * If no module exists for a given schemeID, the wallet will reject access.
   */
  permissionModules?: Record<string, PermissionsModule>

  /**
   * For `createSignature` and `verifySignature`,
   * require a "protocol usage" permission check?
   */
  seekProtocolPermissionsForSigning?: boolean

  /**
   * For methods that perform encryption (encrypt/decrypt), require
   * a "protocol usage" permission check?
   */
  seekProtocolPermissionsForEncrypting?: boolean

  /**
   * For methods that perform HMAC creation or verification (createHmac, verifyHmac),
   * require a "protocol usage" permission check?
   */
  seekProtocolPermissionsForHMAC?: boolean

  /**
   * For revealing counterparty-level or specific key linkage revelation information,
   * should we require permission?
   */
  seekPermissionsForKeyLinkageRevelation?: boolean

  /**
   * For revealing any user public key (getPublicKey) **other** than the identity key,
   * should we require permission?
   */
  seekPermissionsForPublicKeyRevelation?: boolean

  /**
   * If getPublicKey is requested with `identityKey=true`, do we require permission?
   */
  seekPermissionsForIdentityKeyRevelation?: boolean

  /**
   * If discoverByIdentityKey / discoverByAttributes are called, do we require permission
   * for "identity resolution" usage?
   */
  seekPermissionsForIdentityResolution?: boolean

  /**
   * When we do internalizeAction with `basket insertion`, or include outputs in baskets
   * with `createAction, do we ask for basket permission?
   */
  seekBasketInsertionPermissions?: boolean

  /**
   * When relinquishOutput is called, do we ask for basket permission?
   */
  seekBasketRemovalPermissions?: boolean

  /**
   * When listOutputs is called, do we ask for basket permission?
   */
  seekBasketListingPermissions?: boolean

  /**
   * When createAction is called with labels, do we ask for "label usage" permission?
   */
  seekPermissionWhenApplyingActionLabels?: boolean

  /**
   * When listActions is called with labels, do we ask for "label usage" permission?
   */
  seekPermissionWhenListingActionsByLabel?: boolean

  /**
   * If proving a certificate (proveCertificate) or revealing certificate fields,
   * do we require a "certificate access" permission?
   */
  seekCertificateDisclosurePermissions?: boolean

  /**
   * If acquiring a certificate (acquireCertificate), do we require a permission check?
   */
  seekCertificateAcquisitionPermissions?: boolean

  /**
   * If relinquishing a certificate (relinquishCertificate), do we require a permission check?
   */
  seekCertificateRelinquishmentPermissions?: boolean

  /**
   * If listing a user's certificates (listCertificates), do we require a permission check?
   */
  seekCertificateListingPermissions?: boolean

  /**
   * Should transaction descriptions, input descriptions, and output descriptions be encrypted
   * when before they are passed to the underlying wallet, and transparently decrypted when retrieved?
   */
  encryptWalletMetadata?: boolean

  /**
   * If the originator tries to spend wallet funds (netSpent > 0 in createAction),
   * do we seek spending authorization?
   */
  seekSpendingPermissions?: boolean

  /**
   * If true, triggers a grouped permission request flow based on the originator's `manifest.json`.
   */
  seekGroupedPermission?: boolean

  /**
   * If false, permissions are checked without regard for whether we are in
   * privileged mode. Privileged status is ignored with respect to whether
   * permissions are granted. Internally, they are always sought and checked
   * with privileged=false, regardless of the actual value.
   */
  differentiatePrivilegedOperations?: boolean

  /**
   * An allowlist mapping counterparty identity public keys (hex)
   * to protocol names that are automatically permitted
   * without prompting the user.
   */
  whitelistedCounterparties?: { [counterparty: PubKeyHex]: string[] }
}

/**
 * @class WalletPermissionsManager
 *
 * Wraps an underlying BRC-100 `Wallet` implementation with permissions management capabilities.
 * The manager intercepts calls from external applications (identified by originators), checks if the request is allowed,
 * and if not, orchestrates user permission flows. It creates or renews on-chain tokens in special
 * admin baskets to track these authorizations. Finally, it proxies the actual call to the underlying wallet.
 *
 * ### Key Responsibilities:
 *  - **Permission Checking**: Before standard wallet operations (e.g. `encrypt`),
 *    the manager checks if a valid permission token exists. If not, it attempts to request permission from the user.
 *  - **On-Chain Tokens**: When permission is granted, the manager stores it as an unspent "PushDrop" output.
 *    This can be spent later to revoke or renew the permission.
 *  - **Callbacks**: The manager triggers user-defined callbacks on permission requests (to show a UI prompt),
 *    on grants/denials, and on internal processes.
 *
 * ### Implementation Notes:
 *  - The manager follows the BRC-100 `createAction` + `signAction` pattern for building or spending these tokens.
 *  - Token revocation or renewal uses standard BRC-100 flows: we build a transaction that consumes
 *    the old token UTXO and outputs a new one (or none, if fully revoked).
 */
export class WalletPermissionsManager implements WalletInterface {
  /** A reference to the BRC-100 wallet instance. */
  private readonly underlying: WalletInterface

  /** The "admin" domain or FQDN that is implicitly allowed to do everything. */
  private readonly adminOriginator: string

  /**
   * Event callbacks that external code can subscribe to, e.g. to show a UI prompt
   * or log events. Each event can have multiple handlers.
   */
  private readonly callbacks: WalletPermissionsManagerCallbacks = {
    onProtocolPermissionRequested: [],
    onBasketAccessRequested: [],
    onCertificateAccessRequested: [],
    onSpendingAuthorizationRequested: [],
    onGroupedPermissionRequested: [],
    onCounterpartyPermissionRequested: []
  }

  /**
   * We queue parallel requests for the same resource so that only one
   * user prompt is created for a single resource. If multiple calls come
   * in at once for the same "protocol:domain:privileged:counterparty" etc.,
   * they get merged.
   *
   * The key is a string derived from the operation; the value is an object with a reference to the
   * associated request and an array of pending promise resolve/reject pairs, one for each active
   * operation that's waiting on the particular resource described by the key.
   */
  private readonly activeRequests: Map<
  string,
  {
    request:
    | PermissionRequest
    | { originator: string, permissions: GroupedPermissions, displayOriginator?: string }
    | {
      originator: string
      counterparty: PubKeyHex
      permissions: CounterpartyPermissions
      displayOriginator?: string
      counterpartyLabel?: string
    }
    pending: Array<{
      resolve: (val: any) => void
      reject: (err: any) => void
    }>
  }
  > = new Map()

  /** Cache recently confirmed permissions to avoid repeated lookups. */
  private readonly permissionCache: Map<string, { expiry: number, cachedAt: number }> = new Map()
  private readonly recentGrants: Map<string, number> = new Map()

  private readonly manifestCache: Map<
  string,
  {
    groupPermissions: GroupedPermissions | null
    counterpartyPermissions: CounterpartyPermissions | null
    fetchedAt: number
  }
  > = new Map()

  private readonly manifestFetchInProgress: Map<
  string,
  Promise<{ groupPermissions: GroupedPermissions | null, counterpartyPermissions: CounterpartyPermissions | null }>
  > = new Map()

  private static readonly MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000

  private readonly groupedPermissionFlowTail: Map<string, Promise<void>> = new Map()

  private readonly pactEstablishedCache: Map<string, number> = new Map()

  /** How long a cached permission remains valid (5 minutes). */
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000
  /** Window during which freshly granted permissions are auto-allowed (except spending). */
  private static readonly RECENT_GRANT_COVER_MS = 15 * 1000

  /** Default ports used when normalizing originator values. */
  private static readonly DEFAULT_PORTS: Record<string, string> = {
    'http:': '80',
    'https:': '443'
  }

  /**
   * Configuration that determines whether to skip or apply various checks and encryption.
   */
  private readonly config: PermissionsManagerConfig

  /**
   * Constructs a new Permissions Manager instance.
   *
   * @param underlyingWallet           The underlying BRC-100 wallet, where requests are forwarded after permission is granted
   * @param adminOriginator            The domain or FQDN that is automatically allowed everything
   * @param config                     A set of boolean flags controlling how strictly permissions are enforced
   */
  constructor (underlyingWallet: WalletInterface, adminOriginator: string, config: PermissionsManagerConfig = {}) {
    this.underlying = underlyingWallet
    this.adminOriginator = this.normalizeOriginator(adminOriginator) || adminOriginator

    // Default all config options to true unless specified
    this.config = {
      seekProtocolPermissionsForSigning: true,
      seekProtocolPermissionsForEncrypting: true,
      seekProtocolPermissionsForHMAC: true,
      seekPermissionsForKeyLinkageRevelation: true,
      seekPermissionsForPublicKeyRevelation: true,
      seekPermissionsForIdentityKeyRevelation: true,
      seekPermissionsForIdentityResolution: true,
      seekBasketInsertionPermissions: true,
      seekBasketRemovalPermissions: true,
      seekBasketListingPermissions: true,
      seekPermissionWhenApplyingActionLabels: true,
      seekPermissionWhenListingActionsByLabel: true,
      seekCertificateDisclosurePermissions: true,
      seekCertificateAcquisitionPermissions: true,
      seekCertificateRelinquishmentPermissions: true,
      seekCertificateListingPermissions: true,
      encryptWalletMetadata: true,
      seekSpendingPermissions: true,
      seekGroupedPermission: true,
      differentiatePrivilegedOperations: true,
      whitelistedCounterparties: {},
      ...config // override with user-specified config
    }
  }

  /* ---------------------------------------------------------------------
   *  HELPER METHODS FOR P-MODULE DELEGATION
   * --------------------------------------------------------------------- */

  /**
   * Delegates a wallet method call to a P-module if the basket or protocol name uses a P-scheme.
   * Handles the full request/response transformation flow.
   *
   * @param basketOrProtocolName - The basket or protocol name to check for p-module delegation
   * @param method - The wallet method name being called
   * @param args - The original args passed to the method
   * @param originator - The originator of the request
   * @param underlyingCall - Callback that executes the underlying wallet method with transformed args
   * @returns The transformed response, or null if not a P-basket/protocol (caller should continue normal flow)
   */
  private async delegateToPModuleIfNeeded<T>(
    basketOrProtocolName: string,
    method: string,
    args: object,
    originator: string,
    underlyingCall: (transformedArgs: object, originator: string) => Promise<T>
  ): Promise<T | null> {
    // Check if this is a P-protocol/basket
    if (!basketOrProtocolName.startsWith('p ')) {
      return null // If not, caller should continue normal flow
    }

    const schemeID = basketOrProtocolName.split(' ')[1]
    const module = this.config.permissionModules?.[schemeID]

    if (module == null) {
      throw new Error(`Unsupported P-module scheme: p ${schemeID}`)
    }

    // Transform request with module
    const transformedReq = await module.onRequest({
      method,
      args,
      originator
    })

    // Call underlying method with transformed request
    const results = await underlyingCall(transformedReq.args, originator)

    // Transform response with module
    return await module.onResponse(results, {
      method,
      originator
    })
  }

  /**
   * Adds a permission module for the given schemeID if needed, throwing if unsupported.
   */
  private addPModuleByScheme (
    schemeID: string,
    kind: 'label' | 'basket',
    pModulesByScheme: Map<string, PermissionsModule>
  ): void {
    if (pModulesByScheme.has(schemeID)) return
    const module = this.config.permissionModules?.[schemeID]
    if (module == null) {
      throw new Error(`Unsupported P-${kind} scheme: p ${schemeID}`)
    }
    pModulesByScheme.set(schemeID, module)
  }

  /**
   * Splits labels into P and non-P lists, registering any P-modules encountered.
   *
   * P-labels follow BRC-111 format: `p <moduleId> <payload>`
   * - Must start with "p " (lowercase p + space)
   * - Module ID must be at least 1 character with no spaces
   * - Single space separates module ID from payload
   * - Payload must be at least 1 character
   *
   * @example Valid: "p btms token123", "p invoicing invoice 2026-02-02"
   * @example Invalid: "p btms" (no payload), "p btms " (empty payload), "p  data" (empty moduleId)
   *
   * @param labels - Array of label strings to process
   * @param pModulesByScheme - Map to populate with discovered p-modules
   * @returns Array of non-P labels for normal permission checks
   * @throws Error if p-label format is invalid or module is unsupported
   */
  private splitLabelsByPermissionModule (
    labels: string[] | undefined,
    pModulesByScheme: Map<string, PermissionsModule>
  ): string[] {
    const nonPLabels: string[] = []
    if (labels == null) return nonPLabels

    for (const label of labels) {
      if (label.startsWith('p ')) {
        // Remove "p " prefix to get "moduleId payload"
        const remainder = label.slice(2)

        // Find the space that separates moduleId from payload
        const separatorIndex = remainder.indexOf(' ')

        // Validate: must have a space (separatorIndex > 0) and payload after it
        // separatorIndex <= 0 means no space found or moduleId is empty
        // separatorIndex === remainder.length - 1 means space is last char (no payload)
        if (separatorIndex <= 0 || separatorIndex === remainder.length - 1) {
          throw new Error(`Invalid P-label format: ${label}`)
        }

        // Reject double spaces after moduleId (payload can't start with space)
        if (remainder[separatorIndex + 1] === ' ') {
          throw new Error(`Invalid P-label format: ${label}`)
        }

        // Extract moduleId (substring before first space)
        const schemeID = remainder.slice(0, separatorIndex)

        // Register the module (throws if unsupported)
        this.addPModuleByScheme(schemeID, 'label', pModulesByScheme)
      } else {
        // Regular label - add to list for normal permission checks
        nonPLabels.push(label)
      }
    }

    return nonPLabels
  }

  /**
   * Decrypts custom instructions in listOutputs results if encryption is configured.
   */
  private async decryptListOutputsMetadata (results: ListOutputsResult): Promise<ListOutputsResult> {
    if (results.outputs) {
      for (const output of results.outputs) {
        if (output.customInstructions) {
          output.customInstructions = await this.maybeDecryptMetadata(
            output.customInstructions
          )
        }
      }
    }
    return results
  }

  /**
   * Decrypts metadata in listActions results if encryption is configured.
   */
  private async decryptListActionsMetadata (results: ListActionsResult): Promise<ListActionsResult> {
    if (results.actions) {
      for (const action of results.actions) {
        await this.decryptSingleActionMetadata(action)
      }
    }
    return results
  }

  private async decryptSingleActionMetadata (action: ListActionsResult['actions'][number]): Promise<void> {
    if (action.description) {
      action.description = await this.maybeDecryptMetadata(action.description)
    }
    if (action.inputs != null) {
      for (const input of action.inputs) {
        if (input.inputDescription) {
          input.inputDescription = await this.maybeDecryptMetadata(input.inputDescription)
        }
      }
    }
    if (action.outputs != null) {
      for (const output of action.outputs) {
        await this.decryptActionOutputMetadata(output)
      }
    }
  }

  private async decryptActionOutputMetadata (output: NonNullable<ListActionsResult['actions'][number]['outputs']>[number]): Promise<void> {
    if (output.outputDescription) {
      output.outputDescription = await this.maybeDecryptMetadata(output.outputDescription)
    }
    if (output.customInstructions) {
      output.customInstructions = await this.maybeDecryptMetadata(output.customInstructions)
    }
  }

  /* ---------------------------------------------------------------------
   *  1) PUBLIC API FOR REGISTERING CALLBACKS (UI PROMPTS, LOGGING, ETC.)
   * --------------------------------------------------------------------- */

  /**
   * Binds a callback function to a named event, such as `onProtocolPermissionRequested`.
   *
   * @param eventName The name of the event to listen to
   * @param handler   A function that handles the event
   * @returns         A numeric ID you can use to unbind later
   */
  public bindCallback (
    eventName: keyof WalletPermissionsManagerCallbacks,
    handler: PermissionEventHandler | GroupedPermissionEventHandler | CounterpartyPermissionEventHandler
  ): number {
    const arr = this.callbacks[eventName]! as any[]
    arr.push(handler)
    return arr.length - 1
  }

  /**
   * Unbinds a previously registered callback by either its numeric ID (returned by `bindCallback`)
   * or by exact function reference.
   *
   * @param eventName  The event name, e.g. "onProtocolPermissionRequested"
   * @param reference  Either the numeric ID or the function reference
   * @returns          True if successfully unbound, false otherwise
   */
  public unbindCallback (eventName: keyof WalletPermissionsManagerCallbacks, reference: number | Function): boolean {
    if (this.callbacks[eventName] == null) return false
    const arr = this.callbacks[eventName] as any[]
    if (typeof reference === 'number') {
      if (arr[reference]) {
        arr[reference] = null
        return true
      }
      return false
    } else {
      const index = arr.indexOf(reference)
      if (index !== -1) {
        arr[index] = null
        return true
      }
      return false
    }
  }

  /**
   * Internally triggers a named event, calling all subscribed listeners.
   * Each callback is awaited in turn (though errors are swallowed so that
   * one failing callback doesn't prevent the others).
   *
   * @param eventName The event name
   * @param param     The parameter object passed to all listeners
   */
  private async callEvent (eventName: keyof WalletPermissionsManagerCallbacks, param: any): Promise<void> {
    const arr = this.callbacks[eventName] || []
    for (const cb of arr) {
      if (typeof cb === 'function') {
        try {
          await cb(param)
        } catch (_callbackError) {
          // Intentionally swallow errors from user-provided callbacks to prevent
          // a misbehaving callback from disrupting the event dispatch loop.
        }
      }
    }
  }

  /* ---------------------------------------------------------------------
   *  2) PERMISSION (GRANT / DENY) METHODS
   * --------------------------------------------------------------------- */

  /**
   * Grants a previously requested permission.
   * This method:
   *  1) Resolves all pending promise calls waiting on this request
   *  2) Optionally creates or renews an on-chain PushDrop token (unless `ephemeral===true`)
   *
   * @param params      requestID to identify which request is granted, plus optional expiry
   *                    or `ephemeral` usage, etc.
   */
  public async grantPermission (params: {
    requestID: string
    expiry?: number
    ephemeral?: boolean
    amount?: number
  }): Promise<void> {
    // 1) Identify the matching queued requests in `activeRequests`
    const matching = this.activeRequests.get(params.requestID)
    if (matching == null) {
      throw new Error('Request ID not found.')
    }

    // 2) Mark all matching requests as resolved, deleting the entry
    for (const x of matching.pending) {
      x.resolve(true)
    }
    this.activeRequests.delete(params.requestID)

    // 3) If `ephemeral !== true`, we create or renew an on-chain token
    if (!params.ephemeral) {
      const request = matching.request as PermissionRequest
      if (request.renewal) {
        // renewal => spend the old token, produce a new one
        await this.renewPermissionOnChain(
          request.previousToken!,
          request,
          params.expiry || 0, // default: never expires
          params.amount
        )
      } else {
        // brand-new permission token
        await this.createPermissionOnChain(
          request,
          params.expiry || 0, // default: never expires
          params.amount
        )
      }
    }

    // Only cache non-ephemeral permissions
    // Ephemeral permissions should not be cached as they are one-time authorizations
    if (!params.ephemeral) {
      const expiry = params.expiry || 0 // default: never expires
      const key = this.buildRequestKey(matching.request as PermissionRequest)
      this.cachePermission(key, expiry)
      this.markRecentGrant(matching.request as PermissionRequest)
    }
  }

  /**
   * Denies a previously requested permission.
   * This method rejects all pending promise calls waiting on that request
   *
   * @param requestID    requestID identifying which request to deny
   */
  public async denyPermission (requestID: string): Promise<void> {
    // 1) Identify the matching requests
    const matching = this.activeRequests.get(requestID)
    if (matching == null) {
      throw new Error('Request ID not found.')
    }

    // 2) Reject all matching requests, deleting the entry
    for (const x of matching.pending) {
      x.reject(new Error('Permission denied.'))
    }
    this.activeRequests.delete(requestID)
  }

  /**
   * Grants a previously requested grouped permission.
   * @param params.requestID The ID of the request being granted.
   * @param params.granted A subset of the originally requested permissions that the user has granted.
   * @param params.expiry An optional expiry time (in seconds) for the new permission tokens.
   */
  public async grantGroupedPermission (params: {
    requestID: string
    granted: Partial<GroupedPermissions>
    expiry?: number
  }): Promise<void> {
    const matching = this.activeRequests.get(params.requestID)
    if (matching == null) {
      throw new Error('Request ID not found.')
    }

    try {
      const originalRequest = matching.request as {
        originator: string
        permissions: GroupedPermissions
        displayOriginator?: string
      }
      const { originator, permissions: requestedPermissions, displayOriginator } = originalRequest
      const originLookupValues = this.buildOriginatorLookupValues(displayOriginator, originator)

      this.validateGrantedPermissionsSubset(params.granted, requestedPermissions)

      const expiry = params.expiry || 0 // default: never expires

      const toCreate: Array<{ request: PermissionRequest, expiry: number, amount?: number }> = []
      const toRenew: Array<{ oldToken: PermissionToken, request: PermissionRequest, expiry: number, amount?: number }> =
        []

      if (params.granted.spendingAuthorization != null) {
        toCreate.push({
          request: {
            type: 'spending',
            originator,
            spending: { satoshis: params.granted.spendingAuthorization.amount },
            reason: params.granted.spendingAuthorization.description
          },
          expiry: 0,
          amount: params.granted.spendingAuthorization.amount
        })
      }

      const grantedProtocols = params.granted.protocolPermissions || []
      const protocolTokens = await this.mapWithConcurrency(grantedProtocols, 8, async p => {
        const counterparty = (p.protocolID?.[0] ?? 0) === 1 ? '' : p.counterparty || 'self'
        const token = await this.findProtocolToken(
          originator,
          false,
          p.protocolID,
          counterparty,
          true,
          originLookupValues
        )
        return { p, token, counterparty }
      })

      for (const { p, token, counterparty } of protocolTokens) {
        const request: PermissionRequest = {
          type: 'protocol',
          originator,
          privileged: false,
          protocolID: p.protocolID,
          counterparty,
          reason: p.description
        }
        if (token == null) {
          toCreate.push({ request, expiry })
        } else {
          toRenew.push({ oldToken: token, request, expiry })
        }
      }

      for (const b of params.granted.basketAccess || []) {
        toCreate.push({
          request: { type: 'basket', originator, basket: b.basket, reason: b.description },
          expiry
        })
      }

      for (const c of params.granted.certificateAccess || []) {
        toCreate.push({
          request: {
            type: 'certificate',
            originator,
            privileged: false,
            certificate: {
              verifier: c.verifierPublicKey,
              certType: c.type,
              fields: c.fields
            },
            reason: c.description
          },
          expiry
        })
      }

      const created = await this.createPermissionTokensBestEffort(toCreate)
      const renewed = await this.renewPermissionTokensBestEffort(toRenew)
      for (const req of [...created, ...renewed]) {
        this.markRecentGrant(req)
      }

      // Success - resolve all pending promises for this request
      for (const p of matching.pending) {
        p.resolve(true)
      }
    } catch (error) {
      // Failure - reject all pending promises so callers don't hang forever
      for (const p of matching.pending) {
        p.reject(error)
      }
      throw error
    } finally {
      // Always clean up the request entry
      this.activeRequests.delete(params.requestID)
    }
  }

  /**
   * Denies a previously requested grouped permission.
   * @param requestID The ID of the request being denied.
   */
  /**
   * Validates that every entry in `granted` was part of the original `requested` set.
   * Throws an error on the first mismatch.
   */
  private validateGrantedPermissionsSubset (granted: Partial<GroupedPermissions>, requested: GroupedPermissions): void {
    if ((granted.spendingAuthorization != null) && (requested.spendingAuthorization == null)) {
      throw new Error('Granted spending authorization was not part of the original request.')
    }
    if (granted.protocolPermissions?.some(g => (requested.protocolPermissions?.find(r => deepEqual(r, g))) == null)) {
      throw new Error('Granted protocol permissions are not a subset of the original request.')
    }
    if (granted.basketAccess?.some(g => (requested.basketAccess?.find(r => deepEqual(r, g))) == null)) {
      throw new Error('Granted basket access permissions are not a subset of the original request.')
    }
    if (granted.certificateAccess?.some(g => (requested.certificateAccess?.find(r => deepEqual(r, g))) == null)) {
      throw new Error('Granted certificate access permissions are not a subset of the original request.')
    }
  }

  private denyActiveRequest (requestID: string): void {
    const matching = this.activeRequests.get(requestID)
    if (matching == null) {
      throw new Error('Request ID not found.')
    }
    const err = new Error('The user has denied the request for permission.')
    ;(err as any).code = 'ERR_PERMISSION_DENIED'
    for (const p of matching.pending) {
      p.reject(err)
    }
    this.activeRequests.delete(requestID)
  }

  public async denyGroupedPermission (requestID: string): Promise<void> {
    this.denyActiveRequest(requestID)
  }

  public async dismissGroupedPermission (requestID: string): Promise<void> {
    const matching = this.activeRequests.get(requestID)
    if (matching == null) {
      throw new Error('Request ID not found.')
    }
    for (const p of matching.pending) {
      p.resolve(true)
    }
    this.activeRequests.delete(requestID)
  }

  public async grantCounterpartyPermission (params: {
    requestID: string
    granted: Partial<CounterpartyPermissions>
    expiry?: number
  }): Promise<void> {
    const matching = this.activeRequests.get(params.requestID)
    if (matching == null) {
      throw new Error('Request ID not found.')
    }

    const originalRequest = matching.request as {
      originator: string
      counterparty: PubKeyHex
      permissions: CounterpartyPermissions
      displayOriginator?: string
      counterpartyLabel?: string
    }
    const { originator, counterparty, permissions: requestedPermissions, displayOriginator } = originalRequest
    const originLookupValues = this.buildOriginatorLookupValues(displayOriginator, originator)

    const getProtoName = (p: any): string | undefined => {
      if (!p) return undefined
      if (typeof p.protocolName === 'string') return p.protocolName
      if (Array.isArray(p.protocolID) && typeof p.protocolID[1] === 'string') return p.protocolID[1]
      return undefined
    }

    if (
      params.granted.protocols?.some(g => {
        const gName = getProtoName(g)
        if (!gName) return true
        return !requestedPermissions.protocols.some(r => r.protocolName === gName)
      })
    ) {
      throw new Error('Granted protocol permissions are not a subset of the original request.')
    }

    const expiry = params.expiry || 0

    const toCreate: Array<{ request: PermissionRequest, expiry: number, amount?: number }> = []
    const toRenew: Array<{ oldToken: PermissionToken, request: PermissionRequest, expiry: number, amount?: number }> =
      []

    const grantedProtocols = params.granted.protocols || []
    const protocolTokens = await this.mapWithConcurrency(grantedProtocols, 8, async p => {
      const protocolName = getProtoName(p)
      if (!protocolName) {
        throw new Error('Invalid counterparty permission protocol entry: missing protocolName/protocolID.')
      }
      const protocolID: WalletProtocol = [2, protocolName]
      const token = await this.findProtocolToken(originator, false, protocolID, counterparty, true, originLookupValues)
      return { p, token, protocolID }
    })

    for (const { p, token, protocolID } of protocolTokens) {
      const request: PermissionRequest = {
        type: 'protocol',
        originator,
        privileged: false,
        protocolID,
        counterparty,
        reason: p.description
      }
      if (token == null) {
        toCreate.push({ request, expiry })
      } else {
        toRenew.push({ oldToken: token, request, expiry })
      }
    }

    const created = await this.createPermissionTokensBestEffort(toCreate)
    const renewed = await this.renewPermissionTokensBestEffort(toRenew)
    for (const req of [...created, ...renewed]) {
      this.markRecentGrant(req)
    }

    for (const p of matching.pending) {
      p.resolve(true)
    }
    this.activeRequests.delete(params.requestID)
  }

  public async denyCounterpartyPermission (requestID: string): Promise<void> {
    this.denyActiveRequest(requestID)
  }

  /* ---------------------------------------------------------------------
   *  3) THE "ENSURE" METHODS: CHECK IF PERMISSION EXISTS, OTHERWISE PROMPT
   * --------------------------------------------------------------------- */

  /**
   * Ensures the originator has protocol usage permission.
   * If no valid (unexpired) permission token is found, triggers a permission request flow.
   */
  public async ensureProtocolPermission ({
    originator,
    privileged,
    protocolID,
    counterparty,
    reason,
    seekPermission = true,
    usageType
  }: {
    originator: string
    privileged: boolean
    protocolID: WalletProtocol
    counterparty: string
    reason?: string
    seekPermission?: boolean
    usageType: 'signing' | 'encrypting' | 'hmac' | 'publicKey' | 'identityKey' | 'linkageRevelation' | 'generic'
  }): Promise<boolean> {
    const { normalized: normalizedOriginator, lookupValues } = this.prepareOriginator(originator)
    originator = normalizedOriginator
    // 1) adminOriginator can do anything
    if (this.isAdminOriginator(originator)) return true

    // 2) If security level=0, we consider it “open” usage
    const [level, protoName] = protocolID
    if (level === 0) return true
    if (level === 1) counterparty = ''

    // 3) If protocol is admin-reserved, block
    if (this.isAdminProtocol(protocolID)) {
      throw new Error(`Protocol “${protoName}” is admin-only.`)
    }

    // Allow the configured exceptions.
    if (this.isProtocolUsageTypeExempted(usageType)) return true
    if (!this.config.differentiatePrivilegedOperations) privileged = false
    if (!privileged && this.isWhitelistedCounterpartyProtocol(counterparty, protocolID)) return true

    const cacheKey = this.buildRequestKey({ type: 'protocol', originator, privileged, protocolID, counterparty })
    if (this.isPermissionCached(cacheKey) || this.isRecentlyGranted(cacheKey)) return true

    // 4) Attempt to find a valid token in the internal basket
    const token = await this.findProtocolToken(
      originator, privileged, protocolID, counterparty, /* includeExpired= */ true, lookupValues
    )

    if (token == null) {
      // No token found => request a new one if allowed
      if (!seekPermission) throw new Error('No protocol permission token found (seekPermission=false).')
      return await this.requestPermissionFlow({
        type: 'protocol', originator, privileged, protocolID, counterparty, usageType, reason, renewal: false
      })
    }

    if (this.isTokenExpired(token.expiry)) {
      // has a token but expired => request renewal if allowed
      if (!seekPermission) {
        throw new Error('Protocol permission expired and no further user consent allowed (seekPermission=false).')
      }
      return await this.requestPermissionFlow({
        type: 'protocol', originator, privileged, protocolID, counterparty, usageType, reason,
        renewal: true, previousToken: token
      })
    }

    // valid and unexpired
    this.cachePermission(cacheKey, token.expiry)
    return true
  }

  /**
   * Ensures the originator has basket usage permission for the specified basket.
   * If not, triggers a permission request flow.
   */
  public async ensureBasketAccess ({
    originator,
    basket,
    reason,
    seekPermission = true,
    usageType
  }: {
    originator: string
    basket: string
    reason?: string
    seekPermission?: boolean
    usageType: 'insertion' | 'removal' | 'listing'
  }): Promise<boolean> {
    const { normalized: normalizedOriginator, lookupValues } = this.prepareOriginator(originator)
    originator = normalizedOriginator
    if (this.isAdminOriginator(originator)) return true
    if (this.isAdminBasket(basket)) throw new Error(`Basket “${basket}” is admin-only.`)
    if (!this.isBasketUsageRequired(usageType)) return true

    const cacheKey = this.buildRequestKey({ type: 'basket', originator, basket })
    if (this.isPermissionCached(cacheKey) || this.isRecentlyGranted(cacheKey)) return true

    const token = await this.findBasketToken(originator, basket, true, lookupValues)
    if (token == null) {
      if (!seekPermission) throw new Error('No basket permission found, and no user consent allowed (seekPermission=false).')
      return await this.requestPermissionFlow({ type: 'basket', originator, basket, usageType, reason, renewal: false })
    }

    if (this.isTokenExpired(token.expiry)) {
      if (!seekPermission) throw new Error('Basket permission expired (seekPermission=false).')
      return await this.requestPermissionFlow({
        type: 'basket', originator, basket, usageType, reason, renewal: true, previousToken: token
      })
    }

    this.cachePermission(cacheKey, token.expiry)
    return true
  }

  /** Returns false when the basket usageType does NOT need a permission check (config-gated). */
  private isBasketUsageRequired (usageType: 'insertion' | 'removal' | 'listing'): boolean {
    if (usageType === 'insertion' && !this.config.seekBasketInsertionPermissions) return false
    if (usageType === 'removal' && !this.config.seekBasketRemovalPermissions) return false
    if (usageType === 'listing' && !this.config.seekBasketListingPermissions) return false
    return true
  }

  /**
   * Ensures the originator has a valid certificate permission.
   * This is relevant when revealing certificate fields in DCAP contexts.
   */
  public async ensureCertificateAccess ({
    originator,
    privileged,
    verifier,
    certType,
    fields,
    reason,
    seekPermission = true,
    usageType
  }: {
    originator: string
    privileged: boolean
    verifier: string
    certType: string
    fields: string[]
    reason?: string
    seekPermission?: boolean
    usageType: 'disclosure'
  }): Promise<boolean> {
    const { normalized: normalizedOriginator, lookupValues } = this.prepareOriginator(originator)
    originator = normalizedOriginator
    if (this.isAdminOriginator(originator)) return true
    if (usageType === 'disclosure' && !this.config.seekCertificateDisclosurePermissions) {
      return true
    }
    if (!this.config.differentiatePrivilegedOperations) {
      privileged = false
    }
    const cacheKey = this.buildRequestKey({
      type: 'certificate',
      originator,
      privileged,
      certificate: { verifier, certType, fields }
    })
    if (this.isPermissionCached(cacheKey)) {
      return true
    }
    if (this.isRecentlyGranted(cacheKey)) {
      return true
    }

    const token = await this.findCertificateToken(
      originator,
      privileged,
      verifier,
      certType,
      fields,
      /* includeExpired= */ true,
      lookupValues
    )
    if (token == null) {
      if (!seekPermission) {
        throw new Error('No certificate permission found (seekPermission=false).')
      }
      return await this.requestPermissionFlow({
        type: 'certificate',
        originator,
        privileged,
        certificate: { verifier, certType, fields },
        usageType,
        reason,
        renewal: false
      })
    }

    if (this.isTokenExpired(token.expiry)) {
      if (!seekPermission) {
        throw new Error('Certificate permission expired (seekPermission=false).')
      }
      return await this.requestPermissionFlow({
        type: 'certificate',
        originator,
        privileged,
        certificate: { verifier, certType, fields },
        usageType,
        reason,
        renewal: true,
        previousToken: token
      })
    }

    this.cachePermission(cacheKey, token.expiry)
    return true
  }

  /**
   * Ensures the originator has spending authorization (DSAP) for a certain satoshi amount.
   * If the existing token limit is insufficient, attempts to renew. If no token, attempts to create one.
   */
  public async ensureSpendingAuthorization ({
    originator,
    satoshis,
    lineItems,
    reason,
    seekPermission = true
  }: {
    originator: string
    satoshis: number
    lineItems?: Array<{
      type: LineItemType
      description: string
      satoshis: number
    }>
    reason?: string
    seekPermission?: boolean
  }): Promise<boolean> {
    const { normalized: normalizedOriginator, lookupValues } = this.prepareOriginator(originator)
    originator = normalizedOriginator
    if (this.isAdminOriginator(originator)) return true
    if (!this.config.seekSpendingPermissions) {
      // We skip spending permission entirely
      return true
    }
    const cacheKey = this.buildRequestKey({ type: 'spending', originator, spending: { satoshis } })
    if (this.isPermissionCached(cacheKey)) {
      return true
    }
    const token = await this.findSpendingToken(originator, lookupValues)
    if (token?.authorizedAmount) {
      // Check how much has been spent so far
      const spentSoFar = await this.querySpentSince(token)
      if (spentSoFar + satoshis <= token.authorizedAmount) {
        this.cachePermission(cacheKey, token.expiry)
        return true
      } else {
        // Renew if possible
        if (!seekPermission) {
          throw new Error(
            `Spending authorization insufficient for ${satoshis}, no user consent (seekPermission=false).`
          )
        }
        return await this.requestPermissionFlow({
          type: 'spending',
          originator,
          spending: { satoshis, lineItems },
          reason,
          renewal: true,
          previousToken: token
        })
      }
    } else {
      // no token
      if (!seekPermission) {
        throw new Error('No spending authorization found, (seekPermission=false).')
      }
      return await this.requestPermissionFlow({
        type: 'spending',
        originator,
        spending: { satoshis, lineItems },
        reason,
        renewal: false
      })
    }
  }

  /**
   * Ensures the originator has label usage permission.
   * If no valid (unexpired) permission token is found, triggers a permission request flow.
   */
  public async ensureLabelAccess ({
    originator,
    label,
    reason,
    seekPermission = true,
    usageType
  }: {
    originator: string
    label: string
    reason?: string
    seekPermission?: boolean
    usageType: 'apply' | 'list'
  }): Promise<boolean> {
    const { normalized: normalizedOriginator } = this.prepareOriginator(originator)
    originator = normalizedOriginator
    // 1) adminOriginator can do anything
    if (this.isAdminOriginator(originator)) return true

    // 2) If label is admin-reserved, block
    if (this.isAdminLabel(label)) {
      throw new Error(`Label “${label}” is admin-only.`)
    }

    if (usageType === 'apply' && !this.config.seekPermissionWhenApplyingActionLabels) {
      return true
    }
    if (usageType === 'list' && !this.config.seekPermissionWhenListingActionsByLabel) {
      return true
    }

    const cacheKey = this.buildRequestKey({
      type: 'protocol',
      originator,
      privileged: false,
      protocolID: [1, `action label ${label}`],
      counterparty: 'self'
    })
    if (this.isPermissionCached(cacheKey)) {
      return true
    }

    // 3) Let ensureProtocolPermission handle the rest.
    return await this.ensureProtocolPermission({
      originator,
      privileged: false,
      protocolID: [1, `action label ${label}`],
      counterparty: 'self',
      reason,
      seekPermission,
      usageType: 'generic'
    })
  }

  /**
   * Returns true when the given usageType is configured to skip permission checks.
   */
  private isProtocolUsageTypeExempted (
    usageType: 'signing' | 'encrypting' | 'hmac' | 'publicKey' | 'identityKey' | 'linkageRevelation' | 'generic'
  ): boolean {
    if (usageType === 'signing' && !this.config.seekProtocolPermissionsForSigning) return true
    if (usageType === 'encrypting' && !this.config.seekProtocolPermissionsForEncrypting) return true
    if (usageType === 'hmac' && !this.config.seekProtocolPermissionsForHMAC) return true
    if (usageType === 'publicKey' && !this.config.seekPermissionsForPublicKeyRevelation) return true
    if (usageType === 'identityKey' && !this.config.seekPermissionsForIdentityKeyRevelation) return true
    if (usageType === 'linkageRevelation' && !this.config.seekPermissionsForKeyLinkageRevelation) return true
    return false
  }

  private isProtocolInCounterpartyPermissions (
    protocolID: WalletProtocol,
    counterpartyPermissions: CounterpartyPermissions
  ): boolean {
    const [, name] = protocolID
    return counterpartyPermissions.protocols.some(p => p.protocolName === name)
  }

  private validateCounterpartyPermissions (raw: any): CounterpartyPermissions | null {
    if (!raw || !Array.isArray(raw.protocols) || raw.protocols.length === 0) return null

    const getCI = (obj: any, key: string): any => {
      if (!obj || typeof obj !== 'object') return undefined
      const lower = key.toLowerCase()
      const found = Object.keys(obj).find(k => k.toLowerCase() === lower)
      return found ? obj[found] : undefined
    }

    const parseProtocolId = (v: any): string | null => {
      if (!Array.isArray(v)) return null
      if (v[0] !== 2) return null
      if (typeof v[1] !== 'string') return null
      return v[1]
    }

    const validProtocols: CounterpartyPermissions['protocols'] = raw.protocols
      .map((p: any) => {
        const protocolName = getCI(p, 'protocolName')
        if (typeof protocolName === 'string') {
          return {
            protocolName,
            protocolID: [2, protocolName] as WalletProtocol,
            description: typeof p?.description === 'string' ? p.description : undefined
          }
        }

        const protocolIdRaw = getCI(p, 'protocolID') ?? getCI(p, 'protocolId') ?? getCI(p, 'protocolid')

        const parsed = parseProtocolId(protocolIdRaw)
        if (!parsed) return null

        return {
          protocolName: parsed,
          protocolID: [2, parsed] as WalletProtocol,
          description: typeof p?.description === 'string' ? p.description : undefined
        }
      })
      .filter(Boolean)

    if (validProtocols.length === 0) return null

    return {
      description: typeof raw.description === 'string' ? raw.description : undefined,
      protocols: validProtocols
    }
  }

  private async fetchManifestPermissions (originator: string): Promise<{
    groupPermissions: GroupedPermissions | null
    counterpartyPermissions: CounterpartyPermissions | null
  }> {
    const cached = this.manifestCache.get(originator)
    if ((cached != null) && Date.now() - cached.fetchedAt < WalletPermissionsManager.MANIFEST_CACHE_TTL_MS) {
      return {
        groupPermissions: cached.groupPermissions,
        counterpartyPermissions: cached.counterpartyPermissions
      }
    }

    const inProgress = this.manifestFetchInProgress.get(originator)
    if (inProgress != null) {
      return await inProgress
    }

    const fetchPromise = (async (): Promise<{
      groupPermissions: GroupedPermissions | null
      counterpartyPermissions: CounterpartyPermissions | null
    }> => {
      try {
        const proto = originator.startsWith('localhost:') ? 'http' : 'https'
        const response = await fetch(`${proto}://${originator}/manifest.json`)
        if (response.ok) {
          const manifest = await response.json()
          const namespace = manifest?.metanet || manifest?.babbage
          const groupPermissions: GroupedPermissions | null = namespace?.groupPermissions || null
          const counterpartyPermissionsDeclared: CounterpartyPermissions | null = this.validateCounterpartyPermissions(
            namespace?.counterpartyPermissions
          )
          this.manifestCache.set(originator, {
            groupPermissions,
            counterpartyPermissions: counterpartyPermissionsDeclared,
            fetchedAt: Date.now()
          })
          return { groupPermissions, counterpartyPermissions: counterpartyPermissionsDeclared }
        }
      } catch (_manifestFetchError) {
        // Manifest fetch or parse failed — fall through to return null/null defaults below
      }

      const result = { groupPermissions: null, counterpartyPermissions: null }
      this.manifestCache.set(originator, { ...result, fetchedAt: Date.now() })
      return result
    })()

    this.manifestFetchInProgress.set(originator, fetchPromise)
    try {
      return await fetchPromise
    } finally {
      this.manifestFetchInProgress.delete(originator)
    }
  }

  private async fetchManifestGroupPermissions (originator: string): Promise<GroupedPermissions | null> {
    const { groupPermissions } = await this.fetchManifestPermissions(originator)
    return groupPermissions
  }

  private async filterAlreadyGrantedPermissions (
    originator: string,
    groupPermissions: GroupedPermissions
  ): Promise<GroupedPermissions> {
    const permissionsToRequest: GroupedPermissions = {
      description: groupPermissions.description,
      protocolPermissions: [],
      basketAccess: [],
      certificateAccess: []
    }

    const [spendingAuthorization, protocolPermissions, basketAccess, certificateAccess] = await Promise.all([
      (async () => {
        if (groupPermissions.spendingAuthorization == null) return undefined
        const hasAuth = await this.hasSpendingAuthorization({
          originator,
          satoshis: groupPermissions.spendingAuthorization.amount
        })
        return hasAuth ? undefined : groupPermissions.spendingAuthorization
      })(),
      (async () => {
        const protocolChecks = await Promise.all(
          (groupPermissions.protocolPermissions || []).map(async p => {
            if (p.counterparty === '') return null
            const [level] = p.protocolID || [0]
            if (level === 2 && (p.counterparty === undefined || p.counterparty === null)) {
              return null
            }
            const hasPerm = await this.hasProtocolPermission({
              originator,
              privileged: false,
              protocolID: p.protocolID,
              counterparty: p.counterparty ?? 'self'
            })
            return hasPerm ? null : p
          })
        )
        return protocolChecks.filter(Boolean) as any
      })(),
      (async () => {
        const basketChecks = await Promise.all(
          (groupPermissions.basketAccess || []).map(async b => {
            const hasAccess = await this.hasBasketAccess({
              originator,
              basket: b.basket
            })
            return hasAccess ? null : b
          })
        )
        return basketChecks.filter(Boolean) as any
      })(),
      (async () => {
        const certChecks = await Promise.all(
          (groupPermissions.certificateAccess || []).map(async c => {
            const hasAccess = await this.hasCertificateAccess({
              originator,
              privileged: false,
              verifier: c.verifierPublicKey,
              certType: c.type,
              fields: c.fields
            })
            return hasAccess ? null : c
          })
        )
        return certChecks.filter(Boolean) as any
      })()
    ])

    if (spendingAuthorization != null) {
      permissionsToRequest.spendingAuthorization = spendingAuthorization
    }
    permissionsToRequest.protocolPermissions = protocolPermissions
    permissionsToRequest.basketAccess = basketAccess
    permissionsToRequest.certificateAccess = certificateAccess

    return permissionsToRequest
  }

  private hasAnyPermissionsToRequest (permissions: GroupedPermissions): boolean {
    return !!(
      permissions.spendingAuthorization ||
      (permissions.protocolPermissions?.length ?? 0) > 0 ||
      (permissions.basketAccess?.length ?? 0) > 0 ||
      (permissions.certificateAccess?.length ?? 0) > 0
    )
  }

  private hasGroupedPermissionRequestedHandlers (): boolean {
    const handlers = this.callbacks.onGroupedPermissionRequested || []
    return handlers.some(h => typeof h === 'function')
  }

  private hasCounterpartyPermissionRequestedHandlers (): boolean {
    const handlers = this.callbacks.onCounterpartyPermissionRequested || []
    return handlers.some(h => typeof h === 'function')
  }

  private async hasPactEstablished (originator: string, counterparty: string): Promise<boolean> {
    if (counterparty === 'self' || counterparty === 'anyone') {
      return true
    }

    const cacheKey = `${originator}:${counterparty}`
    if (this.pactEstablishedCache.has(cacheKey)) {
      return true
    }

    const { counterpartyPermissions } = await this.fetchManifestPermissions(originator)
    if (!counterpartyPermissions?.protocols?.length) {
      return true
    }

    const firstProtocol = counterpartyPermissions.protocols[0]
    const hasToken = await this.hasProtocolPermission({
      originator,
      privileged: false,
      protocolID: [2, firstProtocol.protocolName],
      counterparty
    })

    if (hasToken) {
      this.pactEstablishedCache.set(cacheKey, Date.now())
      return true
    }

    return false
  }

  private markPactEstablished (originator: string, counterparty: string): void {
    const cacheKey = `${originator}:${counterparty}`
    this.pactEstablishedCache.set(cacheKey, Date.now())
  }

  private async maybeRequestPact (currentRequest: PermissionRequest): Promise<boolean | null> {
    if (!this.config.seekGroupedPermission) {
      return null
    }
    if (!this.hasCounterpartyPermissionRequestedHandlers()) {
      return null
    }
    if (currentRequest.type !== 'protocol') {
      return null
    }
    if (currentRequest.privileged) {
      return null
    }
    const [level] = currentRequest.protocolID!
    if (level !== 2) {
      return null
    }

    const originator = currentRequest.originator
    const counterparty = currentRequest.counterparty
    if (!counterparty || counterparty === 'self' || counterparty === 'anyone') {
      return null
    }
    if (!/^[0-9a-fA-F]{66}$/.test(counterparty)) {
      return null
    }

    const { counterpartyPermissions } = await this.fetchManifestPermissions(originator)
    if (!counterpartyPermissions?.protocols?.length) {
      return null
    }

    if (!this.isProtocolInCounterpartyPermissions(currentRequest.protocolID!, counterpartyPermissions)) {
      return null
    }

    if (await this.hasPactEstablished(originator, counterparty)) {
      return null
    }

    const protocolChecks = await Promise.all(
      counterpartyPermissions.protocols.map(async p => {
        const hasPerm = await this.hasProtocolPermission({
          originator,
          privileged: false,
          protocolID: [2, p.protocolName],
          counterparty
        })
        return hasPerm ? null : p
      })
    )
    const protocolsToRequest: CounterpartyPermissions['protocols'] = protocolChecks.filter(Boolean) as any

    if (protocolsToRequest.length === 0) {
      this.markPactEstablished(originator, counterparty)
      return null
    }

    const permissionsToRequest: CounterpartyPermissions = {
      description: counterpartyPermissions.description,
      protocols: protocolsToRequest
    }

    const key = `pact:${originator}:${counterparty}`
    await this.joinOrCreatePactRequest(key, originator, counterparty, permissionsToRequest, currentRequest.displayOriginator)

    this.markPactEstablished(originator, counterparty)
    const satisfied = await this.hasProtocolPermission({
      originator,
      privileged: false,
      protocolID: currentRequest.protocolID!,
      counterparty
    })
    return satisfied ? true : null
  }

  private async joinOrCreatePactRequest (
    key: string,
    originator: string,
    counterparty: string,
    permissionsToRequest: CounterpartyPermissions,
    displayOriginator?: string
  ): Promise<void> {
    const existing = this.activeRequests.get(key)
    if (existing == null) {
      const counterpartyPromise = new Promise<boolean>((resolve, reject) => {
        this.activeRequests.set(key, {
          request: { originator, counterparty, permissions: permissionsToRequest, displayOriginator },
          pending: [{ resolve, reject }]
        })
      })
      await this.callEvent('onCounterpartyPermissionRequested', {
        requestID: key,
        originator,
        counterparty,
        permissions: permissionsToRequest
      })
      await counterpartyPromise
    } else {
      const existingRequest = existing.request as {
        originator: string
        counterparty: PubKeyHex
        permissions: CounterpartyPermissions
        displayOriginator?: string
        counterpartyLabel?: string
      }
      for (const p of permissionsToRequest.protocols) {
        if (!existingRequest.permissions.protocols.some(x => x.protocolName === p.protocolName)) {
          existingRequest.permissions.protocols.push(p)
        }
      }
      await new Promise<boolean>((resolve, reject) => {
        existing.pending.push({ resolve, reject })
      })
    }
  }

  private async maybeRequestPeerGroupedLevel2ProtocolPermissions (
    currentRequest: PermissionRequest
  ): Promise<boolean | null> {
    if (!this.config.seekGroupedPermission) {
      return null
    }
    if (!this.hasGroupedPermissionRequestedHandlers()) {
      return null
    }
    if (currentRequest.type !== 'protocol') {
      return null
    }
    const [level] = currentRequest.protocolID!
    if (level !== 2) {
      return null
    }

    const originator = currentRequest.originator
    const privileged = currentRequest.privileged ?? false
    const counterparty = currentRequest.counterparty ?? 'self'

    const groupPermissions = await this.fetchManifestGroupPermissions(originator)
    if (groupPermissions == null) {
      return null
    }

    const normalizeManifestCounterparty = (cp: string | undefined): string => {
      if (cp === '') return ''
      if (cp === undefined || cp === null) return counterparty
      return cp
    }

    const manifestLevel2ForThisPeer = (groupPermissions.protocolPermissions || [])
      .filter(p => (p.protocolID?.[0] ?? 0) === 2)
      .map(p => ({
        protocolID: p.protocolID,
        counterparty: normalizeManifestCounterparty(p.counterparty),
        description: p.description
      }))
      .filter(p => p.counterparty !== '')
      .filter(p => p.counterparty === counterparty)

    const isCurrentRequestInManifest = manifestLevel2ForThisPeer.some(p =>
      deepEqual(p.protocolID, currentRequest.protocolID!)
    )
    if (!isCurrentRequestInManifest) {
      return null
    }

    const permissionsToRequest: GroupedPermissions = {
      protocolPermissions: []
    }

    const protocolChecks = await Promise.all(
      manifestLevel2ForThisPeer.map(async p => {
        const hasPerm = await this.hasProtocolPermission({
          originator,
          privileged,
          protocolID: p.protocolID,
          counterparty: p.counterparty
        })
        return hasPerm
          ? null
          : {
              protocolID: p.protocolID,
              counterparty: p.counterparty,
              description: p.description
            }
      })
    )
    permissionsToRequest.protocolPermissions = protocolChecks.filter(Boolean) as any

    if (!this.hasAnyPermissionsToRequest(permissionsToRequest)) {
      return null
    }

    const key = `group-peer:${originator}:${privileged}:${counterparty}`
    await this.joinOrCreateGroupedRequest(key, originator, permissionsToRequest, currentRequest.displayOriginator)

    const satisfied = await this.checkSpecificPermissionAfterGroupFlow(currentRequest)
    return satisfied ? true : null
  }

  private async withGroupedPermissionFlowLock<T>(originator: string, fn: () => Promise<T>): Promise<T> {
    const priorTail = this.groupedPermissionFlowTail.get(originator) || Promise.resolve()
    const safePriorTail = priorTail.catch(() => {})

    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })

    const currentTail = safePriorTail.then(async () => await gate)
    this.groupedPermissionFlowTail.set(originator, currentTail)

    await safePriorTail
    try {
      return await fn()
    } finally {
      release?.()
      currentTail.finally(() => {
        if (this.groupedPermissionFlowTail.get(originator) === currentTail) {
          this.groupedPermissionFlowTail.delete(originator)
        }
      })
    }
  }

  private async checkSpecificPermissionAfterGroupFlow (request: PermissionRequest): Promise<boolean> {
    switch (request.type) {
      case 'protocol':
        return await this.hasProtocolPermission({
          originator: request.originator,
          privileged: request.privileged ?? false,
          protocolID: request.protocolID!,
          counterparty: request.counterparty ?? 'self'
        })
      case 'basket':
        return await this.hasBasketAccess({
          originator: request.originator,
          basket: request.basket!
        })
      case 'certificate':
        return await this.hasCertificateAccess({
          originator: request.originator,
          privileged: request.privileged ?? false,
          verifier: request.certificate!.verifier,
          certType: request.certificate!.certType,
          fields: request.certificate!.fields
        })
      case 'spending':
        return await this.hasSpendingAuthorization({
          originator: request.originator,
          satoshis: request.spending!.satoshis
        })
      default:
        return false
    }
  }

  private isRequestIncludedInGroupPermissions (
    request: PermissionRequest,
    groupPermissions: GroupedPermissions
  ): boolean {
    switch (request.type) {
      case 'protocol': {
        if (request.privileged) return false
        const pid = request.protocolID
        if (pid == null) return false
        const cp = request.counterparty ?? 'self'
        return !!groupPermissions.protocolPermissions?.some(p => {
          if (p.counterparty === '') return false
          const [level] = p.protocolID || [0]
          if (level === 2 && (p.counterparty === undefined || p.counterparty === null)) {
            return false
          }
          const manifestCp = level === 1 ? '' : (p.counterparty ?? 'self')
          return deepEqual(p.protocolID, pid) && manifestCp === cp
        })
      }
      case 'basket': {
        const basket = request.basket
        if (!basket) return false
        return !!groupPermissions.basketAccess?.some(b => b.basket === basket)
      }
      case 'certificate': {
        if (request.privileged) return false
        const cert = request.certificate
        if (cert == null) return false
        return !!groupPermissions.certificateAccess?.some(c => {
          const fieldsA = new Set(c.fields || [])
          const fieldsB = new Set(cert.fields || [])
          if (fieldsA.size !== fieldsB.size) return false
          for (const f of fieldsA) if (!fieldsB.has(f)) return false
          return c.type === cert.certType && c.verifierPublicKey === cert.verifier
        })
      }
      case 'spending':
        return groupPermissions.spendingAuthorization != null
      default:
        return false
    }
  }

  private async maybeRequestGroupedPermissions (currentRequest: PermissionRequest): Promise<boolean | null> {
    if (!this.config.seekGroupedPermission) {
      return null
    }

    const originator = currentRequest.originator

    const groupPermissions = await this.fetchManifestGroupPermissions(originator)
    if (groupPermissions == null) {
      return null
    }

    if (!this.isRequestIncludedInGroupPermissions(currentRequest, groupPermissions)) {
      return null
    }

    const permissionsToRequest = await this.filterAlreadyGrantedPermissions(originator, groupPermissions)
    if (!this.hasAnyPermissionsToRequest(permissionsToRequest)) {
      return null
    }

    const key = `group:${originator}`
    await this.joinOrCreateGroupedRequest(key, originator, permissionsToRequest, currentRequest.displayOriginator)

    const satisfied = await this.checkSpecificPermissionAfterGroupFlow(currentRequest)
    return satisfied ? true : null
  }

  /**
   * Joins an existing grouped permission request (piggybacks on the existing promise), or creates
   * a new one and fires the onGroupedPermissionRequested event.
   */
  private async joinOrCreateGroupedRequest (
    key: string,
    originator: string,
    permissionsToRequest: GroupedPermissions,
    displayOriginator?: string
  ): Promise<void> {
    const existing = this.activeRequests.get(key)
    if (existing == null) {
      const permPromise = new Promise<boolean>((resolve, reject) => {
        this.activeRequests.set(key, {
          request: { originator, permissions: permissionsToRequest, displayOriginator },
          pending: [{ resolve, reject }]
        })
      })
      await this.callEvent('onGroupedPermissionRequested', {
        requestID: key,
        originator,
        permissions: permissionsToRequest
      })
      await permPromise
    } else {
      const existingRequest = existing.request as {
        originator: string
        permissions: GroupedPermissions
        displayOriginator?: string
      }
      existingRequest.permissions.protocolPermissions ??= []
      for (const p of permissionsToRequest.protocolPermissions || []) {
        if (!existingRequest.permissions.protocolPermissions.some(x => deepEqual(x, p))) {
          existingRequest.permissions.protocolPermissions.push(p)
        }
      }
      await new Promise<boolean>((resolve, reject) => {
        existing.pending.push({ resolve, reject })
      })
    }
  }

  /**
   * A central method that triggers the permission request flow.
   * - It checks if there's already an active request for the same key
   * - If so, we wait on that existing request rather than creating a duplicative one
   * - Otherwise we create a new request queue, call the relevant "onXXXRequested" event,
   *   and return a promise that resolves once permission is granted or rejects if denied.
   */
  private async requestPermissionFlow (r: PermissionRequest): Promise<boolean> {
    const normalizedOriginator = this.normalizeOriginator(r.originator) || r.originator
    const preparedRequest: PermissionRequest = {
      ...r,
      originator: normalizedOriginator,
      displayOriginator: r.displayOriginator ?? r.previousToken?.rawOriginator ?? r.originator
    }

    if (preparedRequest.type === 'protocol' && preparedRequest.protocolID?.[0] === 1) {
      preparedRequest.counterparty = ''
    }

    const key = this.buildActiveRequestKey(preparedRequest)

    // If there's already a queue for the same resource, we piggyback on it
    if (this.isPiggybacking(key)) {
      return await this.piggybackOnExistingQueue(key)
    }

    const pactResult = await this.maybeRequestPact(preparedRequest)
    if (pactResult !== null) return pactResult

    const peerGroupResult = await this.maybeRequestPeerGroupedLevel2ProtocolPermissions(preparedRequest)
    if (peerGroupResult !== null) return peerGroupResult

    const groupResult = await this.resolveGroupedFlow(preparedRequest, key)
    if (groupResult !== null) return groupResult

    // Re-check after grouped flow — another waiter may have set up a queue
    if (this.isPiggybacking(key)) return await this.piggybackOnExistingQueue(key)

    return await this.enqueueAndFireEvent(preparedRequest, key)
  }

  /** Returns true when an active-request queue already has pending waiters for this key. */
  private isPiggybacking (key: string): boolean {
    const q = this.activeRequests.get(key)
    return (q != null) && q.pending.length > 0
  }

  /** Appends to an existing request queue and waits for resolution. */
  private async piggybackOnExistingQueue (key: string): Promise<boolean> {
    const q = this.activeRequests.get(key)!
    return await new Promise<boolean>((resolve, reject) => {
      q.pending.push({ resolve, reject })
    })
  }

  /** Runs the grouped-permission flow (with or without a lock) and checks post-group satisfaction. */
  private async resolveGroupedFlow (preparedRequest: PermissionRequest, key: string): Promise<boolean | null> {
    const hadPendingGroupedFlowBefore =
      this.config.seekGroupedPermission && this.groupedPermissionFlowTail.has(preparedRequest.originator)

    let groupResult: boolean | null
    if (this.config.seekGroupedPermission) {
      groupResult = await this.withGroupedPermissionFlowLock(preparedRequest.originator, async () => {
        return await this.maybeRequestGroupedPermissions(preparedRequest)
      })
    } else {
      groupResult = await this.maybeRequestGroupedPermissions(preparedRequest)
    }

    if (groupResult !== null) return groupResult

    if (hadPendingGroupedFlowBefore) {
      const satisfiedAfterGroup = await this.checkSpecificPermissionAfterGroupFlow(preparedRequest)
      if (satisfiedAfterGroup) return true
    }

    return null
  }

  /** Creates a new active-request queue entry, fires the event, and returns the promise. */
  private async enqueueAndFireEvent (preparedRequest: PermissionRequest, key: string): Promise<boolean> {
    const requestPromise = new Promise<boolean>((resolve, reject) => {
      this.activeRequests.set(key, { request: preparedRequest, pending: [{ resolve, reject }] })
    })

    try {
      await this.firePermissionRequestEvent(preparedRequest, key)
    } catch (e) {
      const matching = this.activeRequests.get(key)
      if (matching != null) {
        for (const p of matching.pending) p.reject(e)
        this.activeRequests.delete(key)
      }
    }

    return await requestPromise
  }

  /** Fires the appropriate onXXXRequested event based on the request type. */
  private async firePermissionRequestEvent (request: PermissionRequest, key: string): Promise<void> {
    switch (request.type) {
      case 'protocol':
        await this.callEvent('onProtocolPermissionRequested', {
          ...request,
          counterparty: request.protocolID?.[0] === 1 ? undefined : request.counterparty,
          requestID: key
        })
        break
      case 'basket':
        await this.callEvent('onBasketAccessRequested', { ...request, requestID: key })
        break
      case 'certificate':
        await this.callEvent('onCertificateAccessRequested', { ...request, requestID: key })
        break
      case 'spending':
        await this.callEvent('onSpendingAuthorizationRequested', { ...request, requestID: key })
        break
    }
  }

  /* ---------------------------------------------------------------------
   *  4) SEARCH / DECODE / DECRYPT ON-CHAIN TOKENS (PushDrop Scripts)
   * --------------------------------------------------------------------- */

  /**
   * We will use a administrative "permission token encryption" protocol to store fields
   * in each permission's PushDrop script. This ensures that only the user's wallet
   * can decrypt them. In practice, this data is not super sensitive, but we still
   * follow the principle of least exposure.
   */
  private static readonly PERM_TOKEN_ENCRYPTION_PROTOCOL: [2, 'admin permission token encryption'] = [
    2,
    'admin permission token encryption'
  ]

  /**
   * Similarly, we will use a "metadata encryption" protocol to preserve the confidentiality
   * of transaction descriptions and input/output descriptions from lower storage layers.
   */
  private static readonly METADATA_ENCRYPTION_PROTOCOL: [2, 'admin metadata encryption'] = [
    2,
    'admin metadata encryption'
  ]

  /** We always use `keyID="1"` and `counterparty="self"` for these encryption ops. */
  private async encryptPermissionTokenField (plaintext: string | number[]): Promise<number[]> {
    const data = typeof plaintext === 'string' ? Utils.toArray(plaintext, 'utf8') : plaintext
    const { ciphertext } = await this.underlying.encrypt(
      {
        plaintext: data,
        protocolID: WalletPermissionsManager.PERM_TOKEN_ENCRYPTION_PROTOCOL,
        keyID: '1'
      },
      this.adminOriginator
    )
    return ciphertext
  }

  private async decryptPermissionTokenField (ciphertext: number[]): Promise<number[]> {
    try {
      const { plaintext } = await this.underlying.decrypt(
        {
          ciphertext,
          protocolID: WalletPermissionsManager.PERM_TOKEN_ENCRYPTION_PROTOCOL,
          keyID: '1'
        },
        this.adminOriginator
      )
      return plaintext
    } catch (_decryptionError) {
      // Decryption failed (e.g. wrong key, unencrypted legacy value) — return the raw bytes unchanged
      return ciphertext
    }
  }

  /**
   * Encrypts wallet metadata if configured to do so, otherwise returns the original plaintext for storage.
   * @param plaintext The metadata to encrypt if configured to do so
   * @returns The encrypted metadata, or the original value if encryption was disabled.
   */
  private async maybeEncryptMetadata (plaintext: string): Promise<Base64String> {
    if (!this.config.encryptWalletMetadata) {
      return plaintext
    }
    const { ciphertext } = await this.underlying.encrypt(
      {
        plaintext: Utils.toArray(plaintext, 'utf8'),
        protocolID: WalletPermissionsManager.METADATA_ENCRYPTION_PROTOCOL,
        keyID: '1'
      },
      this.adminOriginator
    )
    return Utils.toBase64(ciphertext)
  }

  /**
   * Attempts to decrypt metadata. if decryption fails, assumes the value is already plaintext and returns it.
   * @param ciphertext The metadata to attempt decryption for.
   * @returns The decrypted metadata. If decryption fails, returns the original value instead.
   */
  private async maybeDecryptMetadata (ciphertext: Base64String): Promise<string> {
    try {
      const { plaintext } = await this.underlying.decrypt(
        {
          ciphertext: Utils.toArray(ciphertext, 'base64'),
          protocolID: WalletPermissionsManager.METADATA_ENCRYPTION_PROTOCOL,
          keyID: '1'
        },
        this.adminOriginator
      )
      return Utils.toUTF8(plaintext)
    } catch (_decryptionError) {
      // Decryption failed (e.g. wrong key, unencrypted legacy value) — return original string unchanged
      return ciphertext
    }
  }

  /** Helper to see if a token's expiry is in the past. */
  private isTokenExpired (expiry: number): boolean {
    const now = Math.floor(Date.now() / 1000)
    return expiry > 0 && expiry < now
  }

  /** Decrypts the standard 6 fields from a protocol (DPACP) PushDrop script. */
  private async decryptProtocolTokenFields (fields: number[][]): Promise<{
    domainDecoded: string
    expiryDecoded: number
    privDecoded: boolean
    secLevelDecoded: 0 | 1 | 2
    protoNameDecoded: string
    cptyDecoded: string
  }> {
    const domainDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(fields[0]))
    const expiryDecoded = Number.parseInt(Utils.toUTF8(await this.decryptPermissionTokenField(fields[1])), 10)
    const privDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(fields[2])) === 'true'
    const secLevelDecoded = Number.parseInt(Utils.toUTF8(await this.decryptPermissionTokenField(fields[3])), 10) as 0 | 1 | 2
    const protoNameDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(fields[4]))
    const cptyDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(fields[5]))
    return { domainDecoded, expiryDecoded, privDecoded, secLevelDecoded, protoNameDecoded, cptyDecoded }
  }

  /** Parses outpoint string "txid.vout" into [txid, outputIndex]. */
  private parseOutpoint (outpoint: string): [string, number] {
    const [txid, indexStr] = outpoint.split('.')
    return [txid, Number.parseInt(indexStr, 10)]
  }

  /** Normalizes a txid string to lowercase. */
  private normalizeTxid (txid?: string): string {
    return (txid ?? '').toLowerCase()
  }

  /** Reverses a 32-byte hex txid (for endian normalization). */
  private reverseHexTxid (txid: string): string {
    const hex = this.normalizeTxid(txid)
    if (!/^[0-9a-f]{64}$/.test(hex)) return hex
    const bytes = hex.match(/../g)
    return (bytes != null) ? bytes.reverse().join('') : hex
  }

  /**
   * Returns true when an outpoint string (e.g. "txid.vout" or "txid:vout") refers to `token`.
   */
  private tokenMatchesOutpointString (outpoint: string, token: PermissionToken): boolean {
    const dot = outpoint.lastIndexOf('.')
    const colon = outpoint.lastIndexOf(':')
    const sep = Math.max(dot, colon)
    if (sep === -1) return false
    const txidPart = outpoint.slice(0, sep)
    const vout = Number(outpoint.slice(sep + 1))
    if (!Number.isFinite(vout)) return false
    return this.normalizeTxid(txidPart) === this.normalizeTxid(token.txid) && vout === token.outputIndex
  }

  /**
   * Finds the index of the tx input that spends the given permission token.
   * Handles multiple potential field names for TXID and vout.
   */
  private findInputIndexForToken (tx: Transaction, token: PermissionToken): number {
    return (tx.inputs as any[]).findIndex((input: any) => {
      const txidCandidate: unknown =
        input?.sourceTXID ??
        input?.sourceTxid ??
        input?.sourceTxId ??
        input?.prevTxId ??
        input?.prevTxid ??
        input?.prevTXID ??
        input?.txid ??
        input?.txID

      const voutCandidate: unknown =
        input?.sourceOutputIndex ?? input?.sourceOutput ?? input?.outputIndex ?? input?.vout ?? input?.prevOutIndex

      if (typeof txidCandidate === 'string' && typeof voutCandidate === 'number') {
        const cand = this.normalizeTxid(txidCandidate)
        if (cand === this.normalizeTxid(token.txid) && voutCandidate === token.outputIndex) return true
        if (cand === this.reverseHexTxid(token.txid) && voutCandidate === token.outputIndex) return true
      }

      const outpointCandidate: unknown = input?.outpoint ?? input?.sourceOutpoint ?? input?.prevOutpoint
      return typeof outpointCandidate === 'string' && this.tokenMatchesOutpointString(outpointCandidate, token)
    })
  }

  /** Looks for a DPACP permission token matching origin/domain, privileged, protocol, cpty. */
  private async findProtocolToken (
    originator: string,
    privileged: boolean,
    protocolID: WalletProtocol,
    counterparty: string,
    includeExpired: boolean,
    originatorLookupValues?: string[]
  ): Promise<PermissionToken | undefined> {
    const [secLevel, protoName] = protocolID
    const originsToTry = originatorLookupValues?.length ? originatorLookupValues : [originator]

    for (const originTag of originsToTry) {
      const tags = [
        `originator ${originTag}`,
        `privileged ${!!privileged}`,
        `protocolName ${protoName}`,
        `protocolSecurityLevel ${secLevel}`
      ]
      if (secLevel === 2) {
        tags.push(`counterparty ${counterparty}`)
      }

      const result = await this.underlying.listOutputs(
        {
          basket: BASKET_MAP.protocol,
          tags,
          tagQueryMode: 'all',
          include: 'entire transactions'
        },
        this.adminOriginator
      )

      for (const out of result.outputs) {
        const [txid, outputIndex] = this.parseOutpoint(out.outpoint)
        const tx = Transaction.fromBEEF(result.BEEF!, txid)
        const dec = PushDrop.decode(tx.outputs[outputIndex].lockingScript)
        if (dec?.fields == null || dec.fields.length < 6) continue

        const f = await this.decryptProtocolTokenFields(dec.fields)
        if (this.normalizeOriginator(f.domainDecoded) !== originator) continue
        if (
          f.privDecoded !== !!privileged ||
          f.secLevelDecoded !== secLevel ||
          f.protoNameDecoded !== protoName ||
          (f.secLevelDecoded === 2 && f.cptyDecoded !== counterparty)
        ) {
          continue
        }
        if (!includeExpired && this.isTokenExpired(f.expiryDecoded)) continue

        return {
          tx: tx.toBEEF(),
          txid,
          outputIndex,
          outputScript: tx.outputs[outputIndex].lockingScript.toHex(),
          satoshis: out.satoshis,
          originator,
          rawOriginator: f.domainDecoded,
          privileged,
          protocol: protoName,
          securityLevel: secLevel,
          expiry: f.expiryDecoded,
          counterparty: f.cptyDecoded
        }
      }
    }
    return undefined
  }

  /** Finds ALL DPACP permission tokens matching origin/domain, privileged, protocol, cpty. Never filters by expiry. */
  private async findAllProtocolTokens (
    originator: string,
    privileged: boolean,
    protocolID: WalletProtocol,
    counterparty: string,
    originatorLookupValues?: string[]
  ): Promise<PermissionToken[]> {
    const [secLevel, protoName] = protocolID
    const originsToTry = originatorLookupValues?.length ? originatorLookupValues : [originator]
    const matches: PermissionToken[] = []
    const seen = new Set<string>()

    for (const originTag of originsToTry) {
      const tags = [
        `originator ${originTag}`,
        `privileged ${!!privileged}`,
        `protocolName ${protoName}`,
        `protocolSecurityLevel ${secLevel}`
      ]
      if (secLevel === 2) {
        tags.push(`counterparty ${counterparty}`)
      }

      const result = await this.underlying.listOutputs(
        {
          basket: BASKET_MAP.protocol,
          tags,
          tagQueryMode: 'all',
          include: 'entire transactions'
        },
        this.adminOriginator
      )

      for (const out of result.outputs) {
        if (seen.has(out.outpoint)) continue
        const [txid, vout] = this.parseOutpoint(out.outpoint)
        const tx = Transaction.fromBEEF(result.BEEF!, txid)
        const dec = PushDrop.decode(tx.outputs[vout].lockingScript)
        if (dec?.fields == null || dec.fields.length < 6) continue

        const f = await this.decryptProtocolTokenFields(dec.fields)
        if (this.normalizeOriginator(f.domainDecoded) !== originator) continue
        if (
          f.privDecoded !== !!privileged ||
          f.secLevelDecoded !== secLevel ||
          f.protoNameDecoded !== protoName ||
          (f.secLevelDecoded === 2 && f.cptyDecoded !== counterparty)
        ) {
          continue
        }

        seen.add(out.outpoint)
        matches.push({
          tx: tx.toBEEF(),
          txid,
          outputIndex: vout,
          outputScript: tx.outputs[vout].lockingScript.toHex(),
          satoshis: out.satoshis,
          originator,
          rawOriginator: f.domainDecoded,
          privileged,
          protocol: protoName,
          securityLevel: secLevel,
          expiry: f.expiryDecoded,
          counterparty: f.cptyDecoded
        })
      }
    }

    return matches
  }

  /** Looks for a DBAP token matching (originator, basket). */
  private async findBasketToken (
    originator: string,
    basket: string,
    includeExpired: boolean,
    originatorLookupValues?: string[]
  ): Promise<PermissionToken | undefined> {
    const originsToTry = originatorLookupValues?.length ? originatorLookupValues : [originator]

    for (const originTag of originsToTry) {
      const result = await this.underlying.listOutputs(
        {
          basket: BASKET_MAP.basket,
          tags: [`originator ${originTag}`, `basket ${basket}`],
          tagQueryMode: 'all',
          include: 'entire transactions'
        },
        this.adminOriginator
      )

      for (const out of result.outputs) {
        const [txid, outputIndex] = this.parseOutpoint(out.outpoint)
        const tx = Transaction.fromBEEF(result.BEEF!, txid)
        const dec = PushDrop.decode(tx.outputs[outputIndex].lockingScript)
        if (!dec?.fields || dec.fields.length < 3) continue

        const domainDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(dec.fields[0]))
        if (this.normalizeOriginator(domainDecoded) !== originator) continue

        const expiryDecoded = Number.parseInt(Utils.toUTF8(await this.decryptPermissionTokenField(dec.fields[1])), 10)
        const basketDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(dec.fields[2]))
        if (basketDecoded !== basket) continue
        if (!includeExpired && this.isTokenExpired(expiryDecoded)) continue

        return {
          tx: tx.toBEEF(),
          txid,
          outputIndex,
          outputScript: tx.outputs[outputIndex].lockingScript.toHex(),
          satoshis: out.satoshis,
          originator,
          rawOriginator: domainDecoded,
          basketName: basketDecoded,
          expiry: expiryDecoded
        }
      }
    }
    return undefined
  }

  /** Looks for a DCAP token matching (origin, privileged, verifier, certType, fields subset). */
  private async findCertificateToken (
    originator: string,
    privileged: boolean,
    verifier: string,
    certType: string,
    fields: string[],
    includeExpired: boolean,
    originatorLookupValues?: string[]
  ): Promise<PermissionToken | undefined> {
    const originsToTry = originatorLookupValues?.length ? originatorLookupValues : [originator]

    for (const originTag of originsToTry) {
      const result = await this.underlying.listOutputs(
        {
          basket: BASKET_MAP.certificate,
          tags: [`originator ${originTag}`, `privileged ${!!privileged}`, `type ${certType}`, `verifier ${verifier}`],
          tagQueryMode: 'all',
          include: 'entire transactions'
        },
        this.adminOriginator
      )

      for (const out of result.outputs) {
        const [txid, outputIndex] = this.parseOutpoint(out.outpoint)
        const tx = Transaction.fromBEEF(result.BEEF!, txid)
        const dec = PushDrop.decode(tx.outputs[outputIndex].lockingScript)
        if (!dec?.fields || dec.fields.length < 6) continue
        const [domainRaw, expiryRaw, privRaw, typeRaw, fieldsRaw, verifierRaw] = dec.fields

        const domainDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(domainRaw))
        if (this.normalizeOriginator(domainDecoded) !== originator) continue

        const expiryDecoded = Number.parseInt(Utils.toUTF8(await this.decryptPermissionTokenField(expiryRaw)), 10)
        const privDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(privRaw)) === 'true'
        const typeDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(typeRaw))
        const verifierDec = Utils.toUTF8(await this.decryptPermissionTokenField(verifierRaw))
        const allFields = JSON.parse(Utils.toUTF8(await this.decryptPermissionTokenField(fieldsRaw))) as string[]

        if (privDecoded !== !!privileged || typeDecoded !== certType || verifierDec !== verifier) continue

        // Check if 'fields' is a subset of 'allFields'
        const setAll = new Set(allFields)
        if (fields.some(f => !setAll.has(f))) continue
        if (!includeExpired && this.isTokenExpired(expiryDecoded)) continue

        return {
          tx: tx.toBEEF(),
          txid,
          outputIndex,
          outputScript: tx.outputs[outputIndex].lockingScript.toHex(),
          satoshis: out.satoshis,
          originator,
          rawOriginator: domainDecoded,
          privileged,
          verifier: verifierDec,
          certType: typeDecoded,
          certFields: allFields,
          expiry: expiryDecoded
        }
      }
    }
    return undefined
  }

  /** Looks for a DSAP token matching origin, returning the first one found. */
  private async findSpendingToken (
    originator: string,
    originatorLookupValues?: string[]
  ): Promise<PermissionToken | undefined> {
    const originsToTry = originatorLookupValues?.length ? originatorLookupValues : [originator]

    for (const originTag of originsToTry) {
      const result = await this.underlying.listOutputs(
        {
          basket: BASKET_MAP.spending,
          tags: [`originator ${originTag}`],
          tagQueryMode: 'all',
          include: 'entire transactions'
        },
        this.adminOriginator
      )

      for (const out of result.outputs) {
        const [txid, outputIndexStr] = out.outpoint.split('.')
        const tx = Transaction.fromBEEF(result.BEEF!, txid)
        const dec = PushDrop.decode(tx.outputs[Number(outputIndexStr)].lockingScript)
        if (!dec?.fields || dec.fields.length < 2) continue
        const domainRaw = dec.fields[0]
        const amtRaw = dec.fields[1]

        const domainDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(domainRaw))
        const normalizedDomain = this.normalizeOriginator(domainDecoded)
        if (normalizedDomain !== originator) continue
        const amtDecodedStr = Utils.toUTF8(await this.decryptPermissionTokenField(amtRaw))
        const authorizedAmount = Number.parseInt(amtDecodedStr, 10)

        return {
          tx: tx.toBEEF(),
          txid: out.outpoint.split('.')[0],
          outputIndex: Number.parseInt(out.outpoint.split('.')[1], 10),
          outputScript: tx.outputs[Number(outputIndexStr)].lockingScript.toHex(),
          satoshis: out.satoshis,
          originator,
          rawOriginator: domainDecoded,
          authorizedAmount,
          expiry: 0 // Not time-limited, monthly authorization
        }
      }
    }
    return undefined
  }

  /**
   * Returns the current month and year in UTC as a string in the format "YYYY-MM".
   *
   * @returns {string} The current month and year in UTC.
   */
  private getCurrentMonthYearUTC (): string {
    const now = new Date()
    const year = now.getUTCFullYear()
    const month = (now.getUTCMonth() + 1).toString().padStart(2, '0') // Ensure 2-digit month
    return `${year}-${month}`
  }

  /**
   * Returns spending for an originator in the current calendar month.
   */
  public async querySpentSince (token: PermissionToken): Promise<number> {
    const labelOrigins = this.buildOriginatorLookupValues(token.rawOriginator, token.originator)
    let total = 0

    for (const labelOrigin of labelOrigins) {
      const { actions } = await this.underlying.listActions(
        {
          labels: [`admin originator ${labelOrigin}`, `admin month ${this.getCurrentMonthYearUTC()}`],
          labelQueryMode: 'all'
        },
        this.adminOriginator
      )
      total += actions.reduce((a, e) => a - e.satoshis, 0)
    }

    return total
  }

  /* ---------------------------------------------------------------------
   *  5) CREATE / RENEW / REVOKE PERMISSION TOKENS ON CHAIN
   * --------------------------------------------------------------------- */

  /**
   * Creates a brand-new permission token as a single-output PushDrop script in the relevant admin basket.
   *
   * The main difference between each type of token is in the "fields" we store in the PushDrop script.
   *
   * @param r        The permission request
   * @param expiry   The expiry epoch time
   * @param amount   For DSAP, the authorized spending limit
   */
  private async createPermissionOnChain (r: PermissionRequest, expiry: number, amount?: number): Promise<void> {
    const normalizedOriginator = this.normalizeOriginator(r.originator) || r.originator
    r.originator = normalizedOriginator
    const basketName = BASKET_MAP[r.type]
    if (!basketName) return

    // Build the array of encrypted fields for the PushDrop script
    const fields: number[][] = await this.buildPushdropFields(r, expiry, amount)

    // Construct the script. We do a simple P2PK check. We ask `PushDrop.lock(...)`
    // to create a script with a single OP_CHECKSIG verifying ownership to redeem.
    const script = await new PushDrop(this.underlying).lock(
      fields,
      WalletPermissionsManager.PERM_TOKEN_ENCRYPTION_PROTOCOL,
      '1',
      'self',
      true,
      true
    )

    // Create tags
    const tags = this.buildTagsForRequest(r)

    // Build a transaction with exactly one output, no explicit inputs since the wallet
    // can internally fund it from its balance.
    await this.createAction(
      {
        description: `Grant ${r.type} permission`,
        outputs: [
          {
            lockingScript: script.toHex(),
            satoshis: 1,
            outputDescription: `${r.type} permission token`,
            basket: basketName,
            tags
          }
        ],
        options: {
          acceptDelayedBroadcast: true
        }
      },
      this.adminOriginator
    )
  }

  private async mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    if (items.length === 0) return []
    const results: R[] = new Array(items.length)
    let i = 0
    const worker = async () => {
      while (true) {
        const idx = i++
        if (idx >= items.length) return
        results[idx] = await fn(items[idx])
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => await worker()))
    return results
  }

  private async runBestEffortBatches<T, R>(
    items: T[],
    chunkSize: number,
    runChunk: (chunk: T[]) => Promise<R[]>
  ): Promise<R[]> {
    if (items.length === 0) return []
    const out: R[] = []
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize)
      out.push(...(await this.runBestEffortChunk(chunk, runChunk)))
    }
    return out
  }

  private async runBestEffortChunk<T, R>(chunk: T[], runChunk: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
    try {
      return await runChunk(chunk)
    } catch (e) {
      if (chunk.length <= 1) {
        console.error('Permission batch failed:', e)
        return []
      }
      const mid = Math.ceil(chunk.length / 2)
      const left = await this.runBestEffortChunk(chunk.slice(0, mid), runChunk)
      const right = await this.runBestEffortChunk(chunk.slice(mid), runChunk)
      return [...left, ...right]
    }
  }

  private async buildPermissionOutput (
    r: PermissionRequest,
    expiry: number,
    amount?: number
  ): Promise<{
      output: { lockingScript: string, satoshis: number, outputDescription: string, basket: string, tags: string[] }
      request: PermissionRequest
    }> {
    const normalizedOriginator = this.normalizeOriginator(r.originator) || r.originator
    r.originator = normalizedOriginator
    const basketName = BASKET_MAP[r.type]
    if (!basketName) {
      throw new Error(`Unsupported permission type: ${r.type}`)
    }
    const fields: number[][] = await this.buildPushdropFields(r, expiry, amount)
    const script = await new PushDrop(this.underlying).lock(
      fields,
      WalletPermissionsManager.PERM_TOKEN_ENCRYPTION_PROTOCOL,
      '1',
      'self',
      true,
      true
    )
    const tags = this.buildTagsForRequest(r)
    return {
      request: r,
      output: {
        lockingScript: script.toHex(),
        satoshis: 1,
        outputDescription: `${r.type} permission token`,
        basket: basketName,
        tags
      }
    }
  }

  private async createPermissionTokensBestEffort (
    items: Array<{ request: PermissionRequest, expiry: number, amount?: number }>
  ): Promise<PermissionRequest[]> {
    const CHUNK = 25
    return await this.runBestEffortBatches(items, CHUNK, async chunk => {
      const built = await this.mapWithConcurrency(chunk, 8, async c =>
        await this.buildPermissionOutput(c.request, c.expiry, c.amount)
      )
      await this.createAction(
        {
          description: `Grant ${built.length} permissions`,
          outputs: built.map(b => b.output),
          options: { acceptDelayedBroadcast: true }
        },
        this.adminOriginator
      )
      return built.map(b => b.request)
    })
  }

  private async renewPermissionTokensBestEffort (
    items: Array<{ oldToken: PermissionToken, request: PermissionRequest, expiry: number, amount?: number }>
  ): Promise<PermissionRequest[]> {
    const CHUNK = 15
    return await this.runBestEffortBatches(items, CHUNK, async chunk => {
      const built = await this.mapWithConcurrency(chunk, 8, async c =>
        await this.buildPermissionOutput(c.request, c.expiry, c.amount)
      )

      const inputBeef = new Beef()
      for (const c of chunk) {
        inputBeef.mergeBeef(Beef.fromBinary(c.oldToken.tx))
      }

      const { signableTransaction } = await this.createAction(
        {
          description: `Renew ${chunk.length} permissions`,
          inputBEEF: inputBeef.toBinary(),
          inputs: chunk.map((c, i) => ({
            outpoint: `${c.oldToken.txid}.${c.oldToken.outputIndex}`,
            unlockingScriptLength: 73,
            inputDescription: `Consume old permission token #${i + 1}`
          })),
          outputs: built.map(b => b.output),
          options: {
            acceptDelayedBroadcast: true,
            randomizeOutputs: false,
            signAndProcess: false
          }
        },
        this.adminOriginator
      )

      if (!signableTransaction?.reference || !signableTransaction.tx) {
        throw new Error('Failed to create signable transaction')
      }

      const partialTx = Transaction.fromAtomicBEEF(signableTransaction.tx)
      const pushdrop = new PushDrop(this.underlying)
      const spends: Record<number, { unlockingScript: string }> = {}

      for (let i = 0; i < chunk.length; i++) {
        const token = chunk[i].oldToken
        const unlocker = pushdrop.unlock(
          WalletPermissionsManager.PERM_TOKEN_ENCRYPTION_PROTOCOL,
          '1',
          'self',
          'all',
          false,
          1,
          LockingScript.fromHex(token.outputScript)
        )
        const unlockingScript = await unlocker.sign(partialTx, i)
        spends[i] = { unlockingScript: unlockingScript.toHex() }
      }

      const { txid } = await this.underlying.signAction({
        reference: signableTransaction.reference,
        spends
      })
      if (!txid) throw new Error('Failed to finalize renewal transaction')
      return built.map(b => b.request)
    })
  }

  private async coalescePermissionTokens (
    oldTokens: PermissionToken[],
    newScript: LockingScript,
    opts?: {
      tags?: string[]
      basket?: string
      description?: string
    }
  ): Promise<string> {
    if (!oldTokens?.length) throw new Error('No permission tokens to coalesce')
    if (oldTokens.length < 2) throw new Error('Need at least 2 tokens to coalesce')
    // 1) Create a signable action with N inputs and a single renewed output
    // Merge all input token BEEFs into a single BEEF structure
    const inputBeef = new Beef()
    for (const token of oldTokens) {
      inputBeef.mergeBeef(Beef.fromBinary(token.tx))
    }

    const { signableTransaction } = await this.createAction(
      {
        description: opts?.description ?? `Coalesce ${oldTokens.length} permission tokens`,
        inputBEEF: inputBeef.toBinary(),
        inputs: oldTokens.map((t, i) => ({
          outpoint: `${t.txid}.${t.outputIndex}`,
          unlockingScriptLength: 74,
          inputDescription: `Consume permission token #${i + 1}`
        })),
        outputs: [
          {
            lockingScript: newScript.toHex(),
            satoshis: 1,
            outputDescription: 'Renewed permission token',
            ...(opts?.basket ? { basket: opts.basket } : {}),
            ...((opts?.tags == null) ? {} : { tags: opts.tags })
          }
        ],
        options: {
          acceptDelayedBroadcast: true,
          randomizeOutputs: false,
          signAndProcess: false
        }
      },
      this.adminOriginator
    )

    if (!signableTransaction?.reference || !signableTransaction.tx) {
      throw new Error('Failed to create signable transaction')
    }

    // 2) Sign each input - each token needs its own unlocker with the correct locking script
    const partialTx = Transaction.fromAtomicBEEF(signableTransaction.tx)
    const pushdrop = new PushDrop(this.underlying)

    const spends: Record<number, { unlockingScript: string }> = {}
    for (let i = 0; i < oldTokens.length; i++) {
      const token = oldTokens[i]
      // Each token requires its own unlocker with the specific locking script
      const unlocker = pushdrop.unlock(
        WalletPermissionsManager.PERM_TOKEN_ENCRYPTION_PROTOCOL,
        '1',
        'self',
        'all',
        false,
        1,
        LockingScript.fromHex(token.outputScript)
      )
      const unlockingScript = await unlocker.sign(partialTx, i)
      spends[i] = { unlockingScript: unlockingScript.toHex() }
    }

    // 3) Finalize the action
    const { txid } = await this.underlying.signAction({
      reference: signableTransaction.reference,
      spends
    })
    if (!txid) throw new Error('Failed to finalize coalescing transaction')
    return txid
  }

  /**
   * Renews a permission token by spending the old token as input and creating a new token output.
   * This invalidates the old token and replaces it with a new one.
   *
   * @param oldToken The old token to consume
   * @param r        The permission request being renewed
   * @param newExpiry The new expiry epoch time
   * @param newAmount For DSAP, the new authorized amount
   */
  private async renewPermissionOnChain (
    oldToken: PermissionToken,
    r: PermissionRequest,
    newExpiry: number,
    newAmount?: number
  ): Promise<void> {
    r.originator = this.normalizeOriginator(r.originator) || r.originator
    // 1) build new fields
    const newFields = await this.buildPushdropFields(r, newExpiry, newAmount)

    // 2) new script
    const newScript = await new PushDrop(this.underlying).lock(
      newFields,
      WalletPermissionsManager.PERM_TOKEN_ENCRYPTION_PROTOCOL,
      '1',
      'self',
      true,
      true
    )
    const tags = this.buildTagsForRequest(r)
    // Check if there are multiple old tokens for the same parameters (shouldn't usually happen)
    const oldTokens = await this.findAllProtocolTokens(
      oldToken.originator,
      oldToken.privileged!,
      [oldToken.securityLevel!, oldToken.protocol!],
      oldToken.counterparty!,
      this.buildOriginatorLookupValues(oldToken.rawOriginator, oldToken.originator)
    )

    // If so, coalesce them into a single token first, to avoid bloat
    if (oldTokens.length > 1) {
      await this.coalescePermissionTokens(oldTokens, newScript, {
        tags,
        basket: BASKET_MAP[r.type],
        description: `Coalesce ${r.type} permission tokens`
      })
    } else {
      // Otherwise, just proceed with the single-token renewal
      // 3) For BRC-100, we do a "createAction" with a partial input referencing oldToken
      //    plus a single new output. We'll hydrate the template, then signAction for the wallet to finalize.
      const oldOutpoint = `${oldToken.txid}.${oldToken.outputIndex}`
      const { signableTransaction } = await this.createAction(
        {
          description: `Renew ${r.type} permission`,
          inputBEEF: oldToken.tx,
          inputs: [
            {
              outpoint: oldOutpoint,
              unlockingScriptLength: 73, // length of signature
              inputDescription: `Consume old ${r.type} token`
            }
          ],
          outputs: [
            {
              lockingScript: newScript.toHex(),
              satoshis: 1,
              outputDescription: `Renewed ${r.type} permission token`,
              basket: BASKET_MAP[r.type],
              tags
            }
          ],
          options: {
            acceptDelayedBroadcast: true
          }
        },
        this.adminOriginator
      )
      const tx = Transaction.fromBEEF(signableTransaction!.tx)
      const unlocker = new PushDrop(this.underlying).unlock(
        WalletPermissionsManager.PERM_TOKEN_ENCRYPTION_PROTOCOL,
        '1',
        'self',
        'all',
        false,
        1,
        LockingScript.fromHex(oldToken.outputScript)
      )
      const unlockingScript = await unlocker.sign(tx, 0)
      await this.underlying.signAction({
        reference: signableTransaction!.reference,
        spends: {
          0: {
            unlockingScript: unlockingScript.toHex()
          }
        }
      })
    }
  }

  /**
   * Builds the encrypted array of fields for a PushDrop permission token
   * (protocol / basket / certificate / spending).
   */
  private async buildPushdropFields (r: PermissionRequest, expiry: number, amount?: number): Promise<number[][]> {
    switch (r.type) {
      case 'protocol': {
        const [secLevel, protoName] = r.protocolID!
        const counterparty = secLevel === 2 ? (r.counterparty ?? 'self') : ''
        return [
          await this.encryptPermissionTokenField(r.originator), // domain
          await this.encryptPermissionTokenField(String(expiry)), // expiry
          await this.encryptPermissionTokenField(r.privileged === true ? 'true' : 'false'),
          await this.encryptPermissionTokenField(String(secLevel)),
          await this.encryptPermissionTokenField(protoName),
          await this.encryptPermissionTokenField(counterparty)
        ]
      }
      case 'basket': {
        return [
          await this.encryptPermissionTokenField(r.originator),
          await this.encryptPermissionTokenField(String(expiry)),
          await this.encryptPermissionTokenField(r.basket!)
        ]
      }
      case 'certificate': {
        const { certType, fields, verifier } = r.certificate!
        return [
          await this.encryptPermissionTokenField(r.originator),
          await this.encryptPermissionTokenField(String(expiry)),
          await this.encryptPermissionTokenField(r.privileged ? 'true' : 'false'),
          await this.encryptPermissionTokenField(certType),
          await this.encryptPermissionTokenField(JSON.stringify(fields)),
          await this.encryptPermissionTokenField(verifier)
        ]
      }
      case 'spending': {
        // DSAP
        const authAmt = amount ?? (r.spending?.satoshis || 0)
        return [
          await this.encryptPermissionTokenField(r.originator),
          await this.encryptPermissionTokenField(String(authAmt))
        ]
      }
    }
  }

  /**
   * Helper to build an array of tags for the new output, matching the user request's
   * origin, basket, privileged, protocol name, etc.
   */
  private buildTagsForRequest (r: PermissionRequest): string[] {
    const tags: string[] = [`originator ${r.originator}`]
    switch (r.type) {
      case 'protocol': {
        tags.push(`privileged ${!!r.privileged}`, `protocolName ${r.protocolID![1]}`, `protocolSecurityLevel ${r.protocolID![0]}`)
        if (r.protocolID![0] === 2) {
          tags.push(`counterparty ${r.counterparty ?? 'self'}`)
        }
        break
      }
      case 'basket': {
        tags.push(`basket ${r.basket}`)
        break
      }
      case 'certificate': {
        tags.push(`privileged ${!!r.privileged}`, `type ${r.certificate!.certType}`, `verifier ${r.certificate!.verifier}`)
        break
      }
      case 'spending': {
        // Only 'originator' is strictly required as a tag.
        break
      }
    }
    return tags
  }

  /* ---------------------------------------------------------------------
   *  6) PUBLIC "LIST/HAS/REVOKE" METHODS
   * --------------------------------------------------------------------- */

  /**
   * Lists all protocol permission tokens (DPACP) with optional filters.
   * @param originator Optional originator domain to filter by
   * @param privileged Optional boolean to filter by privileged status
   * @param protocolName Optional protocol name to filter by
   * @param protocolSecurityLevel Optional protocol security level to filter by
   * @param counterparty Optional counterparty to filter by
   * @returns Array of permission tokens that match the filter criteria
   */
  public async listProtocolPermissions ({
    originator,
    privileged,
    protocolName,
    protocolSecurityLevel,
    counterparty
  }: {
    originator?: string
    privileged?: boolean
    protocolName?: string
    protocolSecurityLevel?: number
    counterparty?: string
  } = {}): Promise<PermissionToken[]> {
    const baseTags = this.buildProtocolFilterTags({ privileged, protocolName, protocolSecurityLevel, counterparty })
    const originFilter = originator ? this.prepareOriginator(originator) : undefined
    const originVariants = (originFilter == null) ? [undefined] : originFilter.lookupValues
    const seen = new Set<string>()
    const tokens: PermissionToken[] = []

    for (const originTag of originVariants) {
      const tags = originTag != null ? [...baseTags, `originator ${originTag}`] : [...baseTags]
      const result = await this.underlying.listOutputs(
        { basket: BASKET_MAP.protocol, tags, tagQueryMode: 'all', include: 'entire transactions', limit: 10000 },
        this.adminOriginator
      )
      await this.collectProtocolTokens(result, originFilter, seen, tokens)
    }
    return tokens
  }

  /** Builds the base tag array for protocol permission listing. */
  private buildProtocolFilterTags ({
    privileged, protocolName, protocolSecurityLevel, counterparty
  }: { privileged?: boolean, protocolName?: string, protocolSecurityLevel?: number, counterparty?: string }): string[] {
    const tags: string[] = []
    if (privileged !== undefined) tags.push(`privileged ${!!privileged}`)
    if (protocolName) tags.push(`protocolName ${protocolName}`)
    if (protocolSecurityLevel !== undefined) tags.push(`protocolSecurityLevel ${protocolSecurityLevel}`)
    if (counterparty) tags.push(`counterparty ${counterparty}`)
    return tags
  }

  /** Decodes and appends protocol permission tokens from a listOutputs result. */
  private async collectProtocolTokens (
    result: Awaited<ReturnType<WalletInterface['listOutputs']>>,
    originFilter: ReturnType<WalletPermissionsManager['prepareOriginator']> | undefined,
    seen: Set<string>,
    tokens: PermissionToken[]
  ): Promise<void> {
    for (const out of result.outputs) {
      if (seen.has(out.outpoint)) continue
      const [txid, outputIndex] = this.parseOutpoint(out.outpoint)
      const tx = Transaction.fromBEEF(result.BEEF!, txid)
      const dec = PushDrop.decode(tx.outputs[outputIndex].lockingScript)
      if (!dec?.fields || dec.fields.length < 6) continue
      const f = await this.decryptProtocolTokenFields(dec.fields)
      const normalizedDomain = this.normalizeOriginator(f.domainDecoded)
      if ((originFilter != null) && normalizedDomain !== originFilter.normalized) continue
      seen.add(out.outpoint)
      tokens.push({
        tx: tx.toBEEF(), txid, outputIndex,
        outputScript: tx.outputs[outputIndex].lockingScript.toHex(),
        satoshis: out.satoshis, originator: normalizedDomain, rawOriginator: f.domainDecoded,
        expiry: f.expiryDecoded, privileged: f.privDecoded,
        securityLevel: f.secLevelDecoded, protocol: f.protoNameDecoded, counterparty: f.cptyDecoded
      })
    }
  }

  /**
   * Returns true if the originator already holds a valid unexpired protocol permission.
   * This calls `ensureProtocolPermission` with `seekPermission=false`, so it won't prompt.
   */
  public async hasProtocolPermission (params: {
    originator: string
    privileged: boolean
    protocolID: WalletProtocol
    counterparty: string
  }): Promise<boolean> {
    try {
      await this.ensureProtocolPermission({
        ...params,
        reason: 'hasProtocolPermission',
        seekPermission: false,
        usageType: 'generic'
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Lists basket permission tokens (DBAP) for a given originator or basket (or for all if not specified).
   * @param params.originator Optional originator to filter by
   * @param params.basket Optional basket name to filter by
   * @returns Array of permission tokens that match the filter criteria
   */
  public async listBasketAccess (params: { originator?: string, basket?: string } = {}): Promise<PermissionToken[]> {
    const basketName = BASKET_MAP.basket
    const baseTags: string[] = []

    if (params.basket) {
      baseTags.push(`basket ${params.basket}`)
    }

    const originFilter = params.originator ? this.prepareOriginator(params.originator) : undefined
    const originVariants = (originFilter == null) ? [undefined] : originFilter.lookupValues
    const seen = new Set<string>()
    const tokens: PermissionToken[] = []

    for (const originTag of originVariants) {
      const tags = [...baseTags]
      if (originTag) {
        tags.push(`originator ${originTag}`)
      }
      const result = await this.underlying.listOutputs(
        {
          basket: basketName,
          tags,
          tagQueryMode: 'all',
          include: 'entire transactions',
          limit: 10000
        },
        this.adminOriginator
      )

      for (const out of result.outputs) {
        if (seen.has(out.outpoint)) continue
        const [txid, outputIndex] = this.parseOutpoint(out.outpoint)
        const tx = Transaction.fromBEEF(result.BEEF!, txid)
        const dec = PushDrop.decode(tx.outputs[outputIndex].lockingScript)
        if (!dec?.fields || dec.fields.length < 3) continue
        const [domainRaw, expiryRaw, basketRaw] = dec.fields
        const domainDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(domainRaw))
        const normalizedDomain = this.normalizeOriginator(domainDecoded)
        if ((originFilter != null) && normalizedDomain !== originFilter.normalized) continue
        const expiryDecoded = Number.parseInt(Utils.toUTF8(await this.decryptPermissionTokenField(expiryRaw)), 10)
        const basketDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(basketRaw))
        seen.add(out.outpoint)
        tokens.push({
          tx: tx.toBEEF(),
          txid,
          outputIndex,
          satoshis: out.satoshis,
          outputScript: tx.outputs[outputIndex].lockingScript.toHex(),
          originator: normalizedDomain,
          rawOriginator: domainDecoded,
          basketName: basketDecoded,
          expiry: expiryDecoded
        })
      }
    }
    return tokens
  }

  /**
   * Returns `true` if the originator already holds a valid unexpired basket permission for `basket`.
   */
  public async hasBasketAccess (params: { originator: string, basket: string }): Promise<boolean> {
    try {
      await this.ensureBasketAccess({
        originator: params.originator,
        basket: params.basket,
        seekPermission: false,
        usageType: 'insertion'
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Lists spending authorization tokens (DSAP) for a given originator (or all).
   */
  public async listSpendingAuthorizations (params: { originator?: string }): Promise<PermissionToken[]> {
    const basketName = BASKET_MAP.spending
    const tags: string[] = []
    if (params.originator) {
      tags.push(`originator ${params.originator}`)
    }
    const result = await this.underlying.listOutputs(
      {
        basket: basketName,
        tags,
        tagQueryMode: 'all',
        include: 'entire transactions',
        limit: 10000
      },
      this.adminOriginator
    )

    const tokens: PermissionToken[] = []
    for (const out of result.outputs) {
      const [txid, outputIndexStr] = out.outpoint.split('.')
      const tx = Transaction.fromBEEF(result.BEEF!, txid)
      const dec = PushDrop.decode(tx.outputs[Number(outputIndexStr)].lockingScript)
      if (!dec?.fields || dec.fields.length < 2) continue
      const [domainRaw, amtRaw] = dec.fields
      const domainDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(domainRaw))
      const amtDecodedStr = Utils.toUTF8(await this.decryptPermissionTokenField(amtRaw))
      const authorizedAmount = Number.parseInt(amtDecodedStr, 10)
      tokens.push({
        tx: tx.toBEEF(),
        txid: out.outpoint.split('.')[0],
        outputIndex: Number.parseInt(out.outpoint.split('.')[1], 10),
        satoshis: out.satoshis,
        outputScript: tx.outputs[Number(outputIndexStr)].lockingScript.toHex(),
        originator: domainDecoded,
        authorizedAmount,
        expiry: 0
      })
    }
    return tokens
  }

  /**
   * Returns `true` if the originator already holds a valid spending authorization token
   * with enough available monthly spend. We do not prompt (seekPermission=false).
   */
  public async hasSpendingAuthorization (params: { originator: string, satoshis: number }): Promise<boolean> {
    try {
      await this.ensureSpendingAuthorization({
        originator: params.originator,
        satoshis: params.satoshis,
        seekPermission: false
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Lists certificate permission tokens (DCAP) with optional filters.
   * @param originator Optional originator domain to filter by
   * @param privileged Optional boolean to filter by privileged status
   * @param certType Optional certificate type to filter by
   * @param verifier Optional verifier to filter by
   * @returns Array of permission tokens that match the filter criteria
   */
  public async listCertificateAccess (
    params: {
      originator?: string
      privileged?: boolean
      certType?: Base64String
      verifier?: PubKeyHex
    } = {}
  ): Promise<PermissionToken[]> {
    const baseTags: string[] = []
    if (params.privileged !== undefined) baseTags.push(`privileged ${!!params.privileged}`)
    if (params.certType) baseTags.push(`type ${params.certType}`)
    if (params.verifier) baseTags.push(`verifier ${params.verifier}`)

    const originFilter = params.originator ? this.prepareOriginator(params.originator) : undefined
    const originVariants = (originFilter == null) ? [undefined] : originFilter.lookupValues
    const seen = new Set<string>()
    const tokens: PermissionToken[] = []

    for (const originTag of originVariants) {
      const tags = originTag != null ? [...baseTags, `originator ${originTag}`] : [...baseTags]
      const result = await this.underlying.listOutputs(
        { basket: BASKET_MAP.certificate, tags, tagQueryMode: 'all', include: 'entire transactions', limit: 10000 },
        this.adminOriginator
      )
      await this.collectCertificateTokens(result, originFilter, seen, tokens)
    }
    return tokens
  }

  /** Decodes and appends certificate permission tokens from a listOutputs result. */
  private async collectCertificateTokens (
    result: Awaited<ReturnType<WalletInterface['listOutputs']>>,
    originFilter: ReturnType<WalletPermissionsManager['prepareOriginator']> | undefined,
    seen: Set<string>,
    tokens: PermissionToken[]
  ): Promise<void> {
    for (const out of result.outputs) {
      if (seen.has(out.outpoint)) continue
      const [txid, outputIndex] = this.parseOutpoint(out.outpoint)
      const tx = Transaction.fromBEEF(result.BEEF!, txid)
      const dec = PushDrop.decode(tx.outputs[outputIndex].lockingScript)
      if (!dec?.fields || dec.fields.length < 6) continue
      const [domainRaw, expiryRaw, privRaw, typeRaw, fieldsRaw, verifierRaw] = dec.fields
      const domainDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(domainRaw))
      const normalizedDomain = this.normalizeOriginator(domainDecoded)
      if ((originFilter != null) && normalizedDomain !== originFilter.normalized) continue
      const expiryDecoded = Number.parseInt(Utils.toUTF8(await this.decryptPermissionTokenField(expiryRaw)), 10)
      const privDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(privRaw)) === 'true'
      const typeDecoded = Utils.toUTF8(await this.decryptPermissionTokenField(typeRaw))
      const verifierDec = Utils.toUTF8(await this.decryptPermissionTokenField(verifierRaw))
      const allFields = JSON.parse(Utils.toUTF8(await this.decryptPermissionTokenField(fieldsRaw))) as string[]
      seen.add(out.outpoint)
      tokens.push({
        tx: tx.toBEEF(), txid, outputIndex, satoshis: out.satoshis,
        outputScript: tx.outputs[outputIndex].lockingScript.toHex(),
        originator: normalizedDomain, rawOriginator: domainDecoded,
        privileged: privDecoded, certType: typeDecoded, certFields: allFields,
        verifier: verifierDec, expiry: expiryDecoded
      })
    }
  }

  /**
   * Returns `true` if the originator already holds a valid unexpired certificate access
   * for the given certType/fields. Does not prompt the user.
   */
  public async hasCertificateAccess (params: {
    originator: string
    privileged: boolean
    verifier: string
    certType: string
    fields: string[]
  }): Promise<boolean> {
    try {
      await this.ensureCertificateAccess({
        originator: params.originator,
        privileged: params.privileged,
        verifier: params.verifier,
        certType: params.certType,
        fields: params.fields,
        seekPermission: false,
        usageType: 'disclosure'
      })
      return true
    } catch {
      return false
    }
  }

  public async revokePermissions (oldTokens: PermissionToken[]): Promise<PermissionToken[]> {
    return await this.revokePermissionTokensBestEffort(oldTokens)
  }

  public async revokeAllForOriginator (
    originator: string,
    opts?: {
      protocol?: boolean
      basket?: boolean
      certificate?: boolean
      spending?: boolean
    }
  ): Promise<PermissionToken[]> {
    const preparedOriginator = this.prepareOriginator(originator)
    const include = {
      protocol: true,
      basket: true,
      certificate: true,
      spending: true,
      ...opts
    }

    const [protocolTokens, basketTokens, certificateTokens, spendingTokens] = await Promise.all([
      include.protocol ? this.listProtocolPermissions({ originator }) : Promise.resolve([]),
      include.basket ? this.listBasketAccess({ originator }) : Promise.resolve([]),
      include.certificate ? this.listCertificateAccess({ originator }) : Promise.resolve([]),
      include.spending
        ? this.listSpendingAuthorizations({ originator: preparedOriginator.normalized })
        : Promise.resolve([])
    ])

    const spendingTokenList = (spendingTokens.length > 0) ? [spendingTokens[0]] : []

    const allTokens = [...protocolTokens, ...basketTokens, ...certificateTokens, ...spendingTokenList]
    const seen = new Set<string>()
    const deduped = allTokens.filter(t => {
      const key = `${t.txid}.${t.outputIndex}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    return await this.revokePermissions(deduped)
  }

  private async revokePermissionTokensBestEffort (items: PermissionToken[]): Promise<PermissionToken[]> {
    const CHUNK = 15
    return await this.runBestEffortBatches(items, CHUNK, async chunk => {
      await this.revokePermissionTokensChunk(chunk)
      return chunk
    })
  }

  private async revokePermissionTokensChunk (oldTokens: PermissionToken[]): Promise<void> {
    if (oldTokens.length === 0) return

    const inputBeef = new Beef()
    for (const token of oldTokens) {
      inputBeef.mergeBeef(Beef.fromBinary(token.tx))
    }

    const { signableTransaction } = await this.createAction(
      {
        description: `Revoke ${oldTokens.length} permissions`,
        inputBEEF: inputBeef.toBinary(),
        inputs: oldTokens.map((t, i) => ({
          outpoint: `${t.txid}.${t.outputIndex}`,
          unlockingScriptLength: 73,
          inputDescription: `Consume old permission token #${i + 1}`
        })),
        options: {
          acceptDelayedBroadcast: true,
          randomizeOutputs: false,
          signAndProcess: false
        }
      },
      this.adminOriginator
    )

    if (!signableTransaction?.reference || !signableTransaction.tx) {
      throw new Error('Failed to create signable transaction')
    }

    const tx = Transaction.fromAtomicBEEF(signableTransaction.tx)

    const inputsToSign = oldTokens.map(token => {
      let permInputIndex = this.findInputIndexForToken(tx, token)
      if (permInputIndex === -1 && tx.inputs.length === 1) {
        permInputIndex = 0
      }
      if (permInputIndex === -1) {
        throw new Error('Unable to locate permission token input for revocation.')
      }
      return { token, permInputIndex }
    })

    const pushdrop = new PushDrop(this.underlying)
    const spends: Record<number, { unlockingScript: string }> = {}
    const signed = await this.mapWithConcurrency(inputsToSign, 8, async ({ token, permInputIndex }) => {
      const unlocker = pushdrop.unlock(
        WalletPermissionsManager.PERM_TOKEN_ENCRYPTION_PROTOCOL,
        '1',
        'self',
        'all',
        false,
        1,
        LockingScript.fromHex(token.outputScript)
      )
      const unlockingScript = await unlocker.sign(tx, permInputIndex)
      return { permInputIndex, unlockingScriptHex: unlockingScript.toHex() }
    })

    for (const s of signed) {
      spends[s.permInputIndex] = { unlockingScript: s.unlockingScriptHex }
    }

    const { txid } = await this.underlying.signAction({
      reference: signableTransaction.reference,
      spends
    })
    if (!txid) throw new Error('Failed to finalize revoke transaction')
  }

  /**
   * Revokes a permission token by spending it with no replacement output.
   * The manager builds a BRC-100 transaction that consumes the token, effectively invalidating it.
   */
  public async revokePermission (oldToken: PermissionToken): Promise<void> {
    const oldOutpoint = `${oldToken.txid}.${oldToken.outputIndex}`
    const { signableTransaction } = await this.createAction(
      {
        description: 'Revoke permission',
        inputBEEF: oldToken.tx,
        inputs: [
          {
            outpoint: oldOutpoint,
            unlockingScriptLength: 73, // length of signature
            inputDescription: 'Consume old permission token'
          }
        ],
        options: {
          acceptDelayedBroadcast: true
        }
      },
      this.adminOriginator
    )
    const tx = Transaction.fromBEEF(signableTransaction!.tx)

    let permInputIndex = this.findInputIndexForToken(tx, oldToken)

    if (permInputIndex === -1 && tx.inputs.length === 1) {
      permInputIndex = 0
    }
    if (permInputIndex === -1) {
      throw new Error('Unable to locate permission token input for revocation.')
    }
    const unlocker = new PushDrop(this.underlying).unlock(
      WalletPermissionsManager.PERM_TOKEN_ENCRYPTION_PROTOCOL,
      '1',
      'self',
      'all',
      false,
      1,
      LockingScript.fromHex(oldToken.outputScript)
    )
    const unlockingScript = await unlocker.sign(tx, permInputIndex)
    await this.underlying.signAction({
      reference: signableTransaction!.reference,
      spends: {
        [permInputIndex]: {
          unlockingScript: unlockingScript.toHex()
        }
      }
    })
  }

  /* ---------------------------------------------------------------------
   *  7) BRC-100 WALLET INTERFACE FORWARDING WITH PERMISSION CHECKS
   * --------------------------------------------------------------------- */

  public async createAction (
    args: Parameters<WalletInterface['createAction']>[0],
    originator?: string
  ): ReturnType<WalletInterface['createAction']> {
    // 1) Identify unique P-modules involved (one per schemeID) from both baskets and labels
    const pModulesByScheme = new Map<string, PermissionsModule>()
    const nonPBaskets = this.collectNonPBaskets(args.outputs, pModulesByScheme)
    const nonPLabels = this.splitLabelsByPermissionModule(args.labels, pModulesByScheme)

    // 2) Check permissions for non-P baskets
    for (const basket of nonPBaskets) {
      await this.ensureBasketAccess({ originator: originator!, basket, reason: args.description, usageType: 'insertion' })
    }
    // 3) Check permissions for non-P labels
    for (const lbl of nonPLabels) {
      await this.ensureLabelAccess({ originator: originator!, label: lbl, reason: args.description, usageType: 'apply' })
    }

    // 4) Force signAndProcess=false unless the originator is admin and explicitly sets it to true.
    const modifiedOptions = this.enforceSignAndProcess(args.options, originator)

    // 5) Encrypt transaction metadata, saving originals for spending auth and line items.
    const originalDescription = args.description
    const { originalInputDescriptions, originalOutputDescriptions } = await this.encryptActionMetadata(args)

    // 6) Call the underlying wallet's createAction with P-module chaining as needed.
    const finalArgs = {
      ...args,
      options: modifiedOptions,
      labels: [...(args.labels || []), `admin originator ${originator}`, `admin month ${this.getCurrentMonthYearUTC()}`]
    }
    let createResult = await this.callCreateActionWithPModules(finalArgs, pModulesByScheme, originator)

    if (createResult.signableTransaction == null) return createResult

    // 7) Parse the signable tx to determine net spend, then gate on spending authorization.
    const tx = Transaction.fromAtomicBEEF(createResult.signableTransaction.tx)
    const reference = createResult.signableTransaction.reference
    const { netSpent, lineItems } = this.computeNetSpend(tx, args, originalInputDescriptions, originalOutputDescriptions)

    // 8) If netSpent > 0, require spending authorization. Abort if denied.
    if (netSpent > 0) {
      try {
        await this.ensureSpendingAuthorization({ originator: originator!, satoshis: netSpent, lineItems, reason: originalDescription })
      } catch (err) {
        await this.underlying.abortAction({ reference })
        throw err
      }
    }

    // 9) Finalize or return the signable transaction based on whether more signatures are needed.
    const vargs = Validation.validateCreateActionArgs(args)
    if (vargs.isSignAction) return createResult

    const signResult = await this.underlying.signAction({ reference, spends: {}, options: args.options }, originator)
    return { ...createResult, ...signResult, signableTransaction: undefined }
  }

  /** Scans outputs to split P-scheme baskets from regular baskets; registers P-modules as a side effect. */
  private collectNonPBaskets (
    outputs: Parameters<WalletInterface['createAction']>[0]['outputs'],
    pModulesByScheme: Map<string, PermissionsModule>
  ): string[] {
    const nonPBaskets: string[] = []
    if (outputs == null) return nonPBaskets
    for (const out of outputs) {
      if (!out.basket) continue
      if (out.basket.startsWith('p ')) {
        this.addPModuleByScheme(out.basket.split(' ')[1], 'basket', pModulesByScheme)
      } else {
        nonPBaskets.push(out.basket)
      }
    }
    return nonPBaskets
  }

  /** Enforces signAndProcess=false for non-admin originators; throws if admin override is missing. */
  private enforceSignAndProcess (
    options: Parameters<WalletInterface['createAction']>[0]['options'],
    originator?: string
  ): typeof options {
    const modifiedOptions = { ...options }
    if (modifiedOptions.signAndProcess !== true) {
      modifiedOptions.signAndProcess = false
    } else if (!this.isAdminOriginator(originator!)) {
      throw new Error('Only the admin originator can set signAndProcess=true explicitly.')
    }
    return modifiedOptions
  }

  /** Encrypts all description/instruction fields in args in-place; returns original (plaintext) copies. */
  private async encryptActionMetadata (
    args: Parameters<WalletInterface['createAction']>[0]
  ): Promise<{ originalInputDescriptions: Record<number, string>, originalOutputDescriptions: Record<number, string> }> {
    const originalInputDescriptions: Record<number, string> = {}
    const originalOutputDescriptions: Record<number, string> = {}
    const inputEncryptionTasks = (args.inputs || []).map(async (input, i) => {
      if (!input.inputDescription) return
      originalInputDescriptions[i] = input.inputDescription
      input.inputDescription = await this.maybeEncryptMetadata(input.inputDescription)
    })
    const outputEncryptionTasks = (args.outputs || []).map(async (output, i) => {
      if (output.outputDescription) {
        originalOutputDescriptions[i] = output.outputDescription
        output.outputDescription = await this.maybeEncryptMetadata(output.outputDescription)
      }
      if (output.customInstructions) {
        output.customInstructions = await this.maybeEncryptMetadata(output.customInstructions)
      }
    })
    await Promise.all([
      (async () => { args.description = await this.maybeEncryptMetadata(args.description) })(),
      ...inputEncryptionTasks,
      ...outputEncryptionTasks
    ])
    return { originalInputDescriptions, originalOutputDescriptions }
  }

  /** Calls underlying createAction, chaining P-module request/response transforms when needed. */
  private async callCreateActionWithPModules (
    finalArgs: CreateActionArgs & { labels: string[] },
    pModulesByScheme: Map<string, PermissionsModule>,
    originator?: string
  ): Promise<Awaited<ReturnType<WalletInterface['createAction']>>> {
    if (pModulesByScheme.size === 0) return await this.underlying.createAction(finalArgs, originator)

    const pModules = Array.from(pModulesByScheme.values())
    let transformedArgs: object = finalArgs
    for (const module of pModules) {
      const transformed = await module.onRequest({ method: 'createAction', args: transformedArgs, originator: originator! })
      transformedArgs = transformed.args
    }
    let createResult = await this.underlying.createAction(transformedArgs as CreateActionArgs, originator)
    for (let i = pModules.length - 1; i >= 0; i--) {
      createResult = await pModules[i].onResponse(createResult, { method: 'createAction', originator: originator! })
    }
    return createResult
  }

  /**
   * Computes the net satoshis the originator is spending in a createAction call,
   * accounting for foreign (originator-provided) inputs and outputs plus the fee.
   * Also builds the line items list for the spending authorization request.
   */
  private computeNetSpend (
    tx: Transaction,
    args: Parameters<WalletInterface['createAction']>[0],
    originalInputDescriptions: Record<number, string>,
    originalOutputDescriptions: Record<number, string>
  ): { netSpent: number, lineItems: Array<{ type: LineItemType, description: string, satoshis: number }> } {
    const lineItems: Array<{ type: LineItemType, description: string, satoshis: number }> = []

    // Sum originator-provided inputs:
    let totalInputSatoshis = 0
    for (const input of tx.inputs) {
      const outpoint = `${input.sourceTXID}.${input.sourceOutputIndex}`
      const matchingIndex = (args.inputs || []).findIndex(i => i.outpoint === outpoint)
      if (matchingIndex !== -1) {
        const satoshis = input.sourceTransaction!.outputs[input.sourceOutputIndex].satoshis!
        totalInputSatoshis += satoshis
        lineItems.push({
          type: 'input',
          description: originalInputDescriptions[matchingIndex] || 'No input description provided',
          satoshis
        })
      }
    }

    // Sum originator-requested outputs:
    const totalOutputSatoshis = (args.outputs || []).reduce((acc, out) => acc + out.satoshis, 0)
    for (const outIndex in args.outputs || []) {
      const out = args.outputs![outIndex]
      lineItems.push({
        type: 'output',
        satoshis: out.satoshis,
        description: originalOutputDescriptions[outIndex] || 'No output description provided'
      })
    }

    // Add an entry for the transaction fee:
    const fee = tx.getFee()
    lineItems.push({ type: 'fee', satoshis: fee, description: 'Network fee' })

    /**
     * Net spend = total foreign outflows minus total foreign inflows plus fee.
     * Domestic wallet inputs/change outputs are not counted — they are internal.
     */
    const netSpent = totalOutputSatoshis + fee - totalInputSatoshis
    return { netSpent, lineItems }
  }

  public async signAction (
    ...args: Parameters<WalletInterface['signAction']>
  ): ReturnType<WalletInterface['signAction']> {
    return await this.underlying.signAction(...args)
  }

  public async abortAction (
    ...args: Parameters<WalletInterface['abortAction']>
  ): ReturnType<WalletInterface['abortAction']> {
    return await this.underlying.abortAction(...args)
  }

  public async listActions (
    ...args: Parameters<WalletInterface['listActions']>
  ): ReturnType<WalletInterface['listActions']> {
    const [requestArgs, originator] = args
    const { remainingLabels: labelsForPermissionChecks } = parseBrc114ActionTimeLabels(requestArgs.labels)

    // 1) Identify unique P-modules involved (one per schemeID, preserving label order)
    const pModulesByScheme = new Map<string, PermissionsModule>()
    const nonPLabels = this.splitLabelsByPermissionModule(labelsForPermissionChecks, pModulesByScheme)

    // 2) Check permissions for non-P labels
    for (const lbl of nonPLabels) {
      await this.ensureLabelAccess({
        originator: originator!,
        label: lbl,
        reason: 'listActions',
        usageType: 'list'
      })
    }

    // 3) Call underlying wallet, with P-module transformations if needed
    let results: ListActionsResult

    if (pModulesByScheme.size > 0) {
      // P-modules are involved - chain transformations
      const pModules = Array.from(pModulesByScheme.values())

      // Chain onRequest calls through all modules in order
      let transformedArgs: object = requestArgs
      for (const module of pModules) {
        const transformed = await module.onRequest({
          method: 'listActions',
          args: transformedArgs,
          originator: originator!
        })
        transformedArgs = transformed.args
      }

      // Call underlying wallet with transformed args
      results = await this.underlying.listActions(transformedArgs as ListActionsArgs, originator)

      // Chain onResponse calls in reverse order
      for (let i = pModules.length - 1; i >= 0; i--) {
        results = await pModules[i].onResponse(results, {
          method: 'listActions',
          originator: originator!
        })
      }
    } else {
      // No P-modules - call underlying wallet directly
      results = await this.underlying.listActions(...args)
    }

    // 4) Transparently decrypt transaction metadata, if configured to do so.
    return await this.decryptListActionsMetadata(results)
  }

  public async internalizeAction (
    ...args: Parameters<WalletInterface['internalizeAction']>
  ): ReturnType<WalletInterface['internalizeAction']> {
    const [requestArgs, originator] = args

    // 1) Identify unique P-modules involved (one per schemeID) from both baskets and labels
    const pModulesByScheme = new Map<string, PermissionsModule>()
    const nonPBaskets: Array<{ outIndex: string, basket: string, customInstructions?: string }> = []

    // Check baskets for p modules
    for (const outIndex in requestArgs.outputs) {
      const out = requestArgs.outputs[outIndex]
      if (out.protocol === 'basket insertion') {
        const basket = out.insertionRemittance!.basket
        if (basket.startsWith('p ')) {
          const schemeID = basket.split(' ')[1]
          this.addPModuleByScheme(schemeID, 'basket', pModulesByScheme)
        } else {
          // Track non-P baskets for normal permission checks
          nonPBaskets.push({
            outIndex,
            basket,
            customInstructions: out.insertionRemittance!.customInstructions
          })
        }
      }
    }

    // Check labels for p modules
    const nonPLabels = this.splitLabelsByPermissionModule(requestArgs.labels, pModulesByScheme)

    // 2) Check permissions for non-P baskets
    for (const { outIndex, basket, customInstructions } of nonPBaskets) {
      await this.ensureBasketAccess({
        originator: originator!,
        basket,
        reason: requestArgs.description,
        usageType: 'insertion'
      })
      if (customInstructions) {
        requestArgs.outputs[outIndex].insertionRemittance!.customInstructions =
          await this.maybeEncryptMetadata(customInstructions)
      }
    }

    // 3) Check permissions for non-P labels
    for (const lbl of nonPLabels) {
      await this.ensureLabelAccess({
        originator: originator!,
        label: lbl,
        reason: requestArgs.description,
        usageType: 'apply'
      })
    }

    // 4) Call underlying wallet, with P-module transformations if needed
    if (pModulesByScheme.size > 0) {
      // P-modules are involved - chain transformations
      const pModules = Array.from(pModulesByScheme.values())

      // Chain onRequest calls through all modules in order
      let transformedArgs: object = requestArgs
      for (const module of pModules) {
        const transformed = await module.onRequest({
          method: 'internalizeAction',
          args: transformedArgs,
          originator: originator!
        })
        transformedArgs = transformed.args
      }

      // Encrypt custom instructions for p basket outputs
      for (const outIndex in (transformedArgs as InternalizeActionArgs).outputs) {
        const out = (transformedArgs as InternalizeActionArgs).outputs[outIndex]
        if (out.protocol === 'basket insertion' && out.insertionRemittance?.customInstructions) {
          out.insertionRemittance.customInstructions = await this.maybeEncryptMetadata(
            out.insertionRemittance.customInstructions
          )
        }
      }

      // Call underlying wallet with transformed args
      let results = await this.underlying.internalizeAction(transformedArgs as InternalizeActionArgs, originator)

      // Chain onResponse calls in reverse order
      for (let i = pModules.length - 1; i >= 0; i--) {
        results = await pModules[i].onResponse(results, {
          method: 'internalizeAction',
          originator: originator!
        })
      }

      return results
    }

    // No P-modules - call underlying wallet directly
    return await this.underlying.internalizeAction(...args)
  }

  public async listOutputs (
    ...args: Parameters<WalletInterface['listOutputs']>
  ): ReturnType<WalletInterface['listOutputs']> {
    const [requestArgs, originator] = args

    // Delegate to permission module if needed
    const pModuleResult = await this.delegateToPModuleIfNeeded(
      requestArgs.basket,
      'listOutputs',
      requestArgs,
      originator!,
      async transformedArgs => {
        const result = await this.underlying.listOutputs(transformedArgs as ListOutputsArgs, originator)
        // Apply metadata decryption to permission module response
        return await this.decryptListOutputsMetadata(result)
      }
    )
    if (pModuleResult !== null) {
      return pModuleResult
    }

    // Ensure the originator has permission for the basket.
    await this.ensureBasketAccess({
      originator: originator!,
      basket: requestArgs.basket,
      reason: 'listOutputs',
      usageType: 'listing'
    })
    const results = await this.underlying.listOutputs(...args)

    // Apply metadata decryption to regular response
    return await this.decryptListOutputsMetadata(results)
  }

  public async relinquishOutput (
    ...args: Parameters<WalletInterface['relinquishOutput']>
  ): ReturnType<WalletInterface['relinquishOutput']> {
    const [requestArgs, originator] = args

    // Delegate to permission module if needed
    const pModuleResult = await this.delegateToPModuleIfNeeded(
      requestArgs.basket,
      'relinquishOutput',
      requestArgs,
      originator!,
      async transformedArgs => {
        return await this.underlying.relinquishOutput(transformedArgs as RelinquishOutputArgs, originator)
      }
    )
    if (pModuleResult !== null) {
      return pModuleResult
    }

    await this.ensureBasketAccess({
      originator: originator!,
      basket: requestArgs.basket,
      reason: 'relinquishOutput',
      usageType: 'removal'
    })
    return await this.underlying.relinquishOutput(...args)
  }

  public async getPublicKey (
    ...args: Parameters<WalletInterface['getPublicKey']>
  ): ReturnType<WalletInterface['getPublicKey']> {
    const [requestArgs, originator] = args

    if (requestArgs.protocolID != null) {
      // Delegate to permission module if needed
      const pModuleResult = await this.delegateToPModuleIfNeeded(
        requestArgs.protocolID[1],
        'getPublicKey',
        requestArgs,
        originator!,
        async transformedArgs => {
          return await this.underlying.getPublicKey(transformedArgs as GetPublicKeyArgs, originator)
        }
      )
      if (pModuleResult !== null) {
        return pModuleResult
      }

      // Not a P-protocol, continue with normal permission flow
      await this.ensureProtocolPermission({
        originator: originator!,
        privileged: requestArgs.privileged!,
        protocolID: requestArgs.protocolID,
        counterparty: requestArgs.counterparty || 'self',
        reason: requestArgs.privilegedReason,
        usageType: 'publicKey'
      })
    }

    if (requestArgs.identityKey) {
      // We also require a minimal protocol permission to retrieve the user's identity key
      await this.ensureProtocolPermission({
        originator: originator!,
        privileged: requestArgs.privileged!,
        protocolID: [1, 'identity key retrieval'],
        counterparty: 'self',
        reason: requestArgs.privilegedReason,
        usageType: 'identityKey'
      })
    }

    return await this.underlying.getPublicKey(...args)
  }

  public async revealCounterpartyKeyLinkage (
    ...args: Parameters<WalletInterface['revealCounterpartyKeyLinkage']>
  ): ReturnType<WalletInterface['revealCounterpartyKeyLinkage']> {
    const [requestArgs, originator] = args
    await this.ensureProtocolPermission({
      originator: originator!,
      privileged: requestArgs.privileged!,
      protocolID: [2, `counterparty key linkage revelation ${requestArgs.counterparty}`],
      counterparty: requestArgs.verifier,
      reason: requestArgs.privilegedReason,
      usageType: 'linkageRevelation'
    })
    return await this.underlying.revealCounterpartyKeyLinkage(...args)
  }

  public async revealSpecificKeyLinkage (
    ...args: Parameters<WalletInterface['revealSpecificKeyLinkage']>
  ): ReturnType<WalletInterface['revealSpecificKeyLinkage']> {
    const [requestArgs, originator] = args
    await this.ensureProtocolPermission({
      originator: originator!,
      privileged: requestArgs.privileged!,
      protocolID: [
        2,
        `specific key linkage revelation ${requestArgs.protocolID[1]} ${requestArgs.protocolID[0] === 2 ? requestArgs.keyID : 'all'}`
      ],
      counterparty: requestArgs.verifier,
      reason: requestArgs.privilegedReason,
      usageType: 'linkageRevelation'
    })
    return await this.underlying.revealSpecificKeyLinkage(...args)
  }

  public async encrypt (...args: Parameters<WalletInterface['encrypt']>): ReturnType<WalletInterface['encrypt']> {
    const [requestArgs, originator] = args
    // Delegate to permission module if needed
    const pModuleResult = await this.delegateToPModuleIfNeeded(
      requestArgs.protocolID[1],
      'encrypt',
      requestArgs,
      originator!,
      async transformedArgs => {
        return await this.underlying.encrypt(transformedArgs as WalletEncryptArgs, originator)
      }
    )
    if (pModuleResult !== null) {
      return pModuleResult
    }
    await this.ensureProtocolPermission({
      originator: originator!,
      protocolID: requestArgs.protocolID,
      privileged: requestArgs.privileged!,
      counterparty: requestArgs.counterparty || 'self',
      reason: requestArgs.privilegedReason,
      usageType: 'encrypting'
    })
    return await this.underlying.encrypt(...args)
  }

  public async decrypt (...args: Parameters<WalletInterface['decrypt']>): ReturnType<WalletInterface['decrypt']> {
    const [requestArgs, originator] = args
    // Delegate to permission module if needed
    const pModuleResult = await this.delegateToPModuleIfNeeded(
      requestArgs.protocolID[1],
      'decrypt',
      requestArgs,
      originator!,
      async transformedArgs => {
        return await this.underlying.decrypt(transformedArgs as WalletDecryptArgs, originator)
      }
    )
    if (pModuleResult !== null) {
      return pModuleResult
    }
    await this.ensureProtocolPermission({
      originator: originator!,
      privileged: requestArgs.privileged!,
      protocolID: requestArgs.protocolID,
      counterparty: requestArgs.counterparty || 'self',
      reason: requestArgs.privilegedReason,
      usageType: 'encrypting'
    })
    return await this.underlying.decrypt(...args)
  }

  public async createHmac (
    ...args: Parameters<WalletInterface['createHmac']>
  ): ReturnType<WalletInterface['createHmac']> {
    const [requestArgs, originator] = args
    // Delegate to permission module if needed
    const pModuleResult = await this.delegateToPModuleIfNeeded(
      requestArgs.protocolID[1],
      'createHmac',
      requestArgs,
      originator!,
      async transformedArgs => {
        return await this.underlying.createHmac(transformedArgs as CreateHmacArgs, originator)
      }
    )
    if (pModuleResult !== null) {
      return pModuleResult
    }
    await this.ensureProtocolPermission({
      originator: originator!,
      privileged: requestArgs.privileged!,
      protocolID: requestArgs.protocolID,
      counterparty: requestArgs.counterparty || 'self',
      reason: requestArgs.privilegedReason,
      usageType: 'hmac'
    })
    return await this.underlying.createHmac(...args)
  }

  public async verifyHmac (
    ...args: Parameters<WalletInterface['verifyHmac']>
  ): ReturnType<WalletInterface['verifyHmac']> {
    const [requestArgs, originator] = args
    // Delegate to permission module if needed
    const pModuleResult = await this.delegateToPModuleIfNeeded(
      requestArgs.protocolID[1],
      'verifyHmac',
      requestArgs,
      originator!,
      async transformedArgs => {
        return await this.underlying.verifyHmac(transformedArgs as VerifyHmacArgs, originator)
      }
    )
    if (pModuleResult !== null) {
      return pModuleResult
    }
    await this.ensureProtocolPermission({
      originator: originator!,
      privileged: requestArgs.privileged!,
      protocolID: requestArgs.protocolID,
      counterparty: requestArgs.counterparty || 'self',
      reason: requestArgs.privilegedReason,
      usageType: 'hmac'
    })
    return await this.underlying.verifyHmac(...args)
  }

  public async createSignature (
    ...args: Parameters<WalletInterface['createSignature']>
  ): ReturnType<WalletInterface['createSignature']> {
    const [requestArgs, originator] = args
    // Delegate to permission module if needed
    const pModuleResult = await this.delegateToPModuleIfNeeded(
      requestArgs.protocolID[1],
      'createSignature',
      requestArgs,
      originator!,
      async transformedArgs => {
        return await this.underlying.createSignature(transformedArgs as CreateSignatureArgs, originator)
      }
    )
    if (pModuleResult !== null) {
      return pModuleResult
    }
    await this.ensureProtocolPermission({
      originator: originator!,
      privileged: requestArgs.privileged!,
      protocolID: requestArgs.protocolID,
      counterparty: requestArgs.counterparty || 'self',
      reason: requestArgs.privilegedReason,
      usageType: 'signing'
    })
    return await this.underlying.createSignature(...args)
  }

  public async verifySignature (
    ...args: Parameters<WalletInterface['verifySignature']>
  ): ReturnType<WalletInterface['verifySignature']> {
    const [requestArgs, originator] = args
    // Delegate to permission module if needed
    const pModuleResult = await this.delegateToPModuleIfNeeded(
      requestArgs.protocolID[1],
      'verifySignature',
      requestArgs,
      originator!,
      async transformedArgs => {
        return await this.underlying.verifySignature(transformedArgs as VerifySignatureArgs, originator)
      }
    )
    if (pModuleResult !== null) {
      return pModuleResult
    }
    await this.ensureProtocolPermission({
      originator: originator!,
      privileged: requestArgs.privileged!,
      protocolID: requestArgs.protocolID,
      counterparty: requestArgs.counterparty || 'self',
      reason: requestArgs.privilegedReason,
      usageType: 'signing'
    })
    return await this.underlying.verifySignature(...args)
  }

  public async acquireCertificate (
    ...args: Parameters<WalletInterface['acquireCertificate']>
  ): ReturnType<WalletInterface['acquireCertificate']> {
    const [requestArgs, originator] = args
    if (this.config.seekCertificateAcquisitionPermissions) {
      await this.ensureProtocolPermission({
        originator: originator!,
        privileged: requestArgs.privileged!,
        protocolID: [1, `certificate acquisition ${requestArgs.type}`],
        counterparty: 'self',
        reason: requestArgs.privilegedReason,
        usageType: 'generic'
      })
    }
    return await this.underlying.acquireCertificate(...args)
  }

  public async listCertificates (
    ...args: Parameters<WalletInterface['listCertificates']>
  ): ReturnType<WalletInterface['listCertificates']> {
    const [requestArgs, originator] = args
    if (this.config.seekCertificateListingPermissions) {
      await this.ensureProtocolPermission({
        originator: originator!,
        privileged: requestArgs.privileged!,
        protocolID: [1, 'certificate list'],
        counterparty: 'self',
        reason: requestArgs.privilegedReason,
        usageType: 'generic'
      })
    }
    return await this.underlying.listCertificates(...args)
  }

  public async proveCertificate (
    ...args: Parameters<WalletInterface['proveCertificate']>
  ): ReturnType<WalletInterface['proveCertificate']> {
    const [requestArgs, originator] = args
    await this.ensureCertificateAccess({
      originator: originator!,
      privileged: requestArgs.privileged!,
      verifier: requestArgs.verifier,
      certType: requestArgs.certificate.type!,
      fields: requestArgs.fieldsToReveal,
      reason: 'proveCertificate',
      usageType: 'disclosure'
    })
    return await this.underlying.proveCertificate(...args)
  }

  public async relinquishCertificate (
    ...args: Parameters<WalletInterface['relinquishCertificate']>
  ): ReturnType<WalletInterface['relinquishCertificate']> {
    const [requestArgs, originator] = args
    if (this.config.seekCertificateRelinquishmentPermissions) {
      await this.ensureProtocolPermission({
        originator: originator!,
        privileged: !!(requestArgs as any).privileged,
        protocolID: [1, `certificate relinquishment ${requestArgs.type}`],
        counterparty: 'self',
        reason: (requestArgs as any).privilegedReason || 'relinquishCertificate',
        usageType: 'generic'
      })
    }
    return await this.underlying.relinquishCertificate(...args)
  }

  public async discoverByIdentityKey (
    ...args: Parameters<WalletInterface['discoverByIdentityKey']>
  ): ReturnType<WalletInterface['discoverByIdentityKey']> {
    const [_, originator] = args
    if (this.config.seekPermissionsForIdentityResolution) {
      await this.ensureProtocolPermission({
        originator: originator!,
        privileged: false,
        protocolID: [1, 'identity resolution'],
        counterparty: 'self',
        reason: 'discoverByIdentityKey',
        usageType: 'generic'
      })
    }
    return await this.underlying.discoverByIdentityKey(...args)
  }

  public async discoverByAttributes (
    ...args: Parameters<WalletInterface['discoverByAttributes']>
  ): ReturnType<WalletInterface['discoverByAttributes']> {
    const [_, originator] = args
    if (this.config.seekPermissionsForIdentityResolution) {
      await this.ensureProtocolPermission({
        originator: originator!,
        privileged: false,
        protocolID: [1, 'identity resolution'],
        counterparty: 'self',
        reason: 'discoverByAttributes',
        usageType: 'generic'
      })
    }
    return await this.underlying.discoverByAttributes(...args)
  }

  public async isAuthenticated (
    ...args: Parameters<WalletInterface['isAuthenticated']>
  ): ReturnType<WalletInterface['isAuthenticated']> {
    return await this.underlying.isAuthenticated(...args)
  }

  public async waitForAuthentication (
    ...args: Parameters<WalletInterface['waitForAuthentication']>
  ): ReturnType<WalletInterface['waitForAuthentication']> {
    const [_, originator] = args
    if (this.config.seekGroupedPermission && originator) {
      const { normalized: normalizedOriginator } = this.prepareOriginator(originator)
      const normalized = normalizedOriginator

      await this.withGroupedPermissionFlowLock(normalized, async () => {
        // 1. Fetch manifest.json from the originator
        const groupPermissions = await this.fetchManifestGroupPermissions(normalized)
        if (groupPermissions != null) {
          // 2. Filter out already-granted permissions
          const permissionsToRequest = await this.filterAlreadyGrantedPermissions(normalized, groupPermissions)

          // 3. If any permissions are left to request, start the flow
          if (this.hasAnyPermissionsToRequest(permissionsToRequest)) {
            const key = `group:${normalized}`
            if (this.activeRequests.has(key)) {
              // Another call is already waiting, piggyback on it
              await new Promise<boolean>((resolve, reject) => {
                this.activeRequests.get(key)!.pending.push({ resolve, reject })
              })
            } else {
              // This is the first call, create a new request
              const promise = new Promise<boolean>((resolve, reject) => {
                this.activeRequests.set(key, {
                  request: { originator: normalized, permissions: permissionsToRequest },
                  pending: [{ resolve, reject }]
                })
              })

              // Fire the event outside the executor to avoid async executor (S6544)
              await this.callEvent('onGroupedPermissionRequested', {
                requestID: key,
                originator: normalized,
                permissions: permissionsToRequest
              })

              await promise
            }
          }
        }
      })
    }

    // Finally, after handling grouped permissions, call the underlying method.
    return await this.underlying.waitForAuthentication(...args)
  }

  public async getHeight (...args: Parameters<WalletInterface['getHeight']>): ReturnType<WalletInterface['getHeight']> {
    return await this.underlying.getHeight(...args)
  }

  public async getHeaderForHeight (
    ...args: Parameters<WalletInterface['getHeaderForHeight']>
  ): ReturnType<WalletInterface['getHeaderForHeight']> {
    return await this.underlying.getHeaderForHeight(...args)
  }

  public async getNetwork (
    ...args: Parameters<WalletInterface['getNetwork']>
  ): ReturnType<WalletInterface['getNetwork']> {
    return await this.underlying.getNetwork(...args)
  }

  public async getVersion (
    ...args: Parameters<WalletInterface['getVersion']>
  ): ReturnType<WalletInterface['getVersion']> {
    return await this.underlying.getVersion(...args)
  }

  /* ---------------------------------------------------------------------
   *  8) INTERNAL HELPER UTILITIES
   * --------------------------------------------------------------------- */

  /** Returns true if the specified origin is the admin originator. */
  private isAdminOriginator (originator: string): boolean {
    return this.normalizeOriginator(originator) === this.adminOriginator
  }

  /**
   * Checks if the given protocol is admin-reserved per BRC-100 rules:
   *
   *  - Must not start with `admin` (admin-reserved)
   *  - Must not start with `p ` (allows for future specially permissioned protocols)
   *
   * If it violates these rules and the caller is not admin, we consider it "admin-only."
   */
  private isAdminProtocol (proto: WalletProtocol): boolean {
    const protocolName = proto[1]
    if (protocolName.startsWith('admin')) {
      return true
    }
    return false
  }

  /**
   * Checks if the given label is admin-reserved per BRC-100 rules:
   *
   *  - Must not start with `admin` (admin-reserved)
   *  - Must not start with `p ` (permissioned labels requiring a permission module)
   *
   * If it violates these rules and the caller is not admin, we consider it "admin-only."
   */
  private isAdminLabel (label: string): boolean {
    if (label.startsWith('admin')) {
      return true
    }
    if (label.startsWith('p ')) {
      return true
    }
    return false
  }

  /**
   * Checks if the given basket is admin-reserved per BRC-100 rules:
   *
   *  - Must not start with `admin`
   *  - Must not be `default` (some wallets use this for internal operations)
   *  - Must not start with `p ` (future specially permissioned baskets)
   */
  private isAdminBasket (basket: string): boolean {
    if (basket === 'default') return true
    if (basket.startsWith('admin')) return true
    return false
  }

  /**
   * Returns true if we have a cached record that the permission identified by
   * `key` is valid and unexpired.
   */
  private isPermissionCached (key: string): boolean {
    const entry = this.permissionCache.get(key)
    if (entry == null) return false
    if (Date.now() - entry.cachedAt > WalletPermissionsManager.CACHE_TTL_MS) {
      this.permissionCache.delete(key)
      return false
    }
    if (this.isTokenExpired(entry.expiry)) {
      this.permissionCache.delete(key)
      return false
    }
    return true
  }

  /** Caches the fact that the permission for `key` is valid until `expiry`. */
  private cachePermission (key: string, expiry: number): void {
    this.permissionCache.set(key, { expiry, cachedAt: Date.now() })
  }

  /** Records that a non-spending permission was just granted so we can skip re-prompting briefly. */
  private markRecentGrant (request: PermissionRequest): void {
    if (request.type === 'spending') return
    const key = this.buildRequestKey(request)
    if (!key) return
    this.recentGrants.set(key, Date.now() + WalletPermissionsManager.RECENT_GRANT_COVER_MS)
  }

  /** Returns true if we are inside the short "cover window" immediately after granting permission. */
  private isRecentlyGranted (key: string): boolean {
    const expiry = this.recentGrants.get(key)
    if (!expiry) return false
    if (Date.now() > expiry) {
      this.recentGrants.delete(key)
      return false
    }
    return true
  }

  /** Normalizes and canonicalizes originator domains (e.g., lowercase + drop default ports). */
  private normalizeOriginator (originator?: string): string {
    if (!originator) return ''
    const trimmed = originator.trim()
    if (!trimmed) {
      return ''
    }

    try {
      const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
      const candidate = hasScheme ? trimmed : `https://${trimmed}`
      const url = new URL(candidate)
      if (!url.hostname) {
        return trimmed.toLowerCase()
      }
      const hostname = url.hostname.toLowerCase()
      const needsBrackets = hostname.includes(':')
      const baseHost = needsBrackets ? `[${hostname}]` : hostname
      const port = url.port
      const defaultPort = WalletPermissionsManager.DEFAULT_PORTS[url.protocol]
      if (port && defaultPort && port === defaultPort) {
        return baseHost
      }
      return port ? `${baseHost}:${port}` : baseHost
    } catch {
      // Fall back to a conservative lowercase trim if URL parsing fails.
      return trimmed.toLowerCase()
    }
  }

  private isWhitelistedCounterpartyProtocol (counterparty: string, protocolID: WalletProtocol): boolean {
    const whitelist = this.config.whitelistedCounterparties
    if (whitelist == null) return false
    if (!counterparty || counterparty === 'self' || counterparty === 'anyone') return false

    const protocols =
      whitelist[counterparty] || whitelist[counterparty.toLowerCase()] || whitelist[counterparty.toUpperCase()]
    if (!protocols || protocols.length === 0) return false

    const protoName = (protocolID?.[1] ?? '').toString().toLowerCase()
    if (!protoName) return false
    return protocols.some(p => (p ?? '').toString().toLowerCase() === protoName)
  }

  /**
   * Produces a normalized originator value along with the set of legacy
   * representations that should be considered when searching for existing
   * permission tokens (for backwards compatibility).
   */
  private prepareOriginator (originator?: string): { normalized: string, lookupValues: string[] } {
    const trimmed = originator?.trim()
    if (!trimmed) {
      throw new Error('Originator is required for permission checks.')
    }
    const normalized = this.normalizeOriginator(trimmed) || trimmed.toLowerCase()
    const lookupValues = Array.from(new Set([trimmed, normalized])).filter(Boolean)
    return { normalized, lookupValues }
  }

  /**
   * Builds a unique list of originator variants that should be searched when
   * looking up on-chain tokens (e.g., legacy raw + normalized forms).
   */
  private buildOriginatorLookupValues (...origins: Array<string | undefined>): string[] {
    const variants = new Set<string>()
    for (const origin of origins) {
      const trimmed = origin?.trim()
      if (trimmed) {
        variants.add(trimmed)
      }
    }
    return Array.from(variants)
  }

  /**
   * Builds a "map key" string so that identical requests (e.g. "protocol:domain:true:protoName:counterparty")
   * do not produce multiple user prompts.
   */
  private buildRequestKey (r: PermissionRequest): string {
    const normalizedOriginator = this.normalizeOriginator(r.originator)
    switch (r.type) {
      case 'protocol':
        return `proto:${normalizedOriginator}:${!!r.privileged}:${r.protocolID?.join(',')}:${r.counterparty}`
      case 'basket':
        return `basket:${normalizedOriginator}:${r.basket}`
      case 'certificate':
        return `cert:${normalizedOriginator}:${!!r.privileged}:${r.certificate?.verifier}:${r.certificate?.certType}:${r.certificate?.fields.join('|')}`
      case 'spending':
        return `spend:${normalizedOriginator}:${r.spending?.satoshis}`
    }
  }

  private buildActiveRequestKey (r: PermissionRequest): string {
    const base = this.buildRequestKey(r)
    if (r.type === 'protocol' || r.type === 'basket' || r.type === 'certificate') {
      return `${base}:${r.usageType ?? ''}`
    }
    return base
  }
}
