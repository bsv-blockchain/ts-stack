import { CachedKeyDeriver, P2PKH, PrivateKey, PublicKey, Script, Transaction } from '@bsv/sdk'
import { brc29ProtocolID, ScriptTemplateBRC29 } from '../ScriptTemplateBRC29'

describe('ScriptTemplateBRC29', () => {
  it('reuses only a matching cached root key for string and object inputs', () => {
    const cachedRoot = new PrivateKey(38)
    const template = new ScriptTemplateBRC29({
      derivationPrefix: 'cache-prefix',
      derivationSuffix: 'cache-suffix',
      keyDeriver: new CachedKeyDeriver(cachedRoot)
    })
    const differentStringRoot = new PrivateKey(39)
    const differentObjectRoot = new PrivateKey(40)

    expect(template.getKeyDeriver(cachedRoot)).toBe(template.params.keyDeriver)
    expect(template.getKeyDeriver(differentStringRoot.toHex()).rootKey.toHex())
      .toBe(differentStringRoot.toHex())
    expect(template.getKeyDeriver(differentObjectRoot).rootKey.toHex())
      .toBe(differentObjectRoot.toHex())
  })

  it('preserves string-key signing bytes when passed cached key objects', async () => {
    const rootKey = new PrivateKey(41)
    const counterparty = new PrivateKey(42).toPublicKey()
    const params = {
      derivationPrefix: 'equivalence-prefix',
      derivationSuffix: 'equivalence-suffix'
    }
    const keyID = `${params.derivationPrefix} ${params.derivationSuffix}`
    const baselineDeriver = new CachedKeyDeriver(PrivateKey.fromHex(rootKey.toHex()))
    const derived = baselineDeriver.derivePrivateKey(brc29ProtocolID, keyID, counterparty.toString())
    const source = new Transaction()
    source.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0xffffffff,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(derived.toAddress()) })

    const sign = async (unlockingScriptTemplate: ReturnType<ScriptTemplateBRC29['unlock']>): Promise<string> => {
      const tx = new Transaction()
      tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScriptTemplate })
      tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
      await tx.sign()
      return tx.toHex()
    }

    const template = new ScriptTemplateBRC29({ ...params, keyDeriver: new CachedKeyDeriver(rootKey) })
    const stringKeyBytes = await sign(template.unlock(rootKey.toHex(), counterparty.toString()))
    const objectKeyBytes = await sign(template.unlock(rootKey, PublicKey.fromString(counterparty.toString())))
    const batchDerived = template.params.keyDeriver.derivePrivateKeys?.([{
      protocolID: brc29ProtocolID,
      keyID,
      counterparty
    }])[0]
    const batchBytes = await sign(template.unlockWithDerivedPrivateKey(batchDerived!, 2, source.outputs[0].lockingScript))
    const baselineBytes = await sign(new P2PKH().unlock(derived, 'all', false, 2, source.outputs[0].lockingScript))

    expect(objectKeyBytes).toBe(stringKeyBytes)
    expect(objectKeyBytes).toBe(baselineBytes)
    expect(batchBytes).toBe(baselineBytes)
  })
})
