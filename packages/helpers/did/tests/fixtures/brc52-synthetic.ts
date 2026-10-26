import { PrivateKey } from '@bsv/sdk/primitives'
import { Writer, toArray, toBase64 } from '@bsv/sdk/primitives/utils'

/**
 * Nonproduction synthetic fixtures ONLY: scalar 3 (certifier), scalar 2 (subject),
 * and scalar 1 (BRC-42 publicly verifiable "anyone" counterparty) are public test
 * values, never wallet/provider keys. No wallet, funding, or network operation occurs.
 * Tuples retain the exact supplied order/text, including Unicode and leading BOMs;
 * this intentionally bypasses Certificate.toBinary's host-locale field sorting.
 */
export function createSyntheticBRC52Binary(
  fields: readonly (readonly [string, string])[] = [],
  revocationOutpoint = `${'0'.repeat(64)}.0`
): number[] {
  const typeBytes = Array.from({ length: 32 }, () => 0x11)
  const serialBytes = Array.from({ length: 32 }, () => 0x22)
  const subject = new PrivateKey(2).toPublicKey()
  const certifier = new PrivateKey(3)
  const [txid, outputIndex] = revocationOutpoint.split('.')
  if (
    !/^[0-9a-f]{64}\.(?:0|[1-9]\d*)$/.test(revocationOutpoint) ||
    Number(outputIndex) > 0xffffffff
  ) {
    throw new Error('Invalid synthetic outpoint')
  }
  const writer = new Writer()
  writer.write(typeBytes)
  writer.write(serialBytes)
  writer.write(subject.toDER() as number[])
  writer.write(certifier.toPublicKey().toDER() as number[])
  writer.write(toArray(txid, 'hex'))
  writer.writeVarIntNum(Number(outputIndex))
  writer.writeVarIntNum(fields.length)
  for (const [name, value] of fields) {
    const nameBytes = toArray(name, 'utf8')
    const valueBytes = toArray(value, 'utf8')
    writer.writeVarIntNum(nameBytes.length)
    writer.write(nameBytes)
    writer.writeVarIntNum(valueBytes.length)
    writer.write(valueBytes)
  }
  const unsignedPrefix = writer.toArray()
  const signingKey = certifier.deriveChild(
    new PrivateKey(1).toPublicKey(),
    `2-certificate signature-${toBase64(typeBytes)} ${toBase64(serialBytes)}`
  )
  const signature = signingKey.sign(unsignedPrefix).toDER() as number[]
  return [...unsignedPrefix, ...signature]
}
