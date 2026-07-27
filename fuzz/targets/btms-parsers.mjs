import { BTMSToken, parseCustomInstructions } from '../../packages/wallet/btms/dist/index.mjs'
import { attempt, invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const raw = utf8(data, 65_536)
  const decoded = BTMSToken.decode(raw)
  invariant(typeof decoded.valid === 'boolean', 'BTMS token decoder returned an invalid result')

  const parsed = attempt(() => parseCustomInstructions(raw, 'fuzz-txid', data[0] ?? 0))
  if (parsed.ok) {
    invariant(parsed.value.keyID.includes(' '), 'BTMS derivation key lost its delimiter')
    invariant(
      parsed.value.senderIdentityKey === undefined ||
        typeof parsed.value.senderIdentityKey === 'string',
      'BTMS derivation parser returned an invalid sender'
    )
  }

  const split = Math.floor(data.length / 2)
  const derivationPrefix = data.subarray(0, split).toString('base64') || 'AA=='
  const derivationSuffix = data.subarray(split).toString('base64') || 'AQ=='
  const instructions = parseCustomInstructions(
    JSON.stringify({ derivationPrefix, derivationSuffix }),
    'generated',
    0
  )
  invariant(
    instructions.keyID === `${derivationPrefix} ${derivationSuffix}`,
    'BTMS derivation instructions did not round trip'
  )

  const txid = Buffer.from(data.subarray(0, 32)).toString('hex').padEnd(64, '0')
  const outputBytes = Buffer.alloc(4)
  data.copy(outputBytes, 0, 32, 36)
  const outputIndex = outputBytes.readUInt32LE(0)
  invariant(
    BTMSToken.isValidAssetId(BTMSToken.computeAssetId(txid, outputIndex)),
    'BTMS generated asset ID was rejected'
  )
}
