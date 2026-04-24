import { describe, expect, test } from '@jest/globals';
import {
  PrivateKey,
  PublicKey,
  Transaction,
  Script,
  MerklePath,
  Utils,
  Hash,
  WalletProtocol,
  WalletCounterparty
} from '@bsv/sdk';
import P2PKH from '../p2pkh';
import { makeWallet } from '../../utils/mockWallet';

// Test storage URL for test wallets
const storageURL = "https://store-us-1.bsvb.tech";

describe('P2PKH locking script', () => {
  describe('lock with public key string', () => {
    test('should create a valid P2PKH locking script from a public key hex string', async () => {
      const privateKey = new PrivateKey(1);
      const publicKey = privateKey.toPublicKey();
      const publicKeyHex = publicKey.toString();

      const p2pkh = new P2PKH();
      const lockingScript = await p2pkh.lock({ publicKey: publicKeyHex });

      // Verify the script structure
      const scriptChunks = lockingScript.chunks;
      expect(scriptChunks).toHaveLength(5);
      expect(scriptChunks[0].op).toBe(118); // OP_DUP
      expect(scriptChunks[1].op).toBe(169); // OP_HASH160
      expect(scriptChunks[2].data).toHaveLength(20); // 20-byte hash
      expect(scriptChunks[3].op).toBe(136); // OP_EQUALVERIFY
      expect(scriptChunks[4].op).toBe(172); // OP_CHECKSIG
    });

    test('should produce the same hash as manual hash160', async () => {
      const privateKey = new PrivateKey(2);
      const publicKey = privateKey.toPublicKey();
      const publicKeyHex = publicKey.toString();

      const p2pkh = new P2PKH();
      const lockingScript = await p2pkh.lock({ publicKey: publicKeyHex });

      // Get the hash from the script
      const scriptHash = lockingScript.chunks[2].data;

      // Calculate expected hash
      const expectedHash = publicKey.toHash();

      expect(scriptHash).toEqual(expectedHash);
    });
  });

  describe('lock with public key hash array', () => {
    test('should create a valid P2PKH locking script from a 20-byte hash', async () => {
      const privateKey = new PrivateKey(3);
      const publicKey = privateKey.toPublicKey();
      const pubKeyHash = publicKey.toHash() as number[];

      const p2pkh = new P2PKH();
      const lockingScript = await p2pkh.lock({ pubkeyhash: pubKeyHash });

      // Verify the script structure
      const scriptChunks = lockingScript.chunks;
      expect(scriptChunks).toHaveLength(5);
      expect(scriptChunks[2].data).toEqual(pubKeyHash);
    });

    test('should reject hash with incorrect length', async () => {
      const invalidHash = new Array(19).fill(0); // Wrong length

      const p2pkh = new P2PKH();
      await expect(p2pkh.lock({ pubkeyhash: invalidHash })).rejects.toThrow('Failed to generate valid public key hash (must be 20 bytes)');
    });
  });

  describe('lock with BRC-100 wallet', () => {
    test('should create a valid P2PKH locking script using wallet', async () => {
      const privateKey = new PrivateKey(4);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const p2pkh = new P2PKH(wallet);
      const lockingScript = await p2pkh.lock({
        walletParams: {
          protocolID: [2, 'p2pkh'] as WalletProtocol,
          keyID: '0',
          counterparty: 'self' as WalletCounterparty
        }
      });

      // Verify the script structure
      const scriptChunks = lockingScript.chunks;
      expect(scriptChunks).toHaveLength(5);
      expect(scriptChunks[0].op).toBe(118); // OP_DUP
      expect(scriptChunks[1].op).toBe(169); // OP_HASH160
      expect(scriptChunks[2].data).toHaveLength(20); // 20-byte hash
      expect(scriptChunks[3].op).toBe(136); // OP_EQUALVERIFY
      expect(scriptChunks[4].op).toBe(172); // OP_CHECKSIG
    });

    test('should create the same locking script as direct public key', async () => {
      const privateKey = new PrivateKey(5);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const protocolID = [2, 'p2pkh'] as WalletProtocol;
      const keyID = '0';
      const counterparty = 'self' as WalletCounterparty;

      // Get public key from wallet
      const { publicKey } = await wallet.getPublicKey({
        protocolID,
        keyID,
        counterparty
      });

      const p2pkhWithWallet = new P2PKH(wallet);
      const p2pkhWithoutWallet = new P2PKH();

      // Lock with wallet
      const lockingScriptFromWallet = await p2pkhWithWallet.lock({
        walletParams: {
          protocolID,
          keyID,
          counterparty
        }
      });

      // Lock with public key string
      const lockingScriptFromPubKey = await p2pkhWithoutWallet.lock({ publicKey });

      // Both should produce identical scripts
      expect(lockingScriptFromWallet.toHex()).toBe(lockingScriptFromPubKey.toHex());
    });
  });

  describe('parameter validation', () => {
    test('should reject when neither pubkeyhash nor wallet is provided', async () => {
      const p2pkh = new P2PKH();
      // @ts-ignore ignore for test
      await expect(p2pkh.lock({})).rejects.toThrow(
        'One of pubkeyhash, publicKey, or walletParams is required'
      );
    });
  });
});

