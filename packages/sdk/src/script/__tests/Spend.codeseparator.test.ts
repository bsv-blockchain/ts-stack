import PrivateKey from '../../primitives/PrivateKey'
import { sha256 } from '../../primitives/Hash'
import Spend from '../../script/Spend'
import Transaction from '../../transaction/Transaction'
import TransactionSignature from '../../primitives/TransactionSignature'
import LockingScript from '../../script/LockingScript'
import UnlockingScript from '../../script/UnlockingScript'
import Script from '../../script/Script'
import OP from '../../script/OP'

/**
 * Regression test for the CHECKSIG subscript across an OP_CODESEPARATOR in the unlocking script.
 *
 * When an OP_CODESEPARATOR is executed in the *unlocking* script and an OP_CHECKSIG then runs
 * (still in unlocking-script context), the signature's subscript must span from after that
 * separator across the unlock/lock boundary into the FULL locking script (legacy combined-script
 * semantics, which BSV nodes enforce). This is the basis of OP_PUSH_TX-style contracts.
 *
 * Before the fix, Spend built the subscript from the unlocking script alone, so a signature taken
 * over <unlock-tail> ++ <locking-script> was rejected ("OP_CHECKSIGVERIFY requires a valid
 * signature"), even though BSV consensus accepts the transaction.
 */
describe('Spend — CHECKSIG subscript across OP_CODESEPARATOR in the unlocking script', () => {
  it('validates a signature whose subscript spans into the locking script', () => {
    const priv = new PrivateKey(42)
    const pub = priv.toPublicKey()
    const pubEnc = pub.encode(true) as number[]
    const satoshis = 1000
    const scope = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

    // Non-empty locking-script tail that MUST be part of the subscript (proves the concat).
    const lockingScript = new LockingScript([{ op: OP.OP_NOP }, { op: OP.OP_NOP }])

    // Version 2 -> "relaxed" rules (post-Genesis/Chronicle), so the non-push unlocking script
    // below is permitted (push-only is only enforced for legacy v1 transactions).
    const sourceTx = new Transaction(2, [], [{ lockingScript, satoshis }], 0)

    // The subscript the interpreter derives (after findAndDelete removes the signature push):
    //   <unlock-after-codesep without the sig> ++ <locking script>
    //   = [ <pubkey> OP_CHECKSIG ] ++ [ OP_NOP OP_NOP ]
    const subscript = new Script([
      { op: pubEnc.length, data: pubEnc },
      { op: OP.OP_CHECKSIG },
      ...lockingScript.chunks
    ])

    const preimage = TransactionSignature.formatBytes({
      sourceTXID: sourceTx.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: satoshis,
      transactionVersion: 2,
      otherInputs: [],
      outputs: [],
      inputIndex: 0,
      subscript,
      inputSequence: 0xffffffff,
      lockTime: 0,
      scope
    })
    const raw = priv.sign(sha256(preimage))
    const sig = new TransactionSignature(raw.r, raw.s, scope)
    const sigForScript = sig.toChecksigFormat()

    // Unlocking script: OP_CODESEPARATOR then <sig> <pubkey> OP_CHECKSIG (checksig runs here).
    const unlockingScript = new UnlockingScript([
      { op: OP.OP_CODESEPARATOR },
      { op: sigForScript.length, data: sigForScript },
      { op: pubEnc.length, data: pubEnc },
      { op: OP.OP_CHECKSIG }
    ])

    const spend = new Spend({
      sourceTXID: sourceTx.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: satoshis,
      lockingScript,
      transactionVersion: 2,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript,
      outputs: [],
      inputSequence: 0xffffffff,
      lockTime: 0
    })

    expect(spend.validate()).toBe(true)
  })
})
