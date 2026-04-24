// Script Templates
export {
  WalletP2PKH,
  WalletOrdP2PKH,
  WalletOrdLock,
  type Inscription,
  type MAP,
  // Script template parameter types
  type P2PKHLockParams,
  type P2PKHUnlockParams,
  type OrdinalLockWithPubkeyhash,
  type OrdinalLockWithPublicKey,
  type OrdinalLockWithWallet,
  type OrdinalLockParams,
  type OrdinalUnlockParams,
  type OrdLockLockParams,
  type OrdLockCancelUnlockParams,
  type OrdLockPurchaseUnlockParams,
  type OrdLockUnlockParams
} from './script-templates/index.js'

// Transaction Builder
export {
  TransactionBuilder,
  OutputBuilder,
  InputBuilder,
  type BuildParams,
  // Transaction template parameter types - Outputs
  type AddP2PKHOutputWithPublicKey,
  type AddP2PKHOutputWithWallet,
  type AddP2PKHOutputWithAutoDerivation,
  type AddP2PKHOutputParams,
  type AddChangeOutputWithPublicKey,
  type AddChangeOutputWithWallet,
  type AddChangeOutputWithAutoDerivation,
  type AddChangeOutputParams,
  type AddOrdinalP2PKHOutputWithPublicKey,
  type AddOrdinalP2PKHOutputWithAddress,
  type AddOrdinalP2PKHOutputWithWallet,
  type AddOrdinalP2PKHOutputWithAutoDerivation,
  type AddOrdinalP2PKHOutputParams,
  type AddOrdLockOutputParams,
  type AddCustomOutputParams,
  // Transaction template parameter types - Inputs
  type AddP2PKHInputParams,
  type AddOrdinalP2PKHInputParams,
  type AddOrdLockInputParams,
  type AddCustomInputParams
} from './transaction-builder/index.js'

// Types
export { type WalletDerivationParams } from './types/index.js'

// Utilities
export {
  makeWallet,
  calculatePreimage,
  addOpReturnData,
  getDerivation,
  getAddress,
  // Script validation
  isP2PKH,
  isOrdinal,
  hasOrd,
  hasOpReturnData,
  // Script analysis
  getScriptType,
  extractOpReturnData,
  extractMapMetadata,
  extractInscriptionData,
  // Types
  type ScriptType,
  type InscriptionData
} from './utils/index.js'
