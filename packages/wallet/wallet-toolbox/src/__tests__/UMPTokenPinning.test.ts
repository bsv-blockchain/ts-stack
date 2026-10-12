import {
  Hash,
  Beef,
  Spend,
  LockingScript,
  PrivateKey,
  ProtoWallet,
  PushDrop,
  Transaction,
  UnlockingScript,
  MerklePath,
  Utils
} from '@bsv/sdk'
import { OverlayUMPTokenInteractor, UMPToken, UMPTokenLookupError } from '../CWIStyleWalletManager'

function token(outpoint: `${string}.${number}`, presentationHash: number[]): UMPToken {
  const field = Array(32).fill(1) as number[]
  return {
    passwordSalt: field,
    passwordPresentationPrimary: field,
    passwordRecoveryPrimary: field,
    presentationRecoveryPrimary: field,
    passwordPrimaryPrivileged: field,
    presentationRecoveryPrivileged: field,
    presentationHash,
    recoveryHash: Array(32).fill(2) as number[],
    presentationKeyEncrypted: field,
    passwordKeyEncrypted: field,
    recoveryKeyEncrypted: field,
    currentOutpoint: outpoint
  }
}

function resolution() {
  return {
    answer: { type: 'output-list' as const, outputs: [] },
    progress: {
      type: 'output-list' as const,
      outputs: [],
      txIds: [],
      isFinal: true,
      hostCount: 2,
      completedHosts: 2,
      successfulHosts: 2,
      emptyHosts: 0,
      failedHosts: 0,
      rejectedHosts: 0,
      freeformHosts: 0
    }
  }
}

