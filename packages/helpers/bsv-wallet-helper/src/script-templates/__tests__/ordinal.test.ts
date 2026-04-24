import { describe, expect, test } from '@jest/globals';
import {
  PrivateKey,
  Transaction,
  Script,
  MerklePath,
  WalletProtocol,
  WalletCounterparty
} from '@bsv/sdk';
import OrdP2PKH, { Inscription, MAP } from '../ordinal';
import { makeWallet } from '../../utils/mockWallet';

// Test storage URL for wallet (can be any URL for testing)
const storageURL = 'https://store-us-1.bsvb.tech';

describe('OrdP2PKH locking script', () => {
  describe('lock with public key string', () => {
    test('should create a valid ordinal locking script from a public key hex string', async () => {
      const privateKey = new PrivateKey(1);
      const publicKey = privateKey.toPublicKey();
      const publicKeyHex = publicKey.toString();

      const ordP2pkh = new OrdP2PKH();
      const lockingScript = await ordP2pkh.lock({ publicKey: publicKeyHex });

      // Verify the script contains P2PKH structure
      const scriptAsm = lockingScript.toASM();
      expect(scriptAsm).toContain('OP_DUP');
      expect(scriptAsm).toContain('OP_HASH160');
      expect(scriptAsm).toContain('OP_EQUALVERIFY');
      expect(scriptAsm).toContain('OP_CHECKSIG');
    });

    test('should create a valid ordinal locking script with inscription', async () => {
      const privateKey = new PrivateKey(2);
      const publicKey = privateKey.toPublicKey();
      const publicKeyHex = publicKey.toString();

      const inscription: Inscription = {
        dataB64: Buffer.from('Hello, World!').toString('base64'),
        contentType: 'text/plain'
      };

      const ordP2pkh = new OrdP2PKH();
      const lockingScript = await ordP2pkh.lock({ publicKey: publicKeyHex, inscription });

      // Verify the script contains ordinal envelope
      const scriptAsm = lockingScript.toASM();
      expect(scriptAsm).toContain('OP_0');
      expect(scriptAsm).toContain('OP_IF');
      expect(scriptAsm).toContain('OP_ENDIF');
      // Verify it still has P2PKH
      expect(scriptAsm).toContain('OP_DUP');
      expect(scriptAsm).toContain('OP_CHECKSIG');
    });

    test('should create a valid ordinal locking script with MAP metadata', async () => {
      const privateKey = new PrivateKey(3);
      const publicKey = privateKey.toPublicKey();
      const publicKeyHex = publicKey.toString();

      const metaData: MAP = {
        app: 'testapp',
        type: 'profile',
        name: 'test-user'
      };

      const ordP2pkh = new OrdP2PKH();
      const lockingScript = await ordP2pkh.lock({ publicKey: publicKeyHex, metadata: metaData });

      // Verify the script contains MAP metadata
      const scriptAsm = lockingScript.toASM();
      expect(scriptAsm).toContain('OP_RETURN');
      // Verify it still has P2PKH
      expect(scriptAsm).toContain('OP_DUP');
      expect(scriptAsm).toContain('OP_CHECKSIG');
    });

    test('should create a valid ordinal locking script with both inscription and MAP metadata', async () => {
      const privateKey = new PrivateKey(4);
      const publicKey = privateKey.toPublicKey();
      const publicKeyHex = publicKey.toString();

      const inscription: Inscription = {
        dataB64: Buffer.from('Test image data').toString('base64'),
        contentType: 'image/png'
      };

      const metaData: MAP = {
        app: 'gallery',
        type: 'artwork',
        artist: 'satoshi'
      };

      const ordP2pkh = new OrdP2PKH();
      const lockingScript = await ordP2pkh.lock({ publicKey: publicKeyHex, inscription, metadata: metaData });

      // Verify the script contains all components
      const scriptAsm = lockingScript.toASM();
      expect(scriptAsm).toContain('OP_IF'); // Ordinal envelope
      expect(scriptAsm).toContain('OP_DUP'); // P2PKH
      expect(scriptAsm).toContain('OP_RETURN'); // MAP metadata
    });

    test('should reject MAP metadata without required fields', async () => {
      const privateKey = new PrivateKey(5);
      const publicKey = privateKey.toPublicKey();
      const publicKeyHex = publicKey.toString();

      const invalidMetaData = {
        app: 'testapp'
        // Missing 'type' field
      } as MAP;

      const ordP2pkh = new OrdP2PKH();
      await expect(ordP2pkh.lock({ publicKey: publicKeyHex, metadata: invalidMetaData }))
        .rejects.toThrow('metadata.type is required and must be a string');
    });
  });

  describe('lock with BRC-100 wallet', () => {
    test('should create a valid ordinal locking script using wallet', async () => {
      const privateKey = new PrivateKey(6);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const ordP2pkh = new OrdP2PKH(wallet);
      const lockingScript = await ordP2pkh.lock({
        walletParams: {
          protocolID: [2, 'p2pkh'] as WalletProtocol,
          keyID: '0',
          counterparty: 'self' as WalletCounterparty
        }
      });

      // Verify the script structure
      const scriptAsm = lockingScript.toASM();
      expect(scriptAsm).toContain('OP_DUP');
      expect(scriptAsm).toContain('OP_HASH160');
      expect(scriptAsm).toContain('OP_EQUALVERIFY');
      expect(scriptAsm).toContain('OP_CHECKSIG');
    });

    test('should create ordinal with inscription using wallet', async () => {
      const privateKey = new PrivateKey(7);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const inscription: Inscription = {
        dataB64: Buffer.from('Wallet inscription').toString('base64'),
        contentType: 'text/plain'
      };

      const ordP2pkh = new OrdP2PKH(wallet);
      const lockingScript = await ordP2pkh.lock({
        walletParams: {
          protocolID: [2, 'p2pkh'] as WalletProtocol,
          keyID: '0',
          counterparty: 'self' as WalletCounterparty
        },
        inscription
      });

      // Verify the script contains ordinal envelope and P2PKH
      const scriptAsm = lockingScript.toASM();
      expect(scriptAsm).toContain('OP_IF');
      expect(scriptAsm).toContain('OP_DUP');
    });

    test('should create the same locking script as direct public key', async () => {
      const privateKey = new PrivateKey(8);
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

      const ordP2pkhWithWallet = new OrdP2PKH(wallet);
      const ordP2pkhWithoutWallet = new OrdP2PKH();

      // Lock with wallet
      const lockingScriptFromWallet = await ordP2pkhWithWallet.lock({
        walletParams: {
          protocolID,
          keyID,
          counterparty
        }
      });

      // Lock with public key string
      const lockingScriptFromPubKey = await ordP2pkhWithoutWallet.lock({ publicKey });

      // Both should produce identical scripts
      expect(lockingScriptFromWallet.toHex()).toBe(lockingScriptFromPubKey.toHex());
    });
  });
});

