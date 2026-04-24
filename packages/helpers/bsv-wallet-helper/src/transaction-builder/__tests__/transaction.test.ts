import { describe, expect, test, jest } from '@jest/globals';
import {
  PrivateKey,
  PublicKey,
  WalletInterface,
  LockingScript,
  WalletProtocol,
  WalletCounterparty,
  Transaction,
  CreateActionResult,
  Script,
  MerklePath,
} from '@bsv/sdk';
import { TransactionBuilder, isHexPublicKey } from '../transaction';
import P2PKH from '../../script-templates/p2pkh';
import OrdP2PKH from '../../script-templates/ordinal';

// Test storage URL for test wallets
const storageURL = "https://store-us-1.bsvb.tech";

const makeWallet = async (
  _chain: 'test' | 'main',
  _storageURL: string,
  privateKeyHex: string
): Promise<WalletInterface> => {
  const privateKey = new PrivateKey(privateKeyHex, 'hex')

  return {
    // Most tests overwrite createAction with their own jest mocks.
    createAction: jest.fn(),
    signAction: jest.fn(),
    getPublicKey: async () => ({
      publicKey: privateKey.toPublicKey().toString()
    })
  } as unknown as WalletInterface
}

describe('TransactionTemplate', () => {
  describe('constructor and basic validation', () => {
    test('should create a TransactionTemplate with wallet', async () => {
      const privateKey = new PrivateKey(1);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const template = new TransactionBuilder(wallet);
      expect(template).toBeDefined();

      // Verify internal state is initialized correctly
      expect((template as any).wallet).toBe(wallet);
      expect((template as any)._transactionDescription).toBeUndefined();
      expect((template as any).outputs).toEqual([]);
      expect((template as any).inputs).toEqual([]);
      expect((template as any).transactionOptions).toEqual({});
    });

    test('should create a TransactionTemplate with wallet and description', async () => {
      const privateKey = new PrivateKey(2);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const template = new TransactionBuilder(wallet, "My transaction");
      expect(template).toBeDefined();

      // Verify internal state is initialized with custom description
      expect((template as any).wallet).toBe(wallet);
      expect((template as any)._transactionDescription).toBe("My transaction");
      expect((template as any).outputs).toEqual([]);
      expect((template as any).inputs).toEqual([]);
    });

    test('should throw error when wallet is not provided', () => {
      // @ts-ignore - intentionally testing invalid input
      expect(() => new TransactionBuilder(null)).toThrow('Wallet is required for TransactionBuilder');
    });
  });

  describe('addP2PKHOutput', () => {
    test('should add a P2PKH output with public key string', async () => {
      const privateKey = new PrivateKey(3);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const template = new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1000, description: "Test output" });

      expect(template).toBeDefined();

      // Verify internal configuration
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('p2pkh');
      expect(outputs[0].satoshis).toBe(1000);
      expect(outputs[0].description).toBe("Test output");
      expect(outputs[0].addressOrParams).toBe(publicKey);
    });

    test('should add a P2PKH output with address string', async () => {
      const privateKey = new PrivateKey(9);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const address = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'

      const template = new TransactionBuilder(wallet)
        .addP2PKHOutput({ address, satoshis: 1000, description: 'Test output' })

      expect(template).toBeDefined();

      // Verify internal configuration
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('p2pkh');
      expect(outputs[0].satoshis).toBe(1000);
      expect(outputs[0].description).toBe('Test output');
      expect(outputs[0].addressOrParams).toBe(address);
    })

    test('should add a P2PKH output with wallet derivation params', async () => {
      const privateKey = new PrivateKey(4);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const walletParams = {
        protocolID: [2, 'p2pkh'] as WalletProtocol,
        keyID: '0',
        counterparty: 'self' as WalletCounterparty,
      };

      const template = new TransactionBuilder(wallet)
        .addP2PKHOutput({ walletParams, satoshis: 1000, description: "Test output" });

      expect(template).toBeDefined();

      // Verify internal configuration
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('p2pkh');
      expect(outputs[0].satoshis).toBe(1000);
      expect(outputs[0].description).toBe("Test output");
      expect(outputs[0].addressOrParams).toEqual(walletParams);
    });

    test('should allow auto-derivation (uses BRC-29 derivation)', async () => {
      const privateKey = new PrivateKey(5);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      // Should not throw - will use BRC-29 derivation
      expect(() => {
        new TransactionBuilder(wallet).addP2PKHOutput({ satoshis: 1000 });
      }).not.toThrow();
    });

    test('should throw error when satoshis is negative', async () => {
      const privateKey = new PrivateKey(6);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      expect(() => {
        new TransactionBuilder(wallet).addP2PKHOutput({ publicKey, satoshis: -100 });
      }).toThrow('satoshis must be a non-negative number');
    });

    test('should throw error when description is not a string', async () => {
      const privateKey = new PrivateKey(7);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).addP2PKHOutput({ publicKey, satoshis: 1000, description: 123 });
      }).toThrow('description must be a string');
    });
  });

  describe('addOrdinalP2PKHOutput', () => {
    test('should add an ordinalP2PKH output with public key string', async () => {
      const privateKey = new PrivateKey(30)
      const wallet = await makeWallet('test', storageURL, privateKey.toHex())
      const publicKey = privateKey.toPublicKey().toString()

      const template = new TransactionBuilder(wallet)
        .addOrdinalP2PKHOutput({ publicKey, satoshis: 1, description: 'Ordinal output' })

      expect(template).toBeDefined()

      // Verify internal configuration
      const outputs = (template as any).parent.outputs
      expect(outputs).toHaveLength(1)
      expect(outputs[0].type).toBe('ordinalP2PKH')
      expect(outputs[0].satoshis).toBe(1)
      expect(outputs[0].description).toBe('Ordinal output')
      expect(outputs[0].addressOrParams).toBe(publicKey)
    })

    test('should add an ordinalP2PKH output with address string', async () => {
      const privateKey = new PrivateKey(31)
      const wallet = await makeWallet('test', storageURL, privateKey.toHex())

      const address = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'

      const template = new TransactionBuilder(wallet)
        .addOrdinalP2PKHOutput({ address, satoshis: 1, description: 'Ordinal output' })

      expect(template).toBeDefined()

      // Verify internal configuration
      const outputs = (template as any).parent.outputs
      expect(outputs).toHaveLength(1)
      expect(outputs[0].type).toBe('ordinalP2PKH')
      expect(outputs[0].satoshis).toBe(1)
      expect(outputs[0].description).toBe('Ordinal output')
      expect(outputs[0].addressOrParams).toBe(address)
    })
  })

  describe('isHexPublicKey', () => {
    test('should detect compressed/uncompressed hex public keys and reject non-hex', () => {
      const privateKey = new PrivateKey(32)
      const publicKey = privateKey.toPublicKey()

      const compressed = publicKey.toString()
      const uncompressed = Buffer.from(publicKey.encode(false) as number[]).toString('hex')
      const address = publicKey.toAddress().toString()

      expect(isHexPublicKey(compressed)).toBe(true)
      expect(isHexPublicKey(uncompressed)).toBe(true)
      expect(isHexPublicKey(address)).toBe(false)

      expect(isHexPublicKey('zz')).toBe(false)
      expect(isHexPublicKey('11'.repeat(32))).toBe(false)
    })
  })

  describe('pay', () => {
    test('should pay to a publicKey with a minimal P2PKH output', async () => {
      const privateKey = new PrivateKey(40)
      const wallet = await makeWallet('test', storageURL, privateKey.toHex())
      const publicKey = privateKey.toPublicKey().toString()

      const mockTxid = '0000000000000000000000000000000000000000000000000000000000000040'
      const mockTx = { id: () => mockTxid }

      // @ts-ignore
      wallet.createAction = jest.fn().mockResolvedValue({ txid: mockTxid, tx: mockTx })
      // @ts-ignore
      wallet.signAction = jest.fn()

      const res = await new TransactionBuilder(wallet).pay(publicKey, 1234)

      expect(wallet.createAction).toHaveBeenCalledTimes(1)
      // @ts-ignore
      const args = (wallet.createAction as any).mock.calls[0][0]
      expect(args.outputs).toHaveLength(1)
      expect(args.outputs[0].satoshis).toBe(1234)
      expect(args.outputs[0].outputDescription).toBe('Transaction output')

      expect(wallet.signAction).not.toHaveBeenCalled()
      expect(res.txid).toBe(mockTxid)
      expect(res.tx).toBe(mockTx)
    })

    test('should pay to an address with a minimal P2PKH output', async () => {
      const privateKey = new PrivateKey(41)
      const wallet = await makeWallet('test', storageURL, privateKey.toHex())
      const address = privateKey.toPublicKey().toAddress().toString()

      const mockTxid = '0000000000000000000000000000000000000000000000000000000000000041'
      const mockTx = { id: () => mockTxid }

      // @ts-ignore
      wallet.createAction = jest.fn().mockResolvedValue({ txid: mockTxid, tx: mockTx })
      // @ts-ignore
      wallet.signAction = jest.fn()

      const res = await new TransactionBuilder(wallet).pay(address, 500)

      expect(wallet.createAction).toHaveBeenCalledTimes(1)
      // @ts-ignore
      const args = (wallet.createAction as any).mock.calls[0][0]
      expect(args.outputs).toHaveLength(1)
      expect(args.outputs[0].satoshis).toBe(500)
      expect(args.outputs[0].outputDescription).toBe('Transaction output')

      expect(wallet.signAction).not.toHaveBeenCalled()
      expect(res.txid).toBe(mockTxid)
      expect(res.tx).toBe(mockTx)
    })
  })

  describe('addCustomOutput', () => {
    test('should add a custom output with locking script', async () => {
      const privateKey = new PrivateKey(8);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const lockingScript = LockingScript.fromASM('OP_TRUE');

      const template = new TransactionBuilder(wallet)
        .addCustomOutput({ lockingScript, satoshis: 1000, description: "Custom output" });

      expect(template).toBeDefined();

      // Verify internal configuration
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('custom');
      expect(outputs[0].satoshis).toBe(1000);
      expect(outputs[0].description).toBe("Custom output");
      expect(outputs[0].lockingScript).toBe(lockingScript);
    });

    test('should throw error when locking script is invalid', async () => {
      const privateKey = new PrivateKey(9);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).addCustomOutput({ lockingScript: null, satoshis: 1000 });
      }).toThrow('lockingScript must be a LockingScript instance');
    });
  });

  describe('addOpReturn', () => {
    test('should add OP_RETURN to a specific output', async () => {
      const privateKey = new PrivateKey(10);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const template = new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1, description: "Test output" })
          .addOpReturn(['hello world']);

      expect(template).toBeDefined();

      // Verify internal configuration
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].opReturnFields).toEqual(['hello world']);
    });

    test('should throw error when fields is empty', async () => {
      const privateKey = new PrivateKey(11);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      expect(() => {
        new TransactionBuilder(wallet)
          .addP2PKHOutput({ publicKey, satoshis: 1, description: "Test output" })
            .addOpReturn([]);
      }).toThrow('addOpReturn requires a non-empty array of fields');
    });

    test('should throw error when fields is not an array', async () => {
      const privateKey = new PrivateKey(12);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      expect(() => {
        new TransactionBuilder(wallet)
          .addP2PKHOutput({ publicKey, satoshis: 1, description: "Test output" })
            // @ts-ignore - intentionally testing invalid input
            .addOpReturn('hello');
      }).toThrow('addOpReturn requires a non-empty array of fields');
    });
  });

  describe('chaining and multiple outputs', () => {
    test('should support adding multiple P2PKH outputs', async () => {
      const privateKey = new PrivateKey(13);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const template = new TransactionBuilder(wallet, "Multi-output transaction")
        .addP2PKHOutput({ publicKey, satoshis: 1000, description: "First output" })
        .addP2PKHOutput({ publicKey, satoshis: 2000, description: "Second output" })
        .addP2PKHOutput({ publicKey, satoshis: 3000, description: "Third output" });

      expect(template).toBeDefined();

      // Verify each output is configured independently
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(3);
      expect(outputs[0].satoshis).toBe(1000);
      expect(outputs[0].description).toBe("First output");
      expect(outputs[1].satoshis).toBe(2000);
      expect(outputs[1].description).toBe("Second output");
      expect(outputs[2].satoshis).toBe(3000);
      expect(outputs[2].description).toBe("Third output");
    });

    test('should support chaining from OutputBuilder back to TransactionTemplate', async () => {
      const privateKey = new PrivateKey(14);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const template = new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1000, description: "First output" })
          .addOpReturn(['metadata1'])
        .addP2PKHOutput({ publicKey, satoshis: 2000, description: "Second output" })
          .addOpReturn(['metadata2']);

      expect(template).toBeDefined();

      // Verify OP_RETURN is applied to correct outputs only
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(2);
      expect(outputs[0].opReturnFields).toEqual(['metadata1']);
      expect(outputs[0].description).toBe("First output");
      expect(outputs[1].opReturnFields).toEqual(['metadata2']);
      expect(outputs[1].description).toBe("Second output");
    });

    test('should support mixing P2PKH and custom outputs', async () => {
      const privateKey = new PrivateKey(15);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();
      const lockingScript = LockingScript.fromASM('OP_TRUE');

      const template = new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1000, description: "P2PKH output" })
        .addCustomOutput({ lockingScript, satoshis: 500, description: "Custom output" })
        .addP2PKHOutput({ publicKey, satoshis: 2000, description: "Another P2PKH" });

      expect(template).toBeDefined();

      // Verify each output type is configured correctly
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(3);
      expect(outputs[0].type).toBe('p2pkh');
      expect(outputs[0].satoshis).toBe(1000);
      expect(outputs[0].description).toBe("P2PKH output");
      expect(outputs[1].type).toBe('custom');
      expect(outputs[1].satoshis).toBe(500);
      expect(outputs[1].description).toBe("Custom output");
      expect(outputs[1].lockingScript).toBe(lockingScript);
      expect(outputs[2].type).toBe('p2pkh');
      expect(outputs[2].satoshis).toBe(2000);
      expect(outputs[2].description).toBe("Another P2PKH");
    });
  });

  describe('options', () => {
    test('should set transaction description', async () => {
      const privateKey = new PrivateKey(16);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const template = new TransactionBuilder(wallet)
        .transactionDescription("My custom description");

      expect(template).toBeDefined();

      // Verify transaction description is set
      expect((template as any)._transactionDescription).toBe("My custom description");
    });

    test('should throw error when description is not a string', async () => {
      const privateKey = new PrivateKey(17);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).transactionDescription(123);
      }).toThrow('Description must be a string');
    });

    test('should set options', async () => {
      const privateKey = new PrivateKey(18);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const template = new TransactionBuilder(wallet)
        .options({ randomizeOutputs: false });

      expect(template).toBeDefined();

      // Verify options are set correctly
      expect((template as any).transactionOptions.randomizeOutputs).toBe(false);
    });

    test('should throw error when options is not an object', async () => {
      const privateKey = new PrivateKey(19);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options('false');
      }).toThrow('Options must be an object');
    });

    test('should accept all CreateActionOptions', async () => {
      const privateKey = new PrivateKey(20);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      // Should accept various CreateActionOptions without throwing
      const template = new TransactionBuilder(wallet)
        .options({ randomizeOutputs: true })
        .options({ trustSelf: 'known' })
        .options({ signAndProcess: true })
        .options({ acceptDelayedBroadcast: false })
        .options({ returnTXIDOnly: true })
        .options({ noSend: false })
        .options({ knownTxids: ['abc123', 'def456'] })
        .options({ noSendChange: ['txid.0', 'txid.1'] })
        .options({ sendWith: ['xyz789'] });

      expect(template).toBeDefined();
    });

    test('should throw error when boolean options are not booleans', async () => {
      const privateKey = new PrivateKey(21);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ signAndProcess: 'true' });
      }).toThrow('signAndProcess must be a boolean');

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ acceptDelayedBroadcast: 1 });
      }).toThrow('acceptDelayedBroadcast must be a boolean');

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ returnTXIDOnly: 'yes' });
      }).toThrow('returnTXIDOnly must be a boolean');

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ noSend: null });
      }).toThrow('noSend must be a boolean');

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ randomizeOutputs: 'false' });
      }).toThrow('randomizeOutputs must be a boolean');
    });

    test('should throw error when trustSelf is invalid', async () => {
      const privateKey = new PrivateKey(22);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ trustSelf: 'invalid' });
      }).toThrow('trustSelf must be either "known" or "all"');

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ trustSelf: true });
      }).toThrow('trustSelf must be either "known" or "all"');
    });

    test('should throw error when array options are invalid', async () => {
      const privateKey = new PrivateKey(23);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ knownTxids: 'not-an-array' });
      }).toThrow('knownTxids must be an array');

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ knownTxids: [123, 456] });
      }).toThrow('knownTxids[0] must be a string (hex txid)');

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ noSendChange: 'not-an-array' });
      }).toThrow('noSendChange must be an array');

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ noSendChange: [123] });
      }).toThrow('noSendChange[0] must be a string (outpoint format)');

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ sendWith: {} });
      }).toThrow('sendWith must be an array');

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).options({ sendWith: [null] });
      }).toThrow('sendWith[0] must be a string (hex txid)');
    });
  });

  describe('build method', () => {
    test('should throw error when no outputs are configured', async () => {
      const privateKey = new PrivateKey(24);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const template = new TransactionBuilder(wallet, "Empty transaction");

      await expect(template.build()).rejects.toThrow(
        'At least one output is required to build a transaction'
      );
    });

    test('should call wallet.createAction with correct parameters', async () => {
      const privateKey = new PrivateKey(25);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      // Mock the createAction method
      // @ts-ignore
      const mockCreateAction: any = jest.fn().mockResolvedValue({
        txid: '0000000000000000000000000000000000000000000000000000000000000001',
        tx: { id: () => '0000000000000000000000000000000000000000000000000000000000000001' },
      });
      wallet.createAction = mockCreateAction;

      const result = await new TransactionBuilder(wallet, "Test transaction")
        .addP2PKHOutput({ publicKey, satoshis: 1000, description: "Test output" })
        .build();

      expect(mockCreateAction).toHaveBeenCalledTimes(1);
      expect(mockCreateAction).toHaveBeenCalledWith({
        description: "Test transaction",
        outputs: expect.arrayContaining([
          expect.objectContaining({
            lockingScript: expect.any(String),
            satoshis: 1000,
            outputDescription: "Test output",
          }),
        ]),
        options: {},
      });
      expect(result.txid).toBe('0000000000000000000000000000000000000000000000000000000000000001');
    });

    test('should return txid and tx from wallet.createAction', async () => {
      const privateKey = new PrivateKey(26);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const mockTxid = '0000000000000000000000000000000000000000000000000000000000000002';
      const mockTx = { id: () => mockTxid };

      // @ts-ignore
      wallet.createAction = jest.fn().mockResolvedValue({
        txid: mockTxid,
        tx: mockTx,
      });

      const outputBuilder = new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 500 });

      // Verify internal configuration before build (access via .parent)
      const outputs = (outputBuilder as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('p2pkh');
      expect(outputs[0].satoshis).toBe(500);
      expect(outputs[0].addressOrParams).toBe(publicKey);

      const result = await outputBuilder.build();

      expect(result.txid).toBe(mockTxid);
      expect(result.tx).toBe(mockTx);
    });

    test('should include randomizeOutputs option when set', async () => {
      const privateKey = new PrivateKey(27);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      // @ts-ignore
      const mockCreateAction: any = jest.fn().mockResolvedValue({
        txid: '0000000000000000000000000000000000000000000000000000000000000003',
        tx: { id: () => '0000000000000000000000000000000000000000000000000000000000000003' },
      });
      wallet.createAction = mockCreateAction;

      await new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1000 })
        .options({ randomizeOutputs: false })
        .build();

      expect(mockCreateAction).toHaveBeenCalledWith({
        description: "Transaction",
        outputs: expect.any(Array),
        options: { randomizeOutputs: false },
      });
    });

    test('should handle multiple outputs with mixed configurations', async () => {
      const privateKey = new PrivateKey(28);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      // @ts-ignore
      const mockCreateAction: any = jest.fn().mockResolvedValue({
        txid: '0000000000000000000000000000000000000000000000000000000000000004',
        tx: { id: () => '0000000000000000000000000000000000000000000000000000000000000004' },
      });
      wallet.createAction = mockCreateAction;

      const metadata = { key: "value" };

      await new TransactionBuilder(wallet, "Complex transaction")
        .addP2PKHOutput({ publicKey, satoshis: 1000, description: "First output" })
          .addOpReturn([JSON.stringify(metadata)])
        .addP2PKHOutput({ publicKey, satoshis: 2000, description: "Second output" })
        .options({ randomizeOutputs: false })
        .build();

      expect(mockCreateAction).toHaveBeenCalledWith({
        description: "Complex transaction",
        outputs: expect.arrayContaining([
          expect.objectContaining({
            lockingScript: expect.any(String),
            satoshis: 1000,
            outputDescription: "First output",
          }),
          expect.objectContaining({
            lockingScript: expect.any(String),
            satoshis: 2000,
            outputDescription: "Second output",
          }),
        ]),
        options: { randomizeOutputs: false },
      });
    });

    test('should correctly apply OP_RETURN only to specified output', async () => {
      const privateKey = new PrivateKey(29);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      // @ts-ignore
      const mockCreateAction: any = jest.fn().mockResolvedValue({
        txid: '0000000000000000000000000000000000000000000000000000000000000005',
        tx: { id: () => '0000000000000000000000000000000000000000000000000000000000000005' },
      });
      wallet.createAction = mockCreateAction;

      await new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1000, description: "Without OP_RETURN" })
        .addP2PKHOutput({ publicKey, satoshis: 1, description: "With OP_RETURN" })
          .addOpReturn(['metadata'])
        .build();

      const call: any = mockCreateAction.mock.calls[0][0];
      const outputs = call.outputs;

      // First output should NOT contain OP_RETURN
      expect(outputs[0].lockingScript).not.toContain('OP_RETURN');

      // Second output SHOULD contain OP_RETURN
      expect(outputs[1].lockingScript).toContain('6a'); // 6a is OP_RETURN opcode in hex
    });

    test('should use default description when none provided', async () => {
      const privateKey = new PrivateKey(30);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      // @ts-ignore
      const mockCreateAction: any = jest.fn().mockResolvedValue({
        txid: '0000000000000000000000000000000000000000000000000000000000000006',
        tx: { id: () => '0000000000000000000000000000000000000000000000000000000000000006' },
      });
      wallet.createAction = mockCreateAction;

      await new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1000 })
        .build();

      expect(mockCreateAction).toHaveBeenCalledWith({
        description: "Transaction",
        outputs: expect.any(Array),
        options: {},
      });
    });
  });

  describe('integration tests', () => {
    test('should match the simplified API from the example', async () => {
      const privateKey = new PrivateKey(100);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const metadata = { timestamp: Date.now(), action: "test" };

      // @ts-ignore
      const mockCreateAction: any = jest.fn().mockResolvedValue({
        txid: '1111111111111111111111111111111111111111111111111111111111111111',
        tx: { id: () => '1111111111111111111111111111111111111111111111111111111111111111' },
      });
      wallet.createAction = mockCreateAction;

      // This should match the simplified API from the user's example
      const template = new TransactionBuilder(wallet, "P2PKH with metadata")
        .addP2PKHOutput({ publicKey, satoshis: 1, description: "Testing P2PKH" })
          .addOpReturn([JSON.stringify(metadata)]);

      // Verify internal configuration before build
      expect((template as any).parent._transactionDescription).toBe("P2PKH with metadata");
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('p2pkh');
      expect(outputs[0].satoshis).toBe(1);
      expect(outputs[0].description).toBe("Testing P2PKH");
      expect(outputs[0].opReturnFields).toEqual([JSON.stringify(metadata)]);

      const result = await template.build();

      expect(result.txid).toBeDefined();
      expect(result.tx).toBeDefined();
      expect(mockCreateAction).toHaveBeenCalledTimes(1);
    });

    test('should work with wallet derivation parameters', async () => {
      const privateKey = new PrivateKey(101);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      // @ts-ignore
      const mockCreateAction: any = jest.fn().mockResolvedValue({
        txid: '2222222222222222222222222222222222222222222222222222222222222222',
        tx: { id: () => '2222222222222222222222222222222222222222222222222222222222222222' },
      });
      wallet.createAction = mockCreateAction;

      const params = {
        protocolID: [2, 'p2pkh'] as WalletProtocol,
        keyID: '0',
        counterparty: 'self' as WalletCounterparty,
      };

      const outputBuilder = new TransactionBuilder(wallet, "Wallet derivation test")
        .addP2PKHOutput({ walletParams: params, satoshis: 5000, description: "Derived output" });

      // Verify internal configuration before build (access via .parent)
      expect((outputBuilder as any).parent._transactionDescription).toBe("Wallet derivation test");
      const outputs = (outputBuilder as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('p2pkh');
      expect(outputs[0].satoshis).toBe(5000);
      expect(outputs[0].description).toBe("Derived output");
      expect(outputs[0].addressOrParams).toEqual(params);

      const result = await outputBuilder.build();

      expect(result.txid).toBeDefined();
      expect(result.tx).toBeDefined();
    });
  });

  describe('preview mode', () => {
    test('should return createAction args without executing when preview=true', async () => {
      const privateKey = new PrivateKey(110);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const template = new TransactionBuilder(wallet, "Preview test")
        .addP2PKHOutput({ publicKey, satoshis: 1000, description: "Test output" });

      const preview = await template.build({ preview: true }) as any;

      // Should return the createAction arguments object
      expect(preview).toBeDefined();
      expect(preview.description).toBe("Preview test");
      expect(preview.outputs).toBeDefined();
      expect(preview.outputs).toHaveLength(1);
      expect(preview.outputs[0].satoshis).toBe(1000);
      expect(preview.outputs[0].outputDescription).toBe("Test output");
      expect(preview.outputs[0].lockingScript).toBeDefined();
      expect(preview.options).toBeDefined();

      // Should NOT have txid or tx (not executed)
      expect(preview.txid).toBeUndefined();
      expect(preview.tx).toBeUndefined();
    });

    test('should include options in preview', async () => {
      const privateKey = new PrivateKey(111);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const preview = await new TransactionBuilder(wallet, "Preview with options")
        .addP2PKHOutput({ publicKey, satoshis: 500, description: "Output" })
        .options({ randomizeOutputs: false, trustSelf: 'known' })
        .build({ preview: true }) as any;

      expect(preview.description).toBe("Preview with options");
      expect(preview.options.randomizeOutputs).toBe(false);
      expect(preview.options.trustSelf).toBe('known');
    });

    test('should include OP_RETURN in preview', async () => {
      const privateKey = new PrivateKey(112);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const metadata = { action: "test", timestamp: Date.now() };

      const preview = await new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1, description: "With metadata" })
          .addOpReturn([JSON.stringify(metadata)])
        .build({ preview: true }) as any;

      expect(preview.outputs).toHaveLength(1);
      expect(preview.outputs[0].lockingScript).toContain('6a'); // OP_RETURN opcode
    });

    test('should handle multiple outputs in preview', async () => {
      const privateKey = new PrivateKey(113);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const preview = await new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1000, description: "First" })
        .addP2PKHOutput({ publicKey, satoshis: 2000, description: "Second" })
        .addP2PKHOutput({ publicKey, satoshis: 3000, description: "Third" })
        .build({ preview: true }) as any;

      expect(preview.outputs).toHaveLength(3);
      expect(preview.outputs[0].satoshis).toBe(1000);
      expect(preview.outputs[0].outputDescription).toBe("First");
      expect(preview.outputs[1].satoshis).toBe(2000);
      expect(preview.outputs[1].outputDescription).toBe("Second");
      expect(preview.outputs[2].satoshis).toBe(3000);
      expect(preview.outputs[2].outputDescription).toBe("Third");
    });

    test('should execute normally when preview=false', async () => {
      const privateKey = new PrivateKey(114);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const mockTxid = '3333333333333333333333333333333333333333333333333333333333333333';
      const mockTx = { id: () => mockTxid };

      // @ts-ignore
      wallet.createAction = jest.fn().mockResolvedValue({
        txid: mockTxid,
        tx: mockTx,
      });

      const result = await new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1000 })
        .build({ preview: false });

      // Should execute normally and return txid/tx
      expect(result.txid).toBe(mockTxid);
      expect(result.tx).toBe(mockTx);
      expect(wallet.createAction).toHaveBeenCalledTimes(1);
    });

    test('should execute normally when preview parameter is omitted', async () => {
      const privateKey = new PrivateKey(115);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const mockTxid = '4444444444444444444444444444444444444444444444444444444444444444';
      const mockTx = { id: () => mockTxid };

      // @ts-ignore
      wallet.createAction = jest.fn().mockResolvedValue({
        txid: mockTxid,
        tx: mockTx,
      });

      const result = await new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1000 })
        .build(); // No parameter = default false

      // Should execute normally (backward compatible)
      expect(result.txid).toBe(mockTxid);
      expect(result.tx).toBe(mockTx);
      expect(wallet.createAction).toHaveBeenCalledTimes(1);
    });
  });

  // Note: Tests with inputs are currently skipped because trustSelf option
  // doesn't work with mock wallets/transactions. These tests validate the API
  // but cannot execute with mock data that doesn't exist on-chain.
  describe('addChangeOutput', () => {
    test('should add a change output with public key string', async () => {
      const privateKey = new PrivateKey(150);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const template = new TransactionBuilder(wallet)
        .addChangeOutput({ publicKey, description: "Change output" });

      expect(template).toBeDefined();

      // Verify internal configuration
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('change');
      expect(outputs[0].description).toBe("Change output");
      expect(outputs[0].addressOrParams).toBe(publicKey);
      expect(outputs[0].satoshis).toBeUndefined(); // Calculated during signing
    });

    test('should add a change output with wallet derivation params', async () => {
      const privateKey = new PrivateKey(151);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const params = {
        protocolID: [2, 'p2pkh'] as WalletProtocol,
        keyID: '0',
        counterparty: 'self' as WalletCounterparty,
      };

      const template = new TransactionBuilder(wallet)
        .addChangeOutput({ walletParams: params, description: "Change output" });

      expect(template).toBeDefined();

      // Verify internal configuration
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('change');
      expect(outputs[0].description).toBe("Change output");
      expect(outputs[0].addressOrParams).toEqual(params);
      expect(outputs[0].satoshis).toBeUndefined();
    });

    test('should use default description when none provided', async () => {
      const privateKey = new PrivateKey(152);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const template = new TransactionBuilder(wallet)
        .addChangeOutput({ publicKey });

      expect(template).toBeDefined();

      // Verify internal configuration
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('change');
      expect(outputs[0].description).toBe("Change");
    });

    test('should allow undefined addressOrParams (uses BRC-29 derivation)', async () => {
      const privateKey = new PrivateKey(153);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      // Should not throw - will use BRC-29 derivation
      expect(() => {
        new TransactionBuilder(wallet).addChangeOutput({});
      }).not.toThrow();
    });

    test('should throw error when description is not a string', async () => {
      const privateKey = new PrivateKey(154);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      expect(() => {
        // @ts-ignore - intentionally testing invalid input
        new TransactionBuilder(wallet).addChangeOutput({ publicKey, description: 123 });
      }).toThrow('description must be a string');
    });

    test('should add OP_RETURN to change output', async () => {
      const privateKey = new PrivateKey(155);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const template = new TransactionBuilder(wallet)
        .addChangeOutput({ publicKey, description: "Change with metadata" })
          .addOpReturn(['change', 'metadata']);

      expect(template).toBeDefined();

      // Verify OP_RETURN is added to change output
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('change');
      expect(outputs[0].opReturnFields).toEqual(['change', 'metadata']);
    });

    test('should throw error when change output has no inputs', async () => {
      const privateKey = new PrivateKey(156);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const template = new TransactionBuilder(wallet, "Change without inputs")
        .addChangeOutput({ publicKey });

      await expect(template.build()).rejects.toThrow(
        'Change outputs require at least one input'
      );
    });

    test('should support multiple change outputs', async () => {
      const privateKey = new PrivateKey(157);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const template = new TransactionBuilder(wallet)
        .addChangeOutput({ publicKey, description: "First change" })
        .addChangeOutput({ publicKey, description: "Second change" });

      expect(template).toBeDefined();

      // Verify each change output is configured independently
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(2);
      expect(outputs[0].type).toBe('change');
      expect(outputs[0].description).toBe("First change");
      expect(outputs[1].type).toBe('change');
      expect(outputs[1].description).toBe("Second change");
    });

    test('should support mixing regular and change outputs', async () => {
      const privateKey = new PrivateKey(158);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());
      const publicKey = privateKey.toPublicKey().toString();

      const template = new TransactionBuilder(wallet)
        .addP2PKHOutput({ publicKey, satoshis: 1000, description: "Regular output" })
        .addChangeOutput({ publicKey, description: "Change output" })
        .addP2PKHOutput({ publicKey, satoshis: 2000, description: "Another regular" });

      expect(template).toBeDefined();

      // Verify each output type is configured correctly
      const outputs = (template as any).parent.outputs;
      expect(outputs).toHaveLength(3);
      expect(outputs[0].type).toBe('p2pkh');
      expect(outputs[0].satoshis).toBe(1000);
      expect(outputs[1].type).toBe('change');
      expect(outputs[1].satoshis).toBeUndefined();
      expect(outputs[2].type).toBe('p2pkh');
      expect(outputs[2].satoshis).toBe(2000);
    });
  });

  describe.skip('transactions with inputs', () => {
    test('should create a transaction with P2PKH input and output', async () => {
      const privateKey = new PrivateKey(200);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const protocolID = [2, 'p2pkh'] as WalletProtocol;
      const keyID = '0';
      const counterparty = 'self' as WalletCounterparty;

      const { publicKey } = await wallet.getPublicKey({
        protocolID,
        keyID,
        counterparty
      });

      // Create source transaction
      const p2pkhLock = new P2PKH();
      const lockingScript = await p2pkhLock.lock({ publicKey });

      const sourceTransaction = new Transaction();
      sourceTransaction.addInput({
        sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });
      sourceTransaction.addOutput({
        lockingScript,
        satoshis: 2000
      });
      sourceTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        sourceTransaction.id('hex'),
        1234
      );

      // Create spending transaction using TransactionTemplate
      const result = await new TransactionBuilder(wallet, "Spending P2PKH")
        .addP2PKHInput({
          sourceTransaction,
          sourceOutputIndex: 0,
          walletParams: { protocolID, keyID, counterparty },
          description: "Input from previous tx"
        })
        .addP2PKHOutput({ publicKey, satoshis: 1900, description: "Change output" })
        .options({ trustSelf: 'known' })
        .build();

      expect(result.txid).toBeDefined();
      expect(result.tx).toBeDefined();
    }, 30000);

    test('should create a transaction with multiple P2PKH inputs', async () => {
      const privateKey = new PrivateKey(201);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const protocolID = [2, 'p2pkh'] as WalletProtocol;
      const keyID = '0';
      const counterparty = 'self' as WalletCounterparty;

      const { publicKey } = await wallet.getPublicKey({
        protocolID,
        keyID,
        counterparty
      });

      // Create two source transactions
      const p2pkhLock = new P2PKH();
      const lockingScript = await p2pkhLock.lock({ publicKey });

      const sourceTx1 = new Transaction();
      sourceTx1.addInput({
        sourceTXID: '1111111111111111111111111111111111111111111111111111111111111111',
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
        sourceTXID: '2222222222222222222222222222222222222222222222222222222222222222',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });
      sourceTx2.addOutput({ lockingScript, satoshis: 1500 });
      sourceTx2.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        sourceTx2.id('hex'),
        1235
      );

      // Create spending transaction with multiple inputs
      const result = await new TransactionBuilder(wallet, "Multiple inputs")
        .addP2PKHInput({
          sourceTransaction: sourceTx1,
          sourceOutputIndex: 0,
          walletParams: { protocolID, keyID, counterparty },
          description: "First input"
        })
        .addP2PKHInput({
          sourceTransaction: sourceTx2,
          sourceOutputIndex: 0,
          walletParams: { protocolID, keyID, counterparty },
          description: "Second input"
        })
        .addP2PKHOutput({ publicKey, satoshis: 2400, description: "Combined output" })
        .options({ trustSelf: 'known' })
        .build();

      expect(result.txid).toBeDefined();
      expect(result.tx).toBeDefined();
    }, 30000);

    test('should create a transaction with ordinalP2PKH input and output', async () => {
      const privateKey = new PrivateKey(202);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const protocolID = [2, 'p2pkh'] as WalletProtocol;
      const keyID = '0';
      const counterparty = 'self' as WalletCounterparty;

      const { publicKey } = await wallet.getPublicKey({
        protocolID,
        keyID,
        counterparty
      });

      // Create source transaction with ordinal
      const ordinalLock = new OrdP2PKH();
      const inscription = {
        dataB64: Buffer.from('Hello Ordinal').toString('base64'),
        contentType: 'text/plain'
      };
      const lockingScript = await ordinalLock.lock({ publicKey, inscription });

      const sourceTransaction = new Transaction();
      sourceTransaction.addInput({
        sourceTXID: '3333333333333333333333333333333333333333333333333333333333333333',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });
      sourceTransaction.addOutput({
        lockingScript,
        satoshis: 1
      });
      sourceTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        sourceTransaction.id('hex'),
        1234
      );

      // Create spending transaction using TransactionTemplate
      const newInscription = {
        dataB64: Buffer.from('Transferred Ordinal').toString('base64'),
        contentType: 'text/plain'
      };

      const result = await new TransactionBuilder(wallet, "Transfer ordinal")
        .addOrdinalP2PKHInput({
          sourceTransaction,
          sourceOutputIndex: 0,
          walletParams: { protocolID, keyID, counterparty },
          description: "Ordinal input"
        })
        .addOrdinalP2PKHOutput({ publicKey, satoshis: 1, inscription: newInscription, description: "Ordinal output" })
        .options({ trustSelf: 'known' })
        .build();

      expect(result.txid).toBeDefined();
      expect(result.tx).toBeDefined();
    }, 30000);

    test('should support chaining inputs and outputs', async () => {
      const privateKey = new PrivateKey(203);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const protocolID = [2, 'p2pkh'] as WalletProtocol;
      const keyID = '0';
      const counterparty = 'self' as WalletCounterparty;

      const { publicKey } = await wallet.getPublicKey({
        protocolID,
        keyID,
        counterparty
      });

      // Create source transaction
      const p2pkhLock = new P2PKH();
      const lockingScript = await p2pkhLock.lock({ publicKey });

      const sourceTransaction = new Transaction();
      sourceTransaction.addInput({
        sourceTXID: '4444444444444444444444444444444444444444444444444444444444444444',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });
      sourceTransaction.addOutput({
        lockingScript,
        satoshis: 5000
      });
      sourceTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        sourceTransaction.id('hex'),
        1234
      );

      // Test complex chaining: input -> output -> input (different source) -> output
      const result = await new TransactionBuilder(wallet, "Complex chaining")
        .addP2PKHInput({
          sourceTransaction,
          sourceOutputIndex: 0,
          walletParams: { protocolID, keyID, counterparty },
          description: "Main input"
        })
        .addP2PKHOutput({ publicKey, satoshis: 2000, description: "First output" })
        .addP2PKHOutput({ publicKey, satoshis: 2900, description: "Second output" })
        .options({ trustSelf: 'known' })
        .build();

      expect(result.txid).toBeDefined();
      expect(result.tx).toBeDefined();
    }, 30000);

    test('should support mixing P2PKH and ordinalP2PKH inputs', async () => {
      const privateKey = new PrivateKey(204);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const protocolID = [2, 'p2pkh'] as WalletProtocol;
      const keyID = '0';
      const counterparty = 'self' as WalletCounterparty;

      const { publicKey } = await wallet.getPublicKey({
        protocolID,
        keyID,
        counterparty
      });

      // Create regular P2PKH source transaction
      const p2pkhLock = new P2PKH();
      const p2pkhLockingScript = await p2pkhLock.lock({ publicKey });

      const p2pkhSource = new Transaction();
      p2pkhSource.addInput({
        sourceTXID: '5555555555555555555555555555555555555555555555555555555555555555',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });
      p2pkhSource.addOutput({
        lockingScript: p2pkhLockingScript,
        satoshis: 3000
      });
      p2pkhSource.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        p2pkhSource.id('hex'),
        1234
      );

      // Create ordinal source transaction
      const ordinalLock = new OrdP2PKH();
      const inscription = {
        dataB64: Buffer.from('NFT Data').toString('base64'),
        contentType: 'text/plain'
      };
      const ordinalLockingScript = await ordinalLock.lock({ publicKey, inscription });

      const ordinalSource = new Transaction();
      ordinalSource.addInput({
        sourceTXID: '6666666666666666666666666666666666666666666666666666666666666666',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });
      ordinalSource.addOutput({
        lockingScript: ordinalLockingScript,
        satoshis: 1
      });
      ordinalSource.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        ordinalSource.id('hex'),
        1235
      );

      // Create transaction spending both types
      const result = await new TransactionBuilder(wallet, "Mixed inputs")
        .addP2PKHInput({
          sourceTransaction: p2pkhSource,
          sourceOutputIndex: 0,
          walletParams: { protocolID, keyID, counterparty },
          description: "Regular P2PKH input"
        })
        .addOrdinalP2PKHInput({
          sourceTransaction: ordinalSource,
          sourceOutputIndex: 0,
          walletParams: { protocolID, keyID, counterparty },
          description: "Ordinal input"
        })
        .addP2PKHOutput({ publicKey, satoshis: 2900, description: "Change" })
        .addOrdinalP2PKHOutput({ publicKey, satoshis: 1, inscription, description: "Ordinal transfer" })
        .options({ trustSelf: 'known' })
        .build();

      expect(result.txid).toBeDefined();
      expect(result.tx).toBeDefined();
    }, 30000);

    test('should add OP_RETURN to output when spending inputs', async () => {
      const privateKey = new PrivateKey(205);
      const wallet = await makeWallet('test', storageURL, privateKey.toHex());

      const protocolID = [2, 'p2pkh'] as WalletProtocol;
      const keyID = '0';
      const counterparty = 'self' as WalletCounterparty;

      const { publicKey } = await wallet.getPublicKey({
        protocolID,
        keyID,
        counterparty
      });

      // Create source transaction
      const p2pkhLock = new P2PKH();
      const lockingScript = await p2pkhLock.lock({ publicKey });

      const sourceTransaction = new Transaction();
      sourceTransaction.addInput({
        sourceTXID: '7777777777777777777777777777777777777777777777777777777777777777',
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      });
      sourceTransaction.addOutput({
        lockingScript,
        satoshis: 2000
      });
      sourceTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
        sourceTransaction.id('hex'),
        1234
      );

      const metadata = { action: "transfer", timestamp: Date.now() };

      // Create spending transaction with metadata
      const result = await new TransactionBuilder(wallet, "Transfer with metadata")
        .addP2PKHInput({
          sourceTransaction,
          sourceOutputIndex: 0,
          walletParams: { protocolID, keyID, counterparty },
          description: "Input"
        })
        .addP2PKHOutput({ publicKey, satoshis: 1900, description: "Output with metadata" })
          .addOpReturn([JSON.stringify(metadata)])
        .options({ trustSelf: 'known' })
        .build();

      expect(result.txid).toBeDefined();
      expect(result.tx).toBeDefined();
    }, 30000);
  });
});
