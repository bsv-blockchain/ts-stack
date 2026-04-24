/**
 * BTMS Permission Module UI
 * 
 * React/MUI UI components for BTMS token spending authorization.
 * This package provides ready-to-use UI components that work with
 * @bsv/btms-permission-module core package.
 */

export {
  useBtmsPrompt,
  type FocusHandlers
} from './BtmsPrompt/index.js'
export { default as BtmsPromptDialog } from './BtmsPrompt/index.js'
export {
  BtmsPermissionPrompt,
  type PermissionPromptHandler,
  type PermissionPromptProps
} from './BtmsPermissionPrompt.js'
