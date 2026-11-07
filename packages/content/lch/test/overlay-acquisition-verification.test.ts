import { expect, it } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { WalletBRC77Signer } from '../src/signatures.js'
import { lchOverlaySignatureBudget } from '../src/overlayAcquisitionVerification.js'

it('caches only the same authenticated preimage and signature and rechecks access even for a cache hit', async () => {
  const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(83)) }),
    message = Uint8Array.of(1, 2, 3),
    signature = await signer.sign(message)
  let checks = 0,
    current = true
  const verifier = lchOverlaySignatureBudget(() => {
    checks++
    if (!current) throw new Error('Assessment withdrawn')
  })
  expect(await verifier.verify(message, signature)).toBe(true)
  expect(checks).toBe(2)
  expect(await verifier.verify(message.slice(), signature.slice())).toBe(true)
  expect(checks).toBe(3)
  expect(await verifier.verify(Uint8Array.of(4, 2, 3), signature)).toBe(false)
  current = false
  await expect(verifier.verify(message, signature)).rejects.toThrow('withdrawn')
})

it('bounds actual checks including invalid signatures and distinguishes ambiguous concatenation splits', async () => {
  const verifier = lchOverlaySignatureBudget(() => {})
  expect(await verifier.verify(Uint8Array.of(1), Uint8Array.of(2, 3))).toBe(false)
  await Array.from({ length: 255 }, (_, index) => index).reduce(
    (previous, index) =>
      previous.then(() => verifier.verify(Uint8Array.of(4, index), Uint8Array.of(0))),
    Promise.resolve(false)
  )
  expect(await verifier.verify(Uint8Array.of(1), Uint8Array.of(2, 3))).toBe(false)
  await expect(verifier.verify(Uint8Array.of(1, 2), Uint8Array.of(3))).rejects.toThrow('budget')
})

it('refuses a result when the assessment is withdrawn during actual verification', async () => {
  let checks = 0
  const verifier = lchOverlaySignatureBudget(() => {
    if (++checks === 2) throw new Error('Assessment withdrawn')
  })
  await expect(verifier.verify(Uint8Array.of(1), Uint8Array.of(0))).rejects.toThrow('withdrawn')
})
