import {
  MerklePath,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PushDrop,
  Script,
  Transaction,
  Utils,
  VerifiableCertificate
} from '@bsv/sdk'
import { LookupAnswer, LookupResolver } from '@bsv/sdk'
import { parseResults, parseResults$, queryOverlay } from '../identityUtils'
import { verifyOverlayOutput } from '../verifyOverlayOutput'
import {
  createIdentityVerificationFixture,
  confirmIdentityFixtureTransaction,
  IDENTITY_VERIFICATION_CONFIRMED_HEIGHT,
  IDENTITY_VERIFICATION_KEY_ID,
  IDENTITY_VERIFICATION_PROTOCOL,
  IdentityVerificationChainTracker,
  IdentityVerificationFixture
} from './identityVerification.fixtures'

function answer(...outputs: LookupAnswer['outputs']): LookupAnswer {
  return { type: 'output-list', outputs }
}

function outputFor(beef: number[], outputIndex = 0, txid?: string): LookupAnswer['outputs'][number] {
  return txid === undefined ? { beef, outputIndex } : { beef, outputIndex, txid }
}

async function collect(iterable: AsyncIterable<VerifiableCertificate>): Promise<VerifiableCertificate[]> {
  const values: VerifiableCertificate[] = []
  for await (const value of iterable) values.push(value)
  return values
}