describe('WAB-administered UMP pin fallback', () => {
  const presentationKey = Array(32).fill(7) as number[]
  const presentationHash = Hash.sha256(presentationKey)
  const firstOutpoint = `${'a'.repeat(64)}.0` as const
  const secondOutpoint = `${'b'.repeat(64)}.1` as const

  function interactor() {
    const resolver = { queryDetailed: jest.fn(async () => resolution()) }
    const subject = new OverlayUMPTokenInteractor(resolver as any, {} as any)
    const first = token(firstOutpoint, presentationHash)
    const second = token(secondOutpoint, presentationHash)
    jest.spyOn(subject as any, 'parseLookupAnswers').mockReturnValue([first, second])
    return { subject, first, second }
  }

  it('uses the pin only after normal lineage resolution remains ambiguous', async () => {
    const { subject, second } = interactor()
    jest.spyOn(subject as any, 'resolveNewestToken').mockReturnValue(undefined)

    await expect(subject.findByPresentationKeyHash(presentationHash, { pinnedOutpoint: secondOutpoint })).resolves.toBe(
      second
    )
  })

  it('keeps the normal lineage winner even when the WAB pin names another candidate', async () => {
    const { subject, first } = interactor()
    jest.spyOn(subject as any, 'resolveNewestToken').mockReturnValue(first)

    await expect(subject.findByPresentationKeyHash(presentationHash, { pinnedOutpoint: secondOutpoint })).resolves.toBe(
      first
    )
  })

  it('does not accept a pin that is absent from the verified matching candidates', async () => {
    const { subject } = interactor()
    jest.spyOn(subject as any, 'resolveNewestToken').mockReturnValue(undefined)

    await expect(
      subject.findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: `${'c'.repeat(64)}.0`
      })
    ).rejects.toMatchObject<Partial<UMPTokenLookupError>>({ reason: 'token-ambiguous' })
  })

  it('builds and broadcasts a finalized UMP token through the shared action path', async () => {
    const { subject, first } = interactor()
    const completed = new Transaction(
      1,
      [],
      [
        { satoshis: 2, lockingScript: LockingScript.fromHex('00') },
        { satoshis: 1, lockingScript: LockingScript.fromHex('51') }
      ],
      0
    )
    const finalizedOutpoint = `${completed.id('hex')}.1`
    const broadcast = jest.fn(async () => ({
      status: 'success' as const,
      txid: completed.id('hex'),
      message: 'published'
    }))
    Object.assign(subject as any, { broadcaster: { broadcast } })
    const lock = jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue({ toHex: () => '51' } as any)
    const fields = jest.spyOn(subject as any, 'tokenFields').mockReturnValue([])
    const oldInput = jest.spyOn(subject as any, 'resolveOldInput').mockResolvedValue({
      resolvedOldToken: undefined,
      inputToken: undefined
    })
    const complete = jest.spyOn(subject as any, 'completeUMPAction').mockResolvedValue(completed)

    await expect(subject.buildAndSend({} as any, 'admin.example', first)).resolves.toBe(finalizedOutpoint)
    expect(fields).toHaveBeenCalledWith(first)
    expect(oldInput).toHaveBeenCalledWith(undefined)
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        inputs: [],
        outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'New UMP token output' }]
      }),
      expect.anything(),
      'admin.example'
    )
    expect(broadcast).toHaveBeenCalledWith(completed)
    lock.mockRestore()
  })

  it('refuses ambiguous token outputs and mismatched broadcast identities', async () => {
    const { subject } = interactor()
    const duplicate = new Transaction(
      1,
      [],
      [
        { satoshis: 1, lockingScript: LockingScript.fromHex('51') },
        { satoshis: 1, lockingScript: LockingScript.fromHex('51') }
      ],
      0
    )
    const broadcast = jest.fn()
    Object.assign(subject as any, { broadcaster: { broadcast } })
    await expect((subject as any).broadcastUMPTransaction(duplicate, '51', 'create')).rejects.toThrow(
      'exactly one requested token output'
    )
    expect(broadcast).not.toHaveBeenCalled()

    const unique = new Transaction(1, [], [{ satoshis: 1, lockingScript: LockingScript.fromHex('51') }], 0)
    broadcast.mockResolvedValue({ status: 'success', txid: 'f'.repeat(64), message: 'substituted' })
    await expect((subject as any).broadcastUMPTransaction(unique, '51', 'create')).rejects.toThrow(
      'transaction ID mismatch'
    )
  })

  it('will not sign renewal of a canonical token owned by another wallet', async () => {
    const { subject } = interactor()
    const attackerWallet = new ProtoWallet(PrivateKey.fromRandom())
    const localWallet = new ProtoWallet(PrivateKey.fromRandom())
    const forgedToken = token(`${'0'.repeat(64)}.0`, presentationHash)
    const fields = (subject as any).tokenFields(forgedToken)
    const lockingScript = await new PushDrop(attackerWallet).lock(
      fields,
      [2, 'admin user management token'],
      '1',
      'self',
      true,
      true
    )
    const source = new Transaction(1, [], [{ satoshis: 1, lockingScript }], 0)
    forgedToken.currentOutpoint = `${source.id('hex')}.0`

    await expect(
      (subject as any).assertOwnedUMPInput(localWallet, 'admin.example', forgedToken, {
        beef: source.toBEEF(),
        outputIndex: 0
      })
    ).rejects.toThrow('not controlled by this wallet')
  })
})

