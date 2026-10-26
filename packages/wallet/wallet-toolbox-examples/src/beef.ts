import { runArgv2Function } from './runArgv2Function'

/**
 * The former `beef` script embedded a historical mainnet transaction and live
 * wallet identities. Replaying fixed financial material is unsafe and cannot be
 * made into a reusable example. Use `internalizeWalletPayment` instead; it mints
 * a fresh testnet payment, binds the exact output, and internalizes that payment.
 */
export function beef(): never {
  throw new Error('The hard-coded mainnet BEEF example is retired; use internalizeWalletPayment')
}

if (require.main === module) void runArgv2Function(module.exports)
