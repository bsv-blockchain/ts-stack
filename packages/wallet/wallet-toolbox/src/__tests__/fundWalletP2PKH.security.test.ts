import {
  Beef,
  LockingScript,
  MerklePath,
  OP,
  P2PKH,
  PrivateKey,
  Script,
  Transaction,
  UnlockingScript,
  WalletInterface
} from '@bsv/sdk'
import {
  buildBeefForOutpoints,
  fundWalletFromP2PKHOutpoints,
  parseTxAndAssertId,
  parseOutpoint,
  resolveAutoSigned,
  signAndComplete,
  verifyP2PKHOwnership
} from '../fundWalletP2PKH'

const SOURCE_SATOSHIS = 1_000

function spendFixture(): {
  key: PrivateKey
  lockingScript: LockingScript
  transaction: Transaction
} {
  const key = PrivateKey.fromRandom()
  const lockingScript = new P2PKH().lock(key.toPublicKey().toAddress())
  const source = new Transaction(1, [], [{ satoshis: SOURCE_SATOSHIS, lockingScript }], 0)
  const transaction = new Transaction(
    1,
    [
      {
        sourceTransaction: source,
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: new UnlockingScript()
      }
    ],
    [{ satoshis: 900, lockingScript: new LockingScript([{ op: OP.OP_RETURN }]) }],
    0
  )
  return { key, lockingScript, transaction }
}