describe('Pinned UMP token update continuity', () => {
  const presentationHash = Hash.sha256(Array(32).fill(7))
  const wallet = new ProtoWallet(new PrivateKey(42))

  async function record(
    version: number,
    predecessor?: Transaction,
    hash = presentationHash,
    recoveryHash = Array(32).fill(2) as number[]
  ): Promise<Transaction> {
    const fields = token(`${'0'.repeat(64)}.0`, hash)
    fields.recoveryHash = recoveryHash
    fields.passwordSalt = Array(32).fill(version)
    fields.passwordKeyEncrypted = Array(32).fill(version)
    const interactor = new OverlayUMPTokenInteractor({} as any, {} as any)
    const script = await new PushDrop(wallet).lock(
      (interactor as any).tokenFields(fields),
      [2, 'admin user management token'],
      '1',
      'self',
      true,
      true
    )
    const tx = new Transaction(1, [], [{ satoshis: 1, lockingScript: script }], version)
    if (predecessor != null) {
      tx.addInput({
        sourceTransaction: predecessor,
        sourceOutputIndex: 0,
        unlockingScript: new UnlockingScript([]),
        sequence: 0xffffffff
      })
      tx.inputs[0].unlockingScript = await new PushDrop(wallet)
        .unlock([2, 'admin user management token'], '1', 'self')
        .sign(tx, 0)
    } else {
      // A synthetic mined root is the fixture's funding axiom; no public chain is used.
      tx.merklePath = new MerklePath(100, [[{ offset: 0, hash: tx.id('hex'), txid: true }]])
    }
    return tx
  }

  function retainedHistory(tx: Transaction): number[] {
    const beef = new Beef()
    const visited = new Set<string>()
    function merge(current: Transaction): void {
      const txid = current.id('hex')
      if (visited.has(txid)) return
      visited.add(txid)
      for (const input of current.inputs) {
        if (input.sourceTransaction != null) merge(input.sourceTransaction)
      }
      beef.mergeTransaction(current)
    }
    merge(tx)
    const writer = new Utils.Writer()
    beef.toWriter(writer)
    return writer.toArray()
  }

  function lookup(transactions: Transaction[], includeHistory = false) {
    const detailed = resolution()
    const outputs = transactions.map(tx => ({
      beef: includeHistory ? retainedHistory(tx) : tx.toBEEF(true),
      outputIndex: 0
    }))
    const answer = { ...detailed, answer: { ...detailed.answer, outputs } }
    return new OverlayUMPTokenInteractor({ queryDetailed: jest.fn(async () => answer) } as any, {} as any)
  }

  function outpoint(tx: Transaction): `${string}.${number}` {
    return `${tx.id('hex')}.0`
  }

  it('keeps a current pin over an unrelated historical continuation', async () => {
    const obsolete = await record(1)
    const staleContinuation = await record(2, obsolete)
    const canonical = await record(3)
    const result = await lookup([staleContinuation, canonical]).findByPresentationKeyHash(presentationHash, {
      pinnedOutpoint: outpoint(canonical)
    })
    expect(result?.currentOutpoint).toBe(outpoint(canonical))
    expect(result?.passwordKeyEncrypted).toEqual(Array(32).fill(3))
  })

  it('returns changed password state after an update consumes the pin, despite an unrelated fork', async () => {
    const pinned = await record(1)
    const changedPassword = await record(2, pinned)
    const unrelated = await record(3)
    const result = await lookup([unrelated, pinned, changedPassword]).findByPresentationKeyHash(presentationHash, {
      pinnedOutpoint: outpoint(pinned)
    })
    expect(result?.currentOutpoint).toBe(outpoint(changedPassword))
    expect(result?.passwordSalt).toEqual(Array(32).fill(2))
    expect(result?.passwordKeyEncrypted).toEqual(Array(32).fill(2))
  })

  it('returns confirmed password state when the verified old pin is still in the answer', async () => {
    const pinned = await record(1)
    const updated = await record(2, pinned)
    updated.merklePath = new MerklePath(101, [[{ offset: 0, hash: updated.id('hex'), txid: true }]])
    const unrelated = await record(3)
    await expect(
      lookup([unrelated, pinned, updated]).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(pinned)
      })
    ).resolves.toMatchObject({ currentOutpoint: outpoint(updated), passwordKeyEncrypted: Array(32).fill(2) })
  })

  it('requires missing pin ancestry instead of selecting an unrelated continuation after confirmation', async () => {
    const pinned = await record(1)
    const updated = await record(2, pinned)
    updated.merklePath = new MerklePath(101, [[{ offset: 0, hash: updated.id('hex'), txid: true }]])
    const otherRoot = await record(3)
    const unrelated = await record(4, otherRoot)
    await expect(
      lookup([unrelated, updated]).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(pinned)
      })
    ).rejects.toMatchObject({ reason: 'token-ambiguous' })
  })

  it('follows retained confirmed history when the old pin is absent from the answer', async () => {
    const pinned = await record(1)
    const updated = await record(2, pinned)
    updated.merklePath = new MerklePath(101, [[{ offset: 0, hash: updated.id('hex'), txid: true }]])
    const otherRoot = await record(3)
    const unrelated = await record(4, otherRoot)
    await expect(
      lookup([unrelated, updated], true).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(pinned)
      })
    ).resolves.toMatchObject({ currentOutpoint: outpoint(updated), passwordKeyEncrypted: Array(32).fill(2) })
  })

  it('follows retained multi-hop history across confirmed intermediate and current tokens', async () => {
    const pinned = await record(1)
    const intermediate = await record(2, pinned)
    intermediate.merklePath = new MerklePath(101, [[{ offset: 0, hash: intermediate.id('hex'), txid: true }]])
    const latest = await record(3, intermediate)
    latest.merklePath = new MerklePath(102, [[{ offset: 0, hash: latest.id('hex'), txid: true }]])
    const unrelated = await record(4)
    await expect(
      lookup([unrelated, latest], true).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(pinned)
      })
    ).resolves.toMatchObject({ currentOutpoint: outpoint(latest), passwordKeyEncrypted: Array(32).fill(3) })
  })

  it('requires token-spend authorization even when the update is confirmed', async () => {
    const pinned = await record(1)
    const updated = await record(2, pinned)
    updated.merklePath = new MerklePath(101, [[{ offset: 0, hash: updated.id('hex'), txid: true }]])
    const unrelated = await record(3)
    const authorize = jest.spyOn(Spend.prototype, 'validate').mockReturnValue(false)
    try {
      await expect(
        lookup([unrelated, pinned, updated]).findByPresentationKeyHash(presentationHash, {
          pinnedOutpoint: outpoint(pinned)
        })
      ).resolves.toMatchObject({ currentOutpoint: outpoint(pinned) })
      expect(authorize).toHaveBeenCalled()
    } finally {
      authorize.mockRestore()
    }
  })

  it('checks a confirmed multi-input update using the retained token source', async () => {
    const pinned = await record(1)
    const updated = await record(2, pinned)
    const funding = new Transaction(1, [], [{ satoshis: 5, lockingScript: LockingScript.fromHex('51') }], 0)
    updated.addInput({
      sourceTransaction: funding,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript([]),
      sequence: 0xffffffff
    })
    updated.inputs[0].unlockingScript = await new PushDrop(wallet)
      .unlock([2, 'admin user management token'], '1', 'self')
      .sign(updated, 0)
    updated.merklePath = new MerklePath(101, [[{ offset: 0, hash: updated.id('hex'), txid: true }]])
    const unrelated = await record(3)
    await expect(
      lookup([unrelated, pinned, updated]).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(pinned)
      })
    ).resolves.toMatchObject({ currentOutpoint: outpoint(updated), passwordKeyEncrypted: Array(32).fill(2) })
  })

  it('follows an authorized token update after both presentation and recovery hashes rotate', async () => {
    const pinned = await record(1)
    const rotatedHash = Hash.sha256(Array(32).fill(8))
    const rotatedRecovery = Hash.sha256(Array(32).fill(9))
    const updated = await record(2, pinned, rotatedHash, rotatedRecovery)
    const unrelated = await record(3, undefined, rotatedHash, rotatedRecovery)
    await expect(
      lookup([unrelated, updated]).findByPresentationKeyHash(rotatedHash, {
        pinnedOutpoint: outpoint(pinned)
      })
    ).resolves.toMatchObject({ currentOutpoint: outpoint(updated), recoveryHash: rotatedRecovery })
  })

  it('follows a multi-hop update when the pin and intermediate rendition are absent from the answer', async () => {
    const pinned = await record(1)
    const intermediate = await record(2, pinned)
    const latest = await record(3, intermediate)
    const otherRoot = await record(4)
    const otherUpdate = await record(5, otherRoot)
    await expect(
      lookup([otherUpdate, latest]).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(pinned)
      })
    ).resolves.toMatchObject({ currentOutpoint: outpoint(latest), passwordKeyEncrypted: Array(32).fill(3) })
  })

  it('follows recovery-hash continuity after a presentation-key rotation', async () => {
    const pinned = await record(1)
    const rotated = await record(2, pinned, Hash.sha256(Array(32).fill(8)))
    const unrelated = await record(3)
    await expect(
      lookup([unrelated, rotated]).findByRecoveryKeyHash(Array(32).fill(2), {
        pinnedOutpoint: outpoint(pinned)
      })
    ).resolves.toMatchObject({ currentOutpoint: outpoint(rotated), presentationHash: Hash.sha256(Array(32).fill(8)) })
  })

  it('does not fall back to a consumed pin when its descendants remain forked', async () => {
    const pinned = await record(1)
    const updateA = await record(2, pinned)
    const updateB = await record(3, pinned)
    await expect(
      lookup([pinned, updateA, updateB]).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(pinned)
      })
    ).rejects.toMatchObject({ reason: 'token-ambiguous' })
  })

  it('ignores a pin naming a non-UMP funding input', async () => {
    const funding = new Transaction(1, [], [{ satoshis: 1, lockingScript: LockingScript.fromHex('51') }], 0)
    const first = await record(2, funding)
    const second = await record(3)
    await expect(
      lookup([first, second]).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(funding)
      })
    ).rejects.toMatchObject({ reason: 'token-ambiguous' })
  })

  it('does not let a truncated update override a verified pin', async () => {
    const pinned = await record(1)
    const update = await record(2, pinned)
    const partial = Transaction.fromBinary(update.toBinary())
    await expect(
      lookup([pinned, partial]).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(pinned)
      })
    ).resolves.toMatchObject({ currentOutpoint: outpoint(pinned) })
  })

  it('uses a complete copy when another host returned the same update with truncated ancestry', async () => {
    const pinned = await record(1)
    const update = await record(2, pinned)
    const partial = Transaction.fromBinary(update.toBinary())
    await expect(
      lookup([partial, pinned, update]).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(pinned)
      })
    ).resolves.toMatchObject({ currentOutpoint: outpoint(update) })
  })

  it('does not require a pin for an ordinary update chain', async () => {
    const previous = await record(1)
    const latest = await record(2, previous)
    await expect(lookup([previous, latest]).findByPresentationKeyHash(presentationHash)).resolves.toMatchObject({
      currentOutpoint: outpoint(latest)
    })
  })

  it('ignores a valid record with a different requested presentation hash', async () => {
    const pinned = await record(1)
    const updated = await record(2, pinned)
    const unrelated = await record(3)
    const otherHash = await record(4, undefined, Hash.sha256(Array(32).fill(9)))
    await expect(
      lookup([unrelated, otherHash, pinned, updated]).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(pinned)
      })
    ).resolves.toMatchObject({ currentOutpoint: outpoint(updated), passwordKeyEncrypted: Array(32).fill(2) })
  })

  it('keeps usable update evidence when another provider copy cannot be decoded', async () => {
    const pinned = await record(1)
    const updated = await record(2, pinned)
    const unrelated = await record(3)
    const subject = lookup([unrelated, pinned, updated])
    const readHistory = (subject as any).readTokenHistory.bind(subject)
    const decode = jest.spyOn(subject as any, 'readTokenHistory').mockImplementation(bytes => {
      const tx = readHistory(bytes) as Transaction
      if (tx.id('hex') === unrelated.id('hex')) throw new Error('Synthetic provider decode failure')
      return tx
    })
    try {
      await expect(
        subject.findByPresentationKeyHash(presentationHash, { pinnedOutpoint: outpoint(pinned) })
      ).resolves.toMatchObject({ currentOutpoint: outpoint(updated), passwordKeyEncrypted: Array(32).fill(2) })
    } finally {
      decode.mockRestore()
    }
  })

  it('refuses a confirmed descendant when the spend evaluator raises an error', async () => {
    const pinned = await record(1)
    const updated = await record(2, pinned)
    updated.merklePath = new MerklePath(101, [[{ offset: 0, hash: updated.id('hex'), txid: true }]])
    const unrelated = await record(3)
    const authorize = jest.spyOn(Spend.prototype, 'validate').mockImplementation(() => {
      throw new Error('Synthetic spend evaluator failure')
    })
    try {
      await expect(
        lookup([unrelated, updated], true).findByPresentationKeyHash(presentationHash, {
          pinnedOutpoint: outpoint(pinned)
        })
      ).rejects.toMatchObject({ reason: 'token-ambiguous' })
      expect(authorize).toHaveBeenCalled()
    } finally {
      authorize.mockRestore()
    }
  })

  it('does not treat a different-valued funding output as a UMP pin', async () => {
    const funding = await record(1)
    funding.outputs[0].satoshis = 5
    funding.merklePath = new MerklePath(100, [[{ offset: 0, hash: funding.id('hex'), txid: true }]])
    const updated = await record(2, funding)
    const unrelated = await record(3)
    await expect(
      lookup([unrelated, updated]).findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: outpoint(funding)
      })
    ).rejects.toMatchObject({ reason: 'token-ambiguous' })
  })
})
