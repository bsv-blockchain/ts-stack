import { Transaction, UnlockingScript, MerklePath, P2PKH, PrivateKey, PublicKey } from '@bsv/sdk';
import { MockChain, makeWallet } from './test-utils';
import { P2MSKH } from '../src/P2MSKH';

const key = PrivateKey.fromRandom()

async function createSourceTransaction(threshold: number, totalKeys: number) {
    const wallet = await makeWallet()
    const player1 = await makeWallet()
    const player2 = await makeWallet()
    const player3 = await makeWallet()
    const player4 = await makeWallet()
    const player5 = await makeWallet()
    const player6 = await makeWallet()
    const player7 = await makeWallet()
    const player8 = await makeWallet()
    const player9 = await makeWallet()
    const player10 = await makeWallet()
    const allPlayers = [player1, player2, player3, player4, player5, player6, player7, player8, player9, player10]
    const players = allPlayers.slice(0, totalKeys)
    const { publicKey: counterparty } = await wallet.getPublicKey({ identityKey: true })

    const publicKeys = await Promise.all(players.map(async player => {
        const response = await player.getPublicKey({ identityKey: true })
        return response.publicKey
    }))

    const keyID = new Date().toISOString()

    const { address: multiSigAddress, pubkeys } = await P2MSKH.addressBRC29(wallet, publicKeys, keyID, threshold)
    
    const customInstructions = {
        keyID,
        counterparty,
        pubkeys
    }

    const sourceTransaction = new Transaction()
    sourceTransaction.addInput({
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: UnlockingScript.fromASM('01')
    })
    sourceTransaction.addOutput({
        satoshis: 1,
        lockingScript: new P2MSKH().lock(multiSigAddress)
    })
    sourceTransaction.addOutput({
        satoshis: 30,
        lockingScript: new P2PKH().lock(key.toAddress())
    })

    const txid = sourceTransaction.id('hex')
    sourceTransaction.merklePath = new MerklePath(0, [[{ txid: true, offset: 0, hash: txid }]])
    const mockChain = new MockChain({ blockheaders: [txid] })
    return { players, sourceTransaction, customInstructions, mockChain }
}

describe('P2MSKH', () => {
    it('should create and spend a 1 of 3 multisig and the estimated size should be known prior to signing', async () => {
    
        const { players, sourceTransaction, customInstructions, mockChain } = await createSourceTransaction(1, 3)
        
        const tx = new Transaction()
        tx.addInput({
            sourceTransaction,
            sourceOutputIndex: 0,
            unlockingScriptTemplate: new P2MSKH().unlock(players[0], customInstructions)
        })
        tx.addInput({
            sourceTransaction,
            sourceOutputIndex: 1,
            unlockingScriptTemplate: new P2PKH().unlock(key)
        })
        tx.addOutput({
            change: true,
            lockingScript: new P2PKH().lock(key.toAddress())
        })

        const estimateSize = await tx.inputs[0].unlockingScriptTemplate?.estimateLength(tx, 0)

        await tx.fee()
        await tx.sign()

        expect(estimateSize).toBeGreaterThanOrEqual(tx.inputs[0]?.unlockingScript?.toBinary().length as number)

        const passes = await tx.verify(mockChain)
        expect(passes).toBe(true)
    })

    const variations: [number, number][] = [
        [1, 2], [2, 2], [1, 3], [2, 3], [3, 5], [5, 7], [8, 9], [10, 10]
    ]

    it.each(variations)('should create and spend a %d of %d multisig', async (n: number, m: number) => {
        const { players, sourceTransaction, customInstructions, mockChain } = await createSourceTransaction(n, m)
        const tx = new Transaction()
        tx.addInput({
            sourceTransaction,
            sourceOutputIndex: 0,
            unlockingScriptTemplate: new P2MSKH().unlock(players[0], customInstructions)
        })
        tx.addInput({
            sourceTransaction,
            sourceOutputIndex: 1,
            unlockingScriptTemplate: new P2PKH().unlock(key)
        })
        tx.addOutput({
            change: true,
            lockingScript: new P2PKH().lock(key.toAddress())
        })

        await tx.fee()
        await tx.sign()

        let currentTx = tx
        for (let i = 1; i < n; i++) {
            const psbt = currentTx.toAtomicBEEF()
            currentTx = Transaction.fromAtomicBEEF(psbt)
            currentTx.inputs[0].unlockingScriptTemplate = new P2MSKH().unlock(players[i], customInstructions, currentTx.inputs[0].unlockingScript)
            await currentTx.sign()
        }

        const passes = await currentTx.verify(mockChain)
        expect(passes).toBe(true)
    })

    it('should fail to create a 0 of 2 multisig', async () => {
        const wallet = await makeWallet()
        const publicKeys = ['024964ca56207e80b55e21c4da143c20cde3649643f27dcf944e96f8b8265d773c', '03110092d60eaf76313c14cde4666ec0a960f3d9e8446cf7687d9a96501585328b']
        const keyID = new Date().toISOString()
        const threshold = 0
        await expect(P2MSKH.addressBRC29(wallet, publicKeys, keyID, threshold)).rejects.toThrow('threshold must be between 1 and the number of pubkeys')
    })

    it('should fail to create a 0 of 2 multisig without address derivation', async () => {
        const publicKeys = ['024964ca56207e80b55e21c4da143c20cde3649643f27dcf944e96f8b8265d773c', '03110092d60eaf76313c14cde4666ec0a960f3d9e8446cf7687d9a96501585328b'].map(p => PublicKey.fromString(p))
        const threshold = 0
        expect(() => new P2MSKH().lock(undefined, publicKeys, threshold)).toThrow('threshold must be between 1 and the number of pubkeys')
    })

    it('should fail to create a 3 of 2 multisig', async () => {
        const publicKeys = ['024964ca56207e80b55e21c4da143c20cde3649643f27dcf944e96f8b8265d773c', '03110092d60eaf76313c14cde4666ec0a960f3d9e8446cf7687d9a96501585328b'].map(p => PublicKey.fromString(p))
        const threshold = 3
        expect(() => new P2MSKH().lock(undefined, publicKeys, threshold)).toThrow('threshold must be between 1 and the number of pubkeys')
    })

    it('should fail to create a 1 of 2 multisig with only one pubkey', async () => {
        const publicKeys = ['024964ca56207e80b55e21c4da143c20cde3649643f27dcf944e96f8b8265d773c'].map(p => PublicKey.fromString(p))
        const threshold = 1
        expect(() => new P2MSKH().lock(undefined, publicKeys, threshold)).toThrow('at least 2 pubkeys are required')
    })

    it('should fail to create a 3 of 11 multisig', async () => {
        const publicKeys = Array(11).fill('024964ca56207e80b55e21c4da143c20cde3649643f27dcf944e96f8b8265d773c').map(p => PublicKey.fromString(p))
        const threshold = 3
        expect(() => new P2MSKH().lock(undefined, publicKeys, threshold)).toThrow('total must be less than or equal to 10')
    })
})