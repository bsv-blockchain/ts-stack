import { Transaction, Script } from '@bsv/sdk'
import { WalletDerivationParams } from '../../types/wallet'

/**
 * Configuration for a transaction input
 */
export type InputConfig =
    | {
      type: 'p2pkh'
      sourceTransaction: Transaction
      sourceOutputIndex: number
      description?: string
      walletParams?: WalletDerivationParams
      signOutputs?: 'all' | 'none' | 'single'
      anyoneCanPay?: boolean
      sourceSatoshis?: number
      lockingScript?: Script
    }
    | {
      type: 'ordLock'
      sourceTransaction: Transaction
      sourceOutputIndex: number
      description?: string
      kind?: 'cancel' | 'purchase'
      walletParams?: WalletDerivationParams
      signOutputs?: 'all' | 'none' | 'single'
      anyoneCanPay?: boolean
      sourceSatoshis?: number
      lockingScript?: Script
    }
    | {
      type: 'ordinalP2PKH'
      sourceTransaction: Transaction
      sourceOutputIndex: number
      description?: string
      walletParams?: WalletDerivationParams
      signOutputs?: 'all' | 'none' | 'single'
      anyoneCanPay?: boolean
      sourceSatoshis?: number
      lockingScript?: Script
    }
    | {
      type: 'custom'
      sourceTransaction: Transaction
      sourceOutputIndex: number
      description?: string
      unlockingScriptTemplate: any // UnlockingScriptTemplate from SDK
      sourceSatoshis?: number
      lockingScript?: Script
    }