describe('P2PKH unlocking and transaction verification', () => {
  test('should create a valid transaction with wallet-based signing', async () => {
    // Generate deterministic test key
    const userPriv = new PrivateKey(100);

    // Create wallet
    const userWallet = await makeWallet('test', storageURL, userPriv.toHex());

    const protocolID = [2, 'p2pkh'] as WalletProtocol;
    const keyID = '0';
    const counterparty = 'self' as WalletCounterparty;

    // Get the public key for locking
    const { publicKey: userLockingKey } = await userWallet.getPublicKey({
      protocolID,
      keyID,
      counterparty
    });

    // Step 1: Create source transaction with P2PKH locking script
    const sourceTransaction = new Transaction();
    sourceTransaction.addInput({
      sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    });

    // Create the P2PKH locking script
    const p2pkhLock = new P2PKH();
    const lockingScript = await p2pkhLock.lock({ publicKey: userLockingKey });

    sourceTransaction.addOutput({
      lockingScript,
      satoshis: 1000
    });

    // Add merkle proof (required for inputs)
    sourceTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
      sourceTransaction.id('hex'),
      1234
    );

    // Step 2: Create spending transaction
    const spendingTx = new Transaction();

    const p2pkhUnlock = new P2PKH(userWallet);
    spendingTx.addInput({
      sourceTransaction,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: p2pkhUnlock.unlock({
        protocolID,
        keyID,
        counterparty
      })
    });

    // Add output (send to same address)
    spendingTx.addOutput({
      lockingScript: await p2pkhLock.lock({ publicKey: userLockingKey }),
      satoshis: 900
    });

    // Step 3: Sign and verify the transaction
    await spendingTx.fee();
    await spendingTx.sign();

    const isValid = await spendingTx.verify('scripts only');

    expect(isValid).toBe(true);
  }, 30000);

  test('should handle multiple inputs with wallet signing', async () => {
    const userPriv = new PrivateKey(101);
    const userWallet = await makeWallet('test', storageURL, userPriv.toHex());

    const protocolID = [2, 'p2pkh'] as WalletProtocol;
    const keyID = '0';
    const counterparty = 'self' as WalletCounterparty;

    const { publicKey: userLockingKey } = await userWallet.getPublicKey({
      protocolID,
      keyID,
      counterparty
    });

    const p2pkhLock = new P2PKH();
    const lockingScript = await p2pkhLock.lock({ publicKey: userLockingKey });

    // Create two source transactions
    const sourceTx1 = new Transaction();
    sourceTx1.addInput({
      sourceTXID: '0000000000000000000000000000000000000000000000000000000000000001',
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    });
    sourceTx1.addOutput({ lockingScript, satoshis: 1000 });
    sourceTx1.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
      sourceTx1.id('hex'),
      1234
    );

    const sourceTx2 = new Transaction();
    sourceTx2.addInput({
      sourceTXID: '0000000000000000000000000000000000000000000000000000000000000002',
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    });
    sourceTx2.addOutput({ lockingScript, satoshis: 2000 });
    sourceTx2.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
      sourceTx2.id('hex'),
      1235
    );

    // Create spending transaction with multiple inputs
    const spendingTx = new Transaction();

    const p2pkhUnlock = new P2PKH(userWallet);
    spendingTx.addInput({
      sourceTransaction: sourceTx1,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: p2pkhUnlock.unlock({
        protocolID,
        keyID,
        counterparty
      })
    });

    spendingTx.addInput({
      sourceTransaction: sourceTx2,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: p2pkhUnlock.unlock({
        protocolID,
        keyID,
        counterparty
      })
    });

    spendingTx.addOutput({
      lockingScript: await p2pkhLock.lock({ publicKey: userLockingKey }),
      satoshis: 2900
    });

    await spendingTx.fee();
    await spendingTx.sign();

    const isValid = await spendingTx.verify('scripts only');

    expect(isValid).toBe(true);
  }, 30000);

  test('should support different signature scopes', async () => {
    const userPriv = new PrivateKey(102);
    const userWallet = await makeWallet('test', storageURL, userPriv.toHex());

    const protocolID = [2, 'p2pkh'] as WalletProtocol;
    const keyID = '0';
    const counterparty = 'self' as WalletCounterparty;

    const { publicKey: userLockingKey } = await userWallet.getPublicKey({
      protocolID,
      keyID,
      counterparty
    });

    const p2pkhLock = new P2PKH();
    const lockingScript = await p2pkhLock.lock({ publicKey: userLockingKey });

    const sourceTransaction = new Transaction();
    sourceTransaction.addInput({
      sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    });
    sourceTransaction.addOutput({ lockingScript, satoshis: 1000 });
    sourceTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
      sourceTransaction.id('hex'),
      1234
    );

    // Test with SIGHASH_SINGLE
    const spendingTx = new Transaction();
    const p2pkhUnlock = new P2PKH(userWallet);
    spendingTx.addInput({
      sourceTransaction,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: p2pkhUnlock.unlock({
        protocolID,
        keyID,
        counterparty,
        signOutputs: 'single',
        anyoneCanPay: false
      })
    });

    spendingTx.addOutput({
      lockingScript: await p2pkhLock.lock({ publicKey: userLockingKey }),
      satoshis: 900
    });

    await spendingTx.fee();
    await spendingTx.sign();

    const isValid = await spendingTx.verify('scripts only');

    expect(isValid).toBe(true);
  }, 30000);

  test('should correctly estimate unlocking script length', async () => {
    const userPriv = new PrivateKey(103);
    const userWallet = await makeWallet('test', storageURL, userPriv.toHex());

    const protocolID = [2, 'p2pkh'] as WalletProtocol;
    const keyID = '0';
    const counterparty = 'self' as WalletCounterparty;

    const p2pkh = new P2PKH(userWallet);
    const unlockTemplate = p2pkh.unlock({
      protocolID,
      keyID,
      counterparty
    });

    const estimatedLength = await unlockTemplate.estimateLength();

    // P2PKH unlocking script should be 108 bytes
    // (1 byte push + 73 bytes signature) + (1 byte push + 33 bytes compressed pubkey) = 108
    expect(estimatedLength).toBe(108);
  });
});
