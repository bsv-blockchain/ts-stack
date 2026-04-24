import { WalletDerivationParams } from '../../types/wallet'

/**
 * Type guard to check if a value is WalletDerivationParams
 */
export function isDerivationParams (
  value: string | number[] | WalletDerivationParams
): value is WalletDerivationParams {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
