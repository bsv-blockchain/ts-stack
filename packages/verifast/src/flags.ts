/**
 * BDK SCRIPT_VERIFY_* flag bits.
 *
 * NOTE: These values mirror Bitcoin SV's script verification flag bitfield. The
 * exact numeric assignments MUST be confirmed against the BDK C++ headers when a
 * real bdk-core.wasm is supplied; the equivalence corpus (bench/equivalence.test.ts)
 * is the guard that this mapping matches engine behaviour. Values below follow the
 * canonical bsv ordering.
 */
export const BDK_FLAG_BITS = {
  P2SH: 1 << 0,
  STRICTENC: 1 << 1,
  DERSIG: 1 << 2,
  LOW_S: 1 << 3,
  NULLDUMMY: 1 << 4,
  SIGPUSHONLY: 1 << 5,
  MINIMALDATA: 1 << 6,
  DISCOURAGE_UPGRADABLE_NOPS: 1 << 7,
  CLEANSTACK: 1 << 8,
  CHECKLOCKTIMEVERIFY: 1 << 9,
  CHECKSEQUENCEVERIFY: 1 << 10,
  SIGHASH_FORKID: 1 << 16,
  GENESIS: 1 << 18,
  UTXO_AFTER_GENESIS: 1 << 19
} as const

export type BdkFlagName = keyof typeof BDK_FLAG_BITS

/**
 * Map @bsv/sdk string verify flags to the BDK uint32 bitfield.
 * Accepts a comma-separated string or an array; unknown flags are ignored.
 */
export function mapVerifyFlags (verifyFlags?: string | string[]): number {
  if (verifyFlags === undefined) return 0
  const names = Array.isArray(verifyFlags) ? verifyFlags : verifyFlags.split(',')
  let bits = 0
  for (const raw of names) {
    const name = raw.trim()
    if (name.length === 0) continue
    const bit = BDK_FLAG_BITS[name as BdkFlagName]
    if (bit !== undefined) bits |= bit
  }
  return bits
}