describe('OrdP2PKH unlocking and transaction verification', () => {
  test('should create a valid transaction with ordinal inscription', async () => {
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

    // Step 1: Create source transaction with ordinal inscription
    const sourceTransaction = new Transaction();
    sourceTransaction.addInput({
      sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    });

    // Create ordinal with inscription
    const inscription: Inscription = {
      dataB64: Buffer.from('Test NFT').toString('base64'),
      contentType: 'text/plain'
    };

    const metaData: MAP = {
      app: 'nft-app',
      type: 'collectible',
      id: '001'
    };

    const ordP2pkhLock = new OrdP2PKH();
    const lockingScript = await ordP2pkhLock.lock({ publicKey: userLockingKey, inscription, metadata: metaData });

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

    const ordP2pkhUnlock = new OrdP2PKH(userWallet);
    spendingTx.addInput({
      sourceTransaction,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: ordP2pkhUnlock.unlock({
        protocolID,
        keyID,
        counterparty
      })
    });

    // Add output (send to same address)
    spendingTx.addOutput({
      lockingScript: await ordP2pkhLock.lock({ publicKey: userLockingKey }),
      satoshis: 900
    });

    // Step 3: Sign and verify the transaction
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

    const ordP2pkh = new OrdP2PKH(userWallet);
    const unlockTemplate = ordP2pkh.unlock({
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