describe('fundWalletP2PKH security boundaries', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('requires an unsigned 32-bit outpoint index', () => {
    expect(() => parseOutpoint(`${'00'.repeat(32)}.4294967296`)).toThrow('Invalid vout')
    expect(() => parseOutpoint(1 as unknown as string)).toThrow('Outpoint must be a string')
  })

  it.each([
    ['', 'non-empty canonical hexadecimal'],
    ['0', 'non-empty canonical hexadecimal'],
    ['zz', 'non-empty canonical hexadecimal']
  ])('rejects malformed fetched transaction bytes %p', (rawHex, message) => {
    expect(() => parseTxAndAssertId(rawHex, '00'.repeat(32))).toThrow(message)
  })

  it('binds canonical fetched bytes to the requested transaction ID', () => {
    const source = spendFixture().transaction.inputs[0].sourceTransaction!
    expect(parseTxAndAssertId(source.toHex(), source.id('hex')).id('hex')).toBe(source.id('hex'))
    expect(() => parseTxAndAssertId(source.toHex(), 'invalid')).toThrow('32-byte hexadecimal')
    expect(() => parseTxAndAssertId(source.toHex(), '00'.repeat(32))).toThrow('txid mismatch')
  })

  it('requires the complete standard P2PKH template and matching public key', () => {
    const { key, lockingScript } = spendFixture()
    expect(() => verifyP2PKHOwnership(lockingScript, key.toPublicKey())).not.toThrow()
    expect(() => verifyP2PKHOwnership(lockingScript, PrivateKey.fromRandom().toPublicKey())).toThrow(
      'does not match provided key'
    )

    for (let index = 0; index < lockingScript.chunks.length; index++) {
      const chunks = lockingScript.chunks.map(chunk => ({ ...chunk }))
      if (index === 2) chunks[index].data = [0]
      else chunks[index].op = OP.OP_FALSE
      expect(() => verifyP2PKHOwnership(new LockingScript(chunks), key.toPublicKey())).toThrow('P2PKH')
    }
    expect(() => verifyP2PKHOwnership(new LockingScript([]), key.toPublicKey())).toThrow('standard P2PKH')
  })

  it('rejects an auto-signed result that omits the transaction needed for binding', () => {
    expect(() => resolveAutoSigned({ txid: '11'.repeat(32) }, '22'.repeat(32), 0)).toThrow('omitted the transaction')
  })

  it('binds an auto-signed result to exactly one requested outpoint', () => {
    const { transaction } = spendFixture()
    const sourceTxid = transaction.inputs[0].sourceTransaction!.id('hex')
    const result = {
      txid: transaction.id('hex'),
      tx: transaction.toAtomicBEEF()
    }

    expect(resolveAutoSigned(result, sourceTxid, 0)).toBe(result.txid)
    expect(() => resolveAutoSigned(result, '33'.repeat(32), 0)).toThrow('requested outpoint exactly once')
  })

  it('selects the atomic target and rejects a mismatched signAction result', async () => {
    const { key, lockingScript, transaction } = spendFixture()
    const sourceTxid = transaction.inputs[0].sourceTransaction!.id('hex')
    const signAction = jest.fn().mockResolvedValue({
      txid: '44'.repeat(32),
      tx: transaction.toAtomicBEEF()
    })
    const wallet = { signAction } as unknown as WalletInterface

    await expect(
      signAndComplete(
        wallet,
        { tx: transaction.toAtomicBEEF(), reference: 'cmVmZXJlbmNl' },
        sourceTxid,
        0,
        SOURCE_SATOSHIS,
        { privateKey: key, publicKey: key.toPublicKey(), address: key.toPublicKey().toAddress() },
        (privateKey, satoshis) => new P2PKH().unlock(privateKey, 'all', false, satoshis, lockingScript)
      )
    ).rejects.toThrow('does not match the signed transaction')
    expect(signAction).toHaveBeenCalledTimes(1)
  })

  it('accepts only the exact transaction finalized from the requested signing spend', async () => {
    const { key, lockingScript, transaction } = spendFixture()
    const sourceTxid = transaction.inputs[0].sourceTransaction!.id('hex')
    const signAction = jest.fn(async (args: { spends: Record<number, { unlockingScript: string }> }) => {
      const finalized = Transaction.fromAtomicBEEF(transaction.toAtomicBEEF())
      finalized.inputs[0].unlockingScript = UnlockingScript.fromHex(args.spends[0].unlockingScript)
      return { txid: finalized.id('hex').toUpperCase(), tx: finalized.toAtomicBEEF() }
    })
    const wallet = { signAction } as unknown as WalletInterface

    await expect(
      signAndComplete(
        wallet,
        { tx: transaction.toAtomicBEEF(), reference: 'cmVmZXJlbmNl' },
        sourceTxid,
        0,
        SOURCE_SATOSHIS,
        { privateKey: key, publicKey: key.toPublicKey(), address: key.toPublicKey().toAddress() },
        (privateKey, satoshis) => new P2PKH().unlock(privateKey, 'all', false, satoshis, lockingScript)
      )
    ).resolves.toMatch(/^[0-9A-F]{64}$/)
    expect(signAction).toHaveBeenCalledTimes(1)
  })

  it('rejects a signAction result that omits the bound final transaction', async () => {
    const { key, lockingScript, transaction } = spendFixture()
    const sourceTxid = transaction.inputs[0].sourceTransaction!.id('hex')
    const signAction = jest.fn(async (args: { spends: Record<number, { unlockingScript: string }> }) => {
      const finalized = Transaction.fromAtomicBEEF(transaction.toAtomicBEEF())
      finalized.inputs[0].unlockingScript = UnlockingScript.fromHex(args.spends[0].unlockingScript)
      return { txid: finalized.id('hex') }
    })
    const wallet = { signAction } as unknown as WalletInterface

    await expect(
      signAndComplete(
        wallet,
        { tx: transaction.toAtomicBEEF(), reference: 'cmVmZXJlbmNl' },
        sourceTxid,
        0,
        SOURCE_SATOSHIS,
        { privateKey: key, publicKey: key.toPublicKey(), address: key.toPublicKey().toAddress() },
        (privateKey, satoshis) => new P2PKH().unlock(privateKey, 'all', false, satoshis, lockingScript)
      )
    ).rejects.toThrow('omitted the final transaction')
  })

  it('rejects missing requested inputs before invoking signAction', async () => {
    const { key, lockingScript, transaction } = spendFixture()
    const signAction = jest.fn()
    const wallet = { signAction } as unknown as WalletInterface

    await expect(
      signAndComplete(
        wallet,
        { tx: transaction.toAtomicBEEF(), reference: 'cmVmZXJlbmNl' },
        '55'.repeat(32),
        0,
        SOURCE_SATOSHIS,
        { privateKey: key, publicKey: key.toPublicKey(), address: key.toPublicKey().toAddress() },
        (privateKey, satoshis) => new P2PKH().unlock(privateKey, 'all', false, satoshis, lockingScript)
      )
    ).rejects.toThrow('requested outpoint exactly once')
    expect(signAction).not.toHaveBeenCalled()
  })

  it('bounds graph controls before making provider requests', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
    const outpoint = `${'66'.repeat(32)}.0`

    await expect(buildBeefForOutpoints([outpoint], Number.NaN)).rejects.toThrow('maxDepth')
    await expect(buildBeefForOutpoints(Array.from({ length: 257 }, () => outpoint))).rejects.toThrow(
      'between 1 and 256'
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects oversized provider bodies and disables redirects', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'content-length': String(32 * 1024 * 1024 + 1) }
      })
    )

    await expect(buildBeefForOutpoints([`${'77'.repeat(32)}.0`])).rejects.toThrow('Raw transaction response exceeds')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' })
  })

  it('bounds a streamed provider response and releases its reader', async () => {
    const cancel = jest.fn(async () => undefined)
    const releaseLock = jest.fn()
    const read = jest.fn().mockResolvedValueOnce({
      done: false,
      value: { length: 32 * 1024 * 1024 + 1 }
    })
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      body: { getReader: () => ({ read, cancel, releaseLock }) }
    } as unknown as Response)

    await expect(buildBeefForOutpoints([`${'79'.repeat(32)}.0`])).rejects.toThrow('Raw transaction response exceeds')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['invalid length', { ok: true, status: 200, headers: { get: () => '1e3' }, body: null }],
    ['missing body', { ok: true, status: 200, headers: { get: () => null }, body: null }]
  ])('fails closed on a provider response with %s', async (_name, response) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response as unknown as Response)
    await expect(buildBeefForOutpoints([`${'7a'.repeat(32)}.0`])).rejects.toThrow('Failed to fetch raw transaction')
  })

  it('builds BEEF from a canonical leaf transaction when no proof is available', async () => {
    const source = spendFixture().transaction.inputs[0].sourceTransaction!
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(source.toHex(), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))

    const binary = await buildBeefForOutpoints([`${source.id('hex')}.0`])
    expect(Beef.fromBinaryStrict(binary).findTxid(source.id('hex'))?.tx?.toHex()).toBe(source.toHex())
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('preserves a canonical Merkle proof returned with a leaf transaction', async () => {
    const source = spendFixture().transaction.inputs[0].sourceTransaction!
    const proof = MerklePath.fromCoinbaseTxidAndHeight(source.id('hex'), 100)
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(source.toHex(), { status: 200 }))
      .mockResolvedValueOnce(new Response(Uint8Array.from(proof.toBinary()), { status: 200 }))

    const binary = await buildBeefForOutpoints([`${source.id('hex')}.0`])
    const decoded = Beef.fromBinaryStrict(binary)
    const bumpIndex = decoded.findTxid(source.id('hex'))?.bumpIndex
    expect(bumpIndex).toEqual(expect.any(Number))
    expect(decoded.bumps[bumpIndex!].toBinary()).toEqual(proof.toBinary())
  })

  it('stops recursive unconfirmed ancestry at the configured depth', async () => {
    const parentTxid = '7b'.repeat(32)
    const child = new Transaction(
      1,
      [
        {
          sourceTXID: parentTxid,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: UnlockingScript.fromASM('OP_TRUE')
        }
      ],
      [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(child.toHex(), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))

    await expect(buildBeefForOutpoints([`${child.id('hex')}.0`], 0)).rejects.toThrow(
      `maxDepth=0 while resolving ${parentTxid}`
    )
  })

  it('fetches one transaction once when several requested outputs share it', async () => {
    const source = spendFixture().transaction.inputs[0].sourceTransaction!
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(source.toHex(), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))

    await expect(buildBeefForOutpoints([`${source.id('hex')}.0`, `${source.id('hex')}.1`])).resolves.not.toHaveLength(0)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('rejects duplicate outpoints before decoding caller-supplied BEEF', async () => {
    const { key } = spendFixture()
    const wallet = { createAction: jest.fn() } as unknown as WalletInterface
    const outpoint = `${'ab'.repeat(32)}.0`

    await expect(
      fundWalletFromP2PKHOutpoints(
        wallet,
        [outpoint, outpoint.toUpperCase()],
        { privateKey: key, publicKey: key.toPublicKey(), address: key.toPublicKey().toAddress() },
        () => {
          throw new Error('not reached')
        },
        new Beef().toBinary()
      )
    ).rejects.toThrow('Duplicate outpoint')
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('validates the public outpoint list before any wallet or provider work', async () => {
    const { key } = spendFixture()
    const wallet = { createAction: jest.fn() } as unknown as WalletInterface
    const keyPair = {
      privateKey: key,
      publicKey: key.toPublicKey(),
      address: key.toPublicKey().toAddress()
    }

    await expect(
      fundWalletFromP2PKHOutpoints(wallet, [], keyPair, () => {
        throw new Error('not reached')
      })
    ).rejects.toThrow('between 1 and 256')
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('imports a valid supplied P2PKH output and isolates per-outpoint failures', async () => {
    const { key, transaction } = spendFixture()
    const source = transaction.inputs[0].sourceTransaction!
    const beef = new Beef()
    beef.mergeTransaction(source)
    const createAction = jest.fn().mockResolvedValue({
      txid: transaction.id('hex'),
      tx: transaction.toAtomicBEEF()
    })
    const wallet = { createAction } as unknown as WalletInterface
    const p2pkhKey = {
      privateKey: key,
      publicKey: key.toPublicKey(),
      address: key.toPublicKey().toAddress()
    }

    await expect(
      fundWalletFromP2PKHOutpoints(
        wallet,
        [`${source.id('hex')}.0`, `${source.id('hex')}.1`],
        p2pkhKey,
        (privateKey, satoshis) => new P2PKH().unlock(privateKey, 'all', false, satoshis),
        beef.toBinary()
      )
    ).resolves.toEqual([
      { outpoint: `${source.id('hex')}.0`, txid: transaction.id('hex'), success: true },
      {
        outpoint: `${source.id('hex')}.1`,
        success: false,
        error: 'vout 1 out of range (tx has 1 outputs)'
      }
    ])
    expect(createAction).toHaveBeenCalledTimes(1)
    expect(createAction).toHaveBeenCalledWith(expect.objectContaining({ inputBEEF: beef.toBinary() }))
  })

  it('does not accept an arbitrary raw script as an atomic funding result', () => {
    const arbitrary = new Transaction(1, [], [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }], 0)
    expect(() =>
      resolveAutoSigned({ txid: arbitrary.id('hex'), tx: arbitrary.toAtomicBEEF() }, '88'.repeat(32), 0)
    ).toThrow('requested outpoint exactly once')
  })
})
