import { AuthProofClient, AuthProofServer } from '../auth.js';
import { serializeAuthSigData, createAuthSigData } from '../core.js';
import type { AuthProof, AuthSigData } from '../types.js';
import { Utils, type WalletProtocol } from '@bsv/sdk';

const NOW = 1_700_000_000_000;
const WINDOW = 2 * 60 * 1000;
const IDENTITY = '02abc';
const OPTIONS = { protocol: [2, 'test auth'] as WalletProtocol };

const client = new AuthProofClient(OPTIONS);
const server = new AuthProofServer(OPTIONS);

const sigData = (over: Partial<AuthSigData> = {}): AuthSigData => ({
  action: 'login',
  identityKey: IDENTITY,
  expiresAt: NOW + WINDOW,
  nonce: 'cmFuZG9tbm9uY2U=',
  ...over,
});

const proof = (over: Partial<AuthSigData> = {}): AuthProof => ({
  data: sigData(over),
  signature: [1, 2, 3],
});

describe('standalone serializeAuthSigData / createAuthSigData', () => {
  it('serialization is deterministic and changes with any field', () => {
    const base = JSON.stringify(serializeAuthSigData(sigData()));
    expect(JSON.stringify(serializeAuthSigData(sigData()))).toBe(base);
    expect(JSON.stringify(serializeAuthSigData(sigData({ action: 'delete' })))).not.toBe(base);
    expect(JSON.stringify(serializeAuthSigData(sigData({ nonce: 'b3RoZXI=' })))).not.toBe(base);
  });

  it('createAuthSigData honors the window from options and makes a 32-byte nonce', () => {
    const d = createAuthSigData('login', IDENTITY, { windowMs: 5000 }, NOW);
    expect(d.expiresAt).toBe(NOW + 5000);
    expect(Utils.toArray(d.nonce, 'base64').length).toBe(32);
  });
});

describe('AuthProofClient', () => {
  it('sets expiry to now + default window', () => {
    expect(client.createAuthSigData('login', IDENTITY, NOW).expiresAt).toBe(NOW + WINDOW);
  });

  it('produces a unique 32-byte (base64) nonce per call', () => {
    const a = client.createAuthSigData('login', IDENTITY, NOW);
    const b = client.createAuthSigData('login', IDENTITY, NOW);
    expect(a.nonce).not.toBe(b.nonce);
    expect(Utils.toArray(a.nonce, 'base64').length).toBe(32);
  });
});

describe('AuthProofServer.checkAuthSigData', () => {
  it('accepts a fresh, well-formed proof', () => {
    expect(server.checkAuthSigData(sigData(), 'login', NOW)).toEqual({ valid: true });
  });

  it('rejects garbage, action mismatch, expiry, and far-future', () => {
    expect(server.checkAuthSigData(null, 'login', NOW).error).toBe('Malformed proof');
    expect(server.checkAuthSigData(sigData({ action: 'delete' }), 'login', NOW).error).toBe('Action mismatch');
    expect(server.checkAuthSigData(sigData({ expiresAt: NOW - 1 }), 'login', NOW).error).toBe('Proof expired');
    expect(server.checkAuthSigData(sigData({ expiresAt: NOW + WINDOW + 60_000 }), 'login', NOW).error)
      .toBe('Proof expiry too far in the future');
  });

  it('accepts right up to the expiry boundary; rejects empty fields', () => {
    expect(server.checkAuthSigData(sigData({ expiresAt: NOW + 1 }), 'login', NOW).valid).toBe(true);
    expect(server.checkAuthSigData(sigData({ identityKey: '' }), 'login', NOW).error).toBe('Malformed proof');
    expect(server.checkAuthSigData(sigData({ nonce: '' }), 'login', NOW).error).toBe('Malformed proof');
  });
});

describe('AuthProofServer.verifyAuthProof', () => {
  const okWallet = () => ({ verifySignature: jest.fn(async () => ({ valid: true })) });
  const consumeOk = () => true;

  it('accepts a valid, fresh, unused proof and returns the identity key', async () => {
    const wallet = okWallet();
    const result = await server.verifyAuthProof(wallet, proof(), 'login', { now: NOW, consumeNonce: consumeOk });
    expect(result).toEqual({ valid: true, identityKey: IDENTITY });
    expect(wallet.verifySignature).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed / action mismatch / expired before the signature check', async () => {
    const wallet = okWallet();
    expect((await server.verifyAuthProof(wallet, { data: undefined, signature: [] } as unknown as AuthProof, 'login', { now: NOW, consumeNonce: consumeOk })).error).toBe('Malformed proof');
    expect((await server.verifyAuthProof(wallet, proof(), 'delete', { now: NOW, consumeNonce: consumeOk })).error).toBe('Action mismatch');
    expect((await server.verifyAuthProof(wallet, proof({ expiresAt: NOW - 1 }), 'login', { now: NOW, consumeNonce: consumeOk })).error).toBe('Proof expired');
    expect(wallet.verifySignature).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature without consuming the nonce', async () => {
    const wallet = { verifySignature: jest.fn(async () => ({ valid: false })) };
    const consume = jest.fn(async () => true);
    const result = await server.verifyAuthProof(wallet, proof(), 'login', { now: NOW, consumeNonce: consume });
    expect(result.error).toBe('Invalid signature');
    expect(consume).not.toHaveBeenCalled();
  });

  it('treats a throwing verifySignature as invalid (e.g. malformed identityKey) and does not consume', async () => {
    const wallet = { verifySignature: jest.fn(async () => { throw new Error('bad public key'); }) };
    const consume = jest.fn(async () => true);
    const result = await server.verifyAuthProof(wallet, proof(), 'login', { now: NOW, consumeNonce: consume });
    expect(result.error).toBe('Invalid signature');
    expect(consume).not.toHaveBeenCalled();
  });

  it('rejects a replayed proof (nonce already consumed)', async () => {
    const result = await server.verifyAuthProof(okWallet(), proof(), 'login', { now: NOW, consumeNonce: () => false });
    expect(result.error).toBe('Proof already used');
  });

  it('verifies the signature against the proof identity key and nonce', async () => {
    const wallet = okWallet();
    await server.verifyAuthProof(wallet, proof(), 'login', { now: NOW, consumeNonce: consumeOk });
    expect(wallet.verifySignature).toHaveBeenCalledWith(
      expect.objectContaining({ counterparty: IDENTITY, keyID: 'cmFuZG9tbm9uY2U=' }),
    );
  });
});
