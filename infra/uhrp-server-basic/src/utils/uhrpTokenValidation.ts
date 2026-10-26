import {
  LockingScript,
  ProtoWallet,
  PublicKey,
  PushDrop,
  Signature,
  Utils,
  type WalletProtocol
} from '@bsv/sdk'

const PROTOCOL: WalletProtocol = [2, 'uhrp advertisement']
const MAX_URL_BYTES = 2048

export interface VerifiedUHRPAdvertisement {
  hostIdentityKey: string
  hash: number[]
  hostedFileLocation: string
  expiryTime: number
  fileSize: number
  lockingPublicKey: PublicKey
  signature: number[]
}

function chunk(data: number[]): { op: number; data?: number[] } {
  if (data.length === 0 || (data.length === 1 && data[0] === 0)) return { op: 0 }
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16) return { op: 0x50 + data[0] }
  if (data.length === 1 && data[0] === 0x81) return { op: 0x4f }
  if (data.length <= 75) return { op: data.length, data }
  if (data.length <= 0xff) return { op: 0x4c, data }
  if (data.length <= 0xffff) return { op: 0x4d, data }
  return { op: 0x4e, data }
}

function canonicalScript(lockingPublicKey: PublicKey, fields: number[][]): LockingScript {
  const chunks: Array<{ op: number; data?: number[] }> = [
    { op: 33, data: Utils.toArray(lockingPublicKey.toString(), 'hex') },
    { op: 0xac },
    ...fields.map(chunk)
  ]
  for (let remaining = fields.length; remaining > 1; remaining -= 2) {
    chunks.push({ op: 0x6d })
  }
  if (fields.length % 2 === 1) chunks.push({ op: 0x75 })
  return new LockingScript(chunks)
}

function readPositiveCompactSize(field: number[], name: string): number {
  if (field.length < 1 || field.length > 9) {
    throw new Error(`UHRP advertisement ${name} is invalid`)
  }
  const first = field[0]
  let value: bigint
  let expectedLength: number
  if (first < 0xfd) {
    value = BigInt(first)
    expectedLength = 1
  } else if (first === 0xfd) {
    expectedLength = 3
    value = BigInt(field[1] ?? 0) | (BigInt(field[2] ?? 0) << 8n)
    if (value < 0xfdn) throw new Error(`UHRP advertisement ${name} is non-canonical`)
  } else if (first === 0xfe) {
    expectedLength = 5
    value = 0n
    for (let index = 0; index < 4; index++) value |= BigInt(field[index + 1] ?? 0) << BigInt(index * 8)
    if (value <= 0xffffn) throw new Error(`UHRP advertisement ${name} is non-canonical`)
  } else {
    expectedLength = 9
    value = 0n
    for (let index = 0; index < 8; index++) value |= BigInt(field[index + 1] ?? 0) << BigInt(index * 8)
    if (value <= 0xffffffffn) throw new Error(`UHRP advertisement ${name} is non-canonical`)
  }
  if (field.length !== expectedLength || value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`UHRP advertisement ${name} is invalid`)
  }
  const numberValue = Number(value)
  if (!Number.isSafeInteger(numberValue)) throw new Error(`UHRP advertisement ${name} is invalid`)
  return numberValue
}

function equalBytes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Local compatibility copy of the SDK's strict UHRP token verifier. */
export async function decodeAndVerifyUHRPAdvertisement(
  lockingScript: LockingScript
): Promise<VerifiedUHRPAdvertisement> {
  const { fields, lockingPublicKey } = PushDrop.decode(lockingScript)
  if (fields.length !== 6) throw new Error('Unexpected UHRP advertisement field count')
  if (fields.some(field => field.length > MAX_URL_BYTES)) {
    throw new Error('UHRP advertisement contains an oversized field')
  }
  if (fields.reduce((total, field) => total + field.length, 0) > MAX_URL_BYTES + 256) {
    throw new Error('UHRP advertisement payload is oversized')
  }
  if (canonicalScript(lockingPublicKey, fields).toHex() !== lockingScript.toHex()) {
    throw new Error('UHRP advertisement envelope is not canonical')
  }
  if (fields[0].length !== 33 || (fields[0][0] !== 2 && fields[0][0] !== 3)) {
    throw new Error('UHRP advertisement host identity key is invalid')
  }
  const hostIdentityKey = Utils.toHex(fields[0])
  const hostKey = PublicKey.fromString(hostIdentityKey)
  if (!equalBytes(hostKey.toDER() as number[], fields[0])) {
    throw new Error('UHRP advertisement host identity key is not canonical')
  }
  if (fields[1].length !== 32) throw new Error('UHRP advertisement hash is invalid')
  const hostedFileLocation = new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(fields[2])
  )
  if (fields[2].length < 1 || /\p{Cc}/u.test(hostedFileLocation)) {
    throw new Error('UHRP advertisement URL is invalid')
  }
  const location = new URL(hostedFileLocation)
  if (
    location.protocol !== 'https:' ||
    location.hostname === '' ||
    location.username !== '' ||
    location.password !== '' ||
    location.hash !== ''
  ) {
    throw new Error('UHRP advertisement must use a credential-free HTTPS URL')
  }
  const expiryTime = readPositiveCompactSize(fields[3], 'expiry time')
  const fileSize = readPositiveCompactSize(fields[4], 'file size')
  if (fields[5].length < 8 || fields[5].length > 80) {
    throw new Error('UHRP advertisement signature is invalid')
  }
  if (!equalBytes(Signature.fromDER(fields[5]).toDER() as number[], fields[5])) {
    throw new Error('UHRP advertisement signature is not canonical')
  }
  const anyone = new ProtoWallet('anyone')
  const { publicKey } = await anyone.getPublicKey({
    protocolID: PROTOCOL,
    keyID: '1',
    counterparty: hostIdentityKey
  })
  if (publicKey.toLowerCase() !== lockingPublicKey.toString().toLowerCase()) {
    throw new Error('UHRP advertisement locking key is not linked to its host')
  }
  const { valid } = await anyone.verifySignature({
    data: fields.slice(0, 5).flat(),
    signature: fields[5],
    protocolID: PROTOCOL,
    keyID: '1',
    counterparty: hostIdentityKey
  })
  if (valid !== true) throw new Error('UHRP advertisement signature is invalid')
  return {
    hostIdentityKey,
    hash: [...fields[1]],
    hostedFileLocation,
    expiryTime,
    fileSize,
    lockingPublicKey,
    signature: [...fields[5]]
  }
}