describe('identity overlay verification', () => {
  let fixture: IdentityVerificationFixture

  beforeEach(async () => {
    fixture = await createIdentityVerificationFixture()
  })

  it('accepts a signed, decryptable certificate from a locally confirmed transaction', async () => {
    await expect(fixture.certificateTransaction.verify(fixture.confirmedTracker)).resolves.toBe(true)

    const results = await parseResults(
      answer(outputFor(fixture.certificateBEEF, 0, fixture.certificateTransaction.id('hex'))),
      fixture.confirmedTracker
    )

    expect(results).toHaveLength(1)
    expect(results[0].decryptedFields).toEqual({ name: 'Alice' })
    expect(fixture.confirmedTracker.checkedRoots).toContainEqual({
      root: fixture.certificateTransaction.merklePath?.computeRoot(fixture.certificateTransaction.id('hex')),
      height: IDENTITY_VERIFICATION_CONFIRMED_HEIGHT
    })
  })

  it('accepts a genuinely signed unconfirmed spend only when its ancestor is confirmed', async () => {
    await expect(fixture.unconfirmedTransaction.verify(fixture.confirmedTracker)).resolves.toBe(true)

    await expect(
      parseResults(answer(outputFor(fixture.unconfirmedBEEF)), fixture.confirmedTracker)
    ).resolves.toHaveLength(1)
  })

  it('rejects confirmed candidates with an invalid or unavailable chain root', async () => {
    const noRoots = new IdentityVerificationChainTracker()

    await expect(parseResults(answer(outputFor(fixture.certificateBEEF)), noRoots)).resolves.toEqual([])
  })

  it('rejects an unconfirmed candidate whose BEEF omits its ancestry', async () => {
    const disconnected = Transaction.fromBEEF(fixture.unconfirmedBEEF)
    disconnected.inputs[0].sourceTransaction = undefined
    disconnected.inputs[0].sourceTXID = fixture.unconfirmedTransaction.inputs[0].sourceTransaction?.id('hex') as string

    await expect(parseResults(answer(outputFor(disconnected.toBEEF(true))), fixture.confirmedTracker)).resolves.toEqual(
      []
    )
  })

  it('rejects invalid spend scripts and values instead of accepting scripts-only evidence', async () => {
    const invalidScript = Transaction.fromBEEF(fixture.unconfirmedBEEF)
    invalidScript.inputs[0].unlockingScript = Script.fromASM('OP_FALSE')
    const invalidValue = Transaction.fromBEEF(fixture.unconfirmedBEEF)
    invalidValue.outputs[0].satoshis = 11

    await expect(parseResults(answer(outputFor(invalidScript.toBEEF())), fixture.confirmedTracker)).resolves.toEqual([])
    await expect(parseResults(answer(outputFor(invalidValue.toBEEF())), fixture.confirmedTracker)).resolves.toEqual([])
  })

  it.each([
    ['mismatched', '00'.repeat(32)],
    ['empty', ''],
    ['malformed', 'not-a-txid']
  ])('rejects a %s txid hint', async (_kind, txid) => {
    await expect(
      parseResults(answer(outputFor(fixture.certificateBEEF, 0, txid)), fixture.confirmedTracker)
    ).resolves.toEqual([])
  })

  it('rejects a validly signed transaction that spends the same confirmed outpoint twice', async () => {
    const ancestor = fixture.unconfirmedTransaction.inputs[0].sourceTransaction!
    const spendingKey = new PrivateKey(13)
    const duplicateSpend = new Transaction()
    for (let index = 0; index < 2; index++) {
      duplicateSpend.addInput({
        sourceTransaction: ancestor,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(spendingKey)
      })
    }
    duplicateSpend.addOutput({ satoshis: 19, lockingScript: fixture.certificateTransaction.outputs[0].lockingScript })
    await duplicateSpend.sign()

    // SDK graph/value/script verification alone currently accepts duplicate outpoints.
    await expect(duplicateSpend.verify(fixture.confirmedTracker)).resolves.toBe(true)
    await expect(parseResults(answer(outputFor(duplicateSpend.toBEEF())), fixture.confirmedTracker)).resolves.toEqual(
      []
    )
  })

  it('rejects a joined graph whose distinct unconfirmed parents double-spend one confirmed outpoint', async () => {
    const ancestor = fixture.unconfirmedTransaction.inputs[0].sourceTransaction!
    const spendingKey = new PrivateKey(13)
    const createParent = async (satoshis: number): Promise<Transaction> => {
      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: ancestor,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(spendingKey)
      })
      tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(spendingKey.toAddress()) })
      await tx.sign()
      return tx
    }
    const first = await createParent(9)
    const second = await createParent(8)
    expect(first.id('hex')).not.toEqual(second.id('hex'))
    const joined = new Transaction()
    for (const sourceTransaction of [first, second]) {
      joined.addInput({
        sourceTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(spendingKey)
      })
    }
    joined.addOutput({ satoshis: 16, lockingScript: fixture.certificateTransaction.outputs[0].lockingScript })
    await joined.sign()

    await expect(joined.verify(fixture.confirmedTracker)).resolves.toBe(true)
    await expect(parseResults(answer(outputFor(joined.toBEEF())), fixture.confirmedTracker)).resolves.toEqual([])
  })

  it('rejects an identity child of an unconfirmed ancestor with duplicate inputs', async () => {
    const ancestor = fixture.unconfirmedTransaction.inputs[0].sourceTransaction!
    const spendingKey = new PrivateKey(13)
    const duplicateAncestor = new Transaction()
    for (let index = 0; index < 2; index++) {
      duplicateAncestor.addInput({
        sourceTransaction: ancestor,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(spendingKey)
      })
    }
    duplicateAncestor.addOutput({ satoshis: 19, lockingScript: new P2PKH().lock(spendingKey.toAddress()) })
    await duplicateAncestor.sign()
    const identityChild = new Transaction()
    identityChild.addInput({
      sourceTransaction: duplicateAncestor,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(spendingKey)
    })
    identityChild.addOutput({ satoshis: 9, lockingScript: fixture.certificateTransaction.outputs[0].lockingScript })
    await identityChild.sign()

    await expect(identityChild.verify(fixture.confirmedTracker)).resolves.toBe(true)
    await expect(parseResults(answer(outputFor(identityChild.toBEEF())), fixture.confirmedTracker)).resolves.toEqual([])
  })

  it('accepts a joined graph that spends distinct outputs of a shared unconfirmed ancestor', async () => {
    const spendingKey = new PrivateKey(13)
    const confirmedSource = new Transaction()
    confirmedSource.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    const lockingScript = new P2PKH().lock(spendingKey.toAddress())
    confirmedSource.addOutput({ satoshis: 10, lockingScript })
    confirmIdentityFixtureTransaction(confirmedSource, fixture.confirmedTracker)
    const ancestor = new Transaction()
    ancestor.addInput({
      sourceTransaction: confirmedSource,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(spendingKey)
    })
    ancestor.addOutput({ satoshis: 4, lockingScript })
    ancestor.addOutput({ satoshis: 4, lockingScript })
    await ancestor.sign()
    const parents: Transaction[] = []
    for (const [sourceOutputIndex, satoshis] of [
      [0, 3],
      [1, 2]
    ] as const) {
      const parent = new Transaction()
      parent.addInput({
        sourceTransaction: ancestor,
        sourceOutputIndex,
        unlockingScriptTemplate: new P2PKH().unlock(spendingKey)
      })
      parent.addOutput({ satoshis, lockingScript })
      await parent.sign()
      parents.push(parent)
    }
    const joined = new Transaction()
    for (const sourceTransaction of parents) {
      joined.addInput({
        sourceTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(spendingKey)
      })
    }
    joined.addOutput({ satoshis: 4, lockingScript: fixture.certificateTransaction.outputs[0].lockingScript })
    await joined.sign()

    await expect(joined.verify(fixture.confirmedTracker)).resolves.toBe(true)
    await expect(parseResults(answer(outputFor(joined.toBEEF())), fixture.confirmedTracker)).resolves.toHaveLength(1)
  })

  it.each([
    ['fractional', 0.5],
    ['negative', -1],
    ['out of range', 1]
  ])('rejects a %s output index', async (_kind, outputIndex) => {
    await expect(
      parseResults(answer(outputFor(fixture.certificateBEEF, outputIndex)), fixture.confirmedTracker)
    ).resolves.toEqual([])
  })

  it('rejects missing and tampered subject envelope signatures and a signature from another subject', async () => {
    const certificateJson = Utils.toArray(JSON.stringify(fixture.certificate), 'utf8')
    const missingSignature = await new PushDrop(fixture.subjectWallet).lock(
      [certificateJson],
      IDENTITY_VERIFICATION_PROTOCOL,
      IDENTITY_VERIFICATION_KEY_ID,
      'anyone',
      true,
      false
    )
    const tamperedSignature = await new PushDrop(fixture.subjectWallet).lock(
      [certificateJson],
      IDENTITY_VERIFICATION_PROTOCOL,
      IDENTITY_VERIFICATION_KEY_ID,
      'anyone',
      true,
      true
    )
    const signatureChunk = tamperedSignature.chunks[3]
    if (signatureChunk?.data == null) throw new Error('fixture envelope signature is missing')
    signatureChunk.data = [...signatureChunk.data]
    signatureChunk.data[0] ^= 1
    const wrongSubject = new ProtoWallet(new PrivateKey(14))
    const wrongKey = await new PushDrop(wrongSubject).lock(
      [certificateJson],
      IDENTITY_VERIFICATION_PROTOCOL,
      IDENTITY_VERIFICATION_KEY_ID,
      'anyone',
      true,
      true
    )

    const candidates = [missingSignature, tamperedSignature, wrongKey].map(lockingScript => {
      const tx = new Transaction()
      tx.addOutput({ satoshis: 9, lockingScript })
      confirmIdentityFixtureTransaction(tx, fixture.confirmedTracker)
      return outputFor(tx.toBEEF())
    })

    await expect(parseResults(answer(...candidates), fixture.confirmedTracker)).resolves.toEqual([])
  })

  it('rejects an input-free unconfirmed zero-value leaf', async () => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 0, lockingScript: fixture.certificateTransaction.outputs[0].lockingScript })

    await expect(parseResults(answer(outputFor(tx.toBEEF())), fixture.confirmedTracker)).resolves.toEqual([])
  })

  it('rejects an invalid certificate signature even when transaction and envelope verification pass', async () => {
    const tamperedCertificate = { ...fixture.certificate, signature: '00'.repeat(64) }
    const lockingScript = await new PushDrop(fixture.subjectWallet).lock(
      [Utils.toArray(JSON.stringify(tamperedCertificate), 'utf8')],
      IDENTITY_VERIFICATION_PROTOCOL,
      IDENTITY_VERIFICATION_KEY_ID,
      'anyone',
      true,
      true
    )
    const tx = new Transaction()
    tx.addOutput({ satoshis: 9, lockingScript })
    confirmIdentityFixtureTransaction(tx, fixture.confirmedTracker)

    await expect(parseResults(answer(outputFor(tx.toBEEF())), fixture.confirmedTracker)).resolves.toEqual([])
  })

  it('fails closed when SDK transaction or certificate verification returns false or throws', async () => {
    const txFalse = jest.spyOn(Transaction.prototype, 'verify').mockResolvedValueOnce(false)
    await expect(parseResults(answer(outputFor(fixture.certificateBEEF)), fixture.confirmedTracker)).resolves.toEqual(
      []
    )
    txFalse.mockRestore()

    const txThrows = jest
      .spyOn(Transaction.prototype, 'verify')
      .mockRejectedValueOnce(new Error('verification unavailable'))
    await expect(parseResults(answer(outputFor(fixture.certificateBEEF)), fixture.confirmedTracker)).resolves.toEqual(
      []
    )
    txThrows.mockRestore()

    const certFalse = jest.spyOn(VerifiableCertificate.prototype, 'verify').mockResolvedValueOnce(false)
    await expect(parseResults(answer(outputFor(fixture.certificateBEEF)), fixture.confirmedTracker)).resolves.toEqual(
      []
    )
    certFalse.mockRestore()
  })

  it('fails closed when the tracker throws or returns a non-boolean verdict', async () => {
    const throwingTracker = {
      currentHeight: async () => IDENTITY_VERIFICATION_CONFIRMED_HEIGHT + 101,
      isValidRootForHeight: async () => {
        throw new Error('tracker unavailable')
      }
    }
    const nonBooleanTracker = {
      currentHeight: async () => IDENTITY_VERIFICATION_CONFIRMED_HEIGHT + 101,
      isValidRootForHeight: async () => 'true'
    }

    await expect(parseResults(answer(outputFor(fixture.certificateBEEF)), throwingTracker)).resolves.toEqual([])
    await expect(parseResults(answer(outputFor(fixture.certificateBEEF)), nonBooleanTracker as never)).resolves.toEqual(
      []
    )
  })

  it('fails closed without a tracker and does not query an overlay resolver without one', async () => {
    const resolver = { query: jest.fn() } as unknown as LookupResolver

    await expect(parseResults(answer(outputFor(fixture.certificateBEEF)))).resolves.toEqual([])
    await expect(queryOverlay({ identityKey: fixture.certificate.subject }, resolver)).resolves.toEqual([])
    expect(resolver.query).not.toHaveBeenCalled()
  })

  it('uses the same verification path for progressive parsing and preserves a later valid candidate', async () => {
    const invalidProof = Transaction.fromBEEF(fixture.certificateBEEF)
    invalidProof.merklePath = new MerklePath(IDENTITY_VERIFICATION_CONFIRMED_HEIGHT, [
      [
        { offset: 0, hash: '43'.repeat(32) },
        { offset: 1, hash: invalidProof.id('hex'), txid: true }
      ]
    ])
    const candidates = answer(outputFor(invalidProof.toBEEF()), outputFor(fixture.certificateBEEF))

    await expect(collect(parseResults$(candidates, fixture.confirmedTracker))).resolves.toHaveLength(1)
    await expect(parseResults(candidates, fixture.confirmedTracker)).resolves.toHaveLength(1)
  })

  it('snapshots untrusted output bytes and index before the tracker can yield', async () => {
    let releaseVerification: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      releaseVerification = resolve
    })
    const tracker = {
      currentHeight: async () => IDENTITY_VERIFICATION_CONFIRMED_HEIGHT + 101,
      isValidRootForHeight: async (root: string, height: number) => {
        await gate
        return height === IDENTITY_VERIFICATION_CONFIRMED_HEIGHT && fixture.confirmedTracker.roots.has(root)
      }
    }
    const evidence = outputFor(fixture.certificateBEEF.slice())
    const verification = verifyOverlayOutput(evidence, tracker)
    evidence.outputIndex = 1
    evidence.beef.fill(0)
    releaseVerification!()

    await expect(verification).resolves.toMatchObject({
      txid: fixture.certificateTransaction.id('hex'),
      outputIndex: 0
    })
  })
})
