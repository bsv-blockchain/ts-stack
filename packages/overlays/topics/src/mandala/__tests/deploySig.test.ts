import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { deployDigest, verifyDeploySig } from '../deploySig.js'

interface DeploySigVector {
  id: string
  txid: string
  digestHex: string
  issuerIdentityKey: string
  signatureHex: string
}

const vectorsPath = fileURLToPath(
  new URL('../../../../../helpers/ts-templates/test/vectors/brc162.json', import.meta.url)
)
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { deploySig: DeploySigVector[] }

const hexOf = (bytes: readonly number[]): string =>
  bytes.map(b => b.toString(16).padStart(2, '0')).join('')

const TXID = 'ab'.repeat(31) + 'cd'
const OTHER_TXID = 'ab'.repeat(32)
const issuerKey = PrivateKey.fromHex('11'.repeat(32))
const issuer = new ProtoWallet(issuerKey)
const stranger = new ProtoWallet(PrivateKey.fromHex('22'.repeat(32)))

const sign = async (wallet: ProtoWallet, txid: string): Promise<string> => {
  const { signature } = await wallet.createSignature({
    data: deployDigest(txid),
    protocolID: [2, 'mandala deploy'],
    keyID: '1',
    counterparty: 'anyone'
  })
  return hexOf(signature)
}

const identityOf = async (wallet: ProtoWallet): Promise<string> =>
  (await wallet.getPublicKey({ identityKey: true })).publicKey

describe('deployDigest', () => {
  test('is the UTF-8 bytes of "mandala-deploy:" + txid', () => {
    expect(deployDigest(TXID)).toEqual(
      Array.from(new TextEncoder().encode(`mandala-deploy:${TXID}`))
    )
  })

  test.each(vectors.deploySig.map(v => [v.id, v] as const))(
    'matches templates vector %s',
    (_id, v) => {
      expect(hexOf(deployDigest(v.txid))).toBe(v.digestHex)
    }
  )
})

describe('verifyDeploySig', () => {
  test("accepts the issuer's signature over this txid", async () => {
    const signature = await sign(issuer, TXID)
    expect(await verifyDeploySig(TXID, signature, await identityOf(issuer))).toBe(true)
  })

  test.each(vectors.deploySig.map(v => [v.id, v] as const))(
    'accepts templates vector %s',
    async (_id, v) => {
      expect(await verifyDeploySig(v.txid, v.signatureHex, v.issuerIdentityKey)).toBe(true)
    }
  )

  test('refuses a signature made for another txid (replayed deploy)', async () => {
    const signature = await sign(issuer, OTHER_TXID)
    expect(await verifyDeploySig(TXID, signature, await identityOf(issuer))).toBe(false)
  })

  test('refuses a signature checked against another issuer', async () => {
    const signature = await sign(issuer, TXID)
    expect(await verifyDeploySig(TXID, signature, await identityOf(stranger))).toBe(false)
  })

  test("refuses another wallet's signature for the issuer", async () => {
    const signature = await sign(stranger, TXID)
    expect(await verifyDeploySig(TXID, signature, await identityOf(issuer))).toBe(false)
  })

  test('refuses a signature made for the issuer itself rather than anyone', async () => {
    const { signature } = await issuer.createSignature({
      data: deployDigest(TXID),
      protocolID: [2, 'mandala deploy'],
      keyID: '1',
      counterparty: 'self'
    })
    expect(await verifyDeploySig(TXID, hexOf(signature), await identityOf(issuer))).toBe(false)
  })

  test.each([
    ['undefined', undefined],
    ['empty', ''],
    ['garbage text', 'not a signature'],
    ['hex that is not DER', '00ff00ff'],
    ['odd-length hex', '304'],
    ['a truncated DER signature', '30440220']
  ])('refuses a %s signature', async (_label, signature) => {
    expect(await verifyDeploySig(TXID, signature, await identityOf(issuer))).toBe(false)
  })

  test('refuses an uppercase-hex copy of a valid signature', async () => {
    const signature = await sign(issuer, TXID)
    expect(await verifyDeploySig(TXID, signature.toUpperCase(), await identityOf(issuer))).toBe(
      false
    )
  })

  test('refuses an owner identity that is not a public key', async () => {
    const signature = await sign(issuer, TXID)
    expect(await verifyDeploySig(TXID, signature, 'zz')).toBe(false)
  })

  test('refuses a damaged signature', async () => {
    const signature = await sign(issuer, TXID)
    const last = signature.slice(-2) === '00' ? '01' : '00'
    expect(
      await verifyDeploySig(TXID, signature.slice(0, -2) + last, await identityOf(issuer))
    ).toBe(false)
  })
})
