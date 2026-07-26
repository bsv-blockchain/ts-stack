/**
 * BDK SCRIPT_VERIFY_* flag bits.
 *
 * These assignments mirror `bitcoin-sv/src/script/script_flags.h` at the source
 * commit used to build the bundled BDK module.
 */
export const BDK_FLAG_BITS = {
  P2SH: 1,
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
  MINIMALIF: 1 << 13,
  NULLFAIL: 1 << 14,
  COMPRESSED_PUBKEYTYPE: 1 << 15,
  SIGHASH_FORKID: 1 << 16,
  GENESIS: 1 << 18,
  UTXO_AFTER_GENESIS: 1 << 19,
  CHRONICLE: 1 << 20,
  UTXO_AFTER_CHRONICLE: 1 << 21
} as const

export type BdkFlagName = keyof typeof BDK_FLAG_BITS

/**
 * Map @bsv/sdk string verify flags to the BDK uint32 bitfield.
 * Accepts a comma-separated string or an array. Unknown names throw so a typo
 * cannot silently weaken validation.
 */
export function mapVerifyFlags(verifyFlags?: string | string[]): number {
  if (verifyFlags === undefined) return 0
  const names = Array.isArray(verifyFlags) ? verifyFlags : verifyFlags.split(',')
  let bits = 0
  for (const raw of names) {
    const name = raw.trim()
    if (name.length === 0) continue
    const bit = BDK_FLAG_BITS[name as BdkFlagName]
    if (bit === undefined) throw new Error(`Unknown BDK verification flag: ${name}`)
    bits |= bit
  }
  return bits
}
