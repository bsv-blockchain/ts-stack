/**
 * BTMS Permission Module (Core)
 * 
 * Provides wallet permission module for BTMS token spending authorization.
 * This is the core module without UI dependencies - framework agnostic.
 * 
 * For React/MUI UI components, see @bsv/btms-permission-module-ui
 */

import type { WalletInterface } from '@bsv/sdk'
import { BTMS } from '@bsv/btms'
import { BasicTokenModule } from './BasicTokenModule.js'

export type PermissionPromptHandler = (app: string, message: string) => Promise<boolean>

export type PermissionModuleFactoryArgs = {
  wallet: WalletInterface
  promptHandler?: PermissionPromptHandler
}

const denyPrompt: PermissionPromptHandler = async () => false

export const createBtmsModule = ({ wallet, promptHandler }: PermissionModuleFactoryArgs) => {
  const btms = new BTMS({ wallet, networkPreset: 'mainnet' })
  return new BasicTokenModule(promptHandler ?? denyPrompt, btms)
}

export { BasicTokenModule }
