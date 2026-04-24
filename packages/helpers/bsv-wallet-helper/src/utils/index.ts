export { makeWallet } from './mockWallet.js'
export { calculatePreimage } from './createPreimage.js'
export { addOpReturnData } from './opreturn.js'
export { getDerivation, getAddress } from './derivation.js'
export {
  // Validation functions
  isP2PKH,
  isOrdinal,
  hasOrd,
  hasOpReturnData,
  // Extraction functions
  extractOpReturnData,
  extractMapMetadata,
  extractInscriptionData,
  getScriptType,
  // Types
  type ScriptType,
  type InscriptionData,
  type MAP
} from './scriptValidation.js'
