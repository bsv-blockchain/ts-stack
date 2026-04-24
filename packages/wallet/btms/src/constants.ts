/**
 * BTMS Protocol Constants
 * 
 * Constants used throughout the BTMS core library.
 * These align with the BTMSTopicManager protocol.
 */

import type { WalletProtocol, SatoshiValue, BasketStringUnder300Bytes } from '@bsv/sdk'

// ---------------------------------------------------------------------------
// Protocol Constants
// ---------------------------------------------------------------------------

/** BTMS Topic Manager identifier */
export const BTMS_TOPIC = 'tm_btms'

/** BTMS Lookup Service identifier */
export const BTMS_LOOKUP_SERVICE = 'ls_btms'

/** Literal used in field[0] to indicate token issuance */
export const ISSUE_MARKER = 'ISSUE'

/** Default satoshi value for BTMS token outputs */
export const DEFAULT_TOKEN_SATOSHIS = 1 as SatoshiValue

/** Message box for BTMS token payments */
export const BTMS_MESSAGE_BOX = 'btms_tokens'

// ---------------------------------------------------------------------------
// Wallet Protocol Constants
// ---------------------------------------------------------------------------

/**
 * BTMS Protocol ID for wallet operations
 * 
 * Format: [securityLevel, protocolName]
 * - Security level 0: No special security requirements
 * - Protocol name "p btms": Matches the basket prefix for consistency
 */
export const BTMS_PROTOCOL_ID: WalletProtocol = [0, 'p btms']

// ---------------------------------------------------------------------------
// Basket Constants
// ---------------------------------------------------------------------------

/**
 * Basket name for all BTMS tokens
 * 
 * All BTMS token outputs are stored in a single basket: "p btms"
 * Individual assets are differentiated by:
 * - Tags: btms_issue, btms_change, btms_received, btms_send
 * - Token script content (assetId encoded in the token)
 * 
 * This architecture allows efficient querying:
 * - Single listOutputs call to get all BTMS tokens
 * - Filter by tags to get owned tokens (issue/change/received)
 * - Decode scripts to discover unique assets
 */
export const BTMS_BASKET = 'p btms' as BasketStringUnder300Bytes

// ---------------------------------------------------------------------------
// Label Constants
// ---------------------------------------------------------------------------

/** Prefix for BTMS P-labels (BRC-111 format: `p <moduleId> <payload>`) */
export const BTMS_LABEL_PREFIX = 'p btms '


// ---------------------------------------------------------------------------
// Output Tag Constants
// ---------------------------------------------------------------------------
// Tags follow the format: btms_<category>_<value>
// Examples: btms_type_issue, btms_direction_incoming, btms_assetid_<assetId>

// ---------------------------------------------------------------------------
// Validation Constants
// ---------------------------------------------------------------------------

/** Maximum allowed token amount */
export const MAX_TOKEN_AMOUNT = Number.MAX_SAFE_INTEGER

/** Minimum allowed token amount */
export const MIN_TOKEN_AMOUNT = 1
