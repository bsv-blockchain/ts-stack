// Minimal Rúnar contract used to prove that `p rabin` wallet output verifies on chain
// with Rúnar's own `verifyRabinSig` codegen. One public method, one Rabin key.
import { SmartContract, assert, verifyRabinSig } from 'runar-lang'
import type { ByteString, RabinSig, RabinPubKey } from 'runar-lang'

export class RabinCheck extends SmartContract {
  readonly key: RabinPubKey

  constructor(key: RabinPubKey) {
    super(key)
    this.key = key
  }

  public check(msg: ByteString, sig: RabinSig, padding: ByteString) {
    assert(verifyRabinSig(msg, sig, padding, this.key))
  }
}
