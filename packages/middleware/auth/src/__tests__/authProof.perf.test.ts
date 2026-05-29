import { performance } from 'perf_hooks';
import {
  createAuthProof,
  verifyAuthProof,
  serializeSignablePayload,
  normalizeBody,
  createAuthSigData,
} from '../core.js';
import { ProtoWallet, PrivateKey, type WalletProtocol } from '@bsv/sdk';

// Local micro-benchmark — NOT a pass/fail SLA. It logs avg/throughput and asserts
// only very loose ceilings, to catch catastrophic regressions (e.g. an accidental
// O(n) blow-up), never normal machine variance. Run with `npm run test:perf`; tune
// the crypto iteration count with the PERF_ITER env var (default 50).
const ITER = Math.max(1, Number(process.env.PERF_ITER ?? 50));
const PURE_ITER = 20_000;
const WARMUP = Math.min(5, ITER);

// Large window so pre-minted proofs never expire mid-run, even at a high PERF_ITER.
const OPTIONS = { protocol: [2, 'perf auth'] as WalletProtocol, windowMs: 10 * 60 * 1000 };
const BODY = { newUsername: 'alice', bio: 'x'.repeat(256) };

interface Stats { label: string; n: number; avgMs: number; minMs: number; maxMs: number; opsPerSec: number; }

function summarize(label: string, samples: number[]): Stats {
  const total = samples.reduce((a, b) => a + b, 0);
  const avgMs = total / samples.length;
  return { label, n: samples.length, avgMs, minMs: Math.min(...samples), maxMs: Math.max(...samples), opsPerSec: 1000 / avgMs };
}

// Slow (crypto) ops: sample each call so we get a meaningful min/max/avg.
async function benchAsync(label: string, n: number, fn: (i: number) => Promise<unknown>): Promise<Stats> {
  for (let i = 0; i < WARMUP; i++) await fn(i);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  return summarize(label, samples);
}

// Fast (pure) ops: time the whole batch — per-call timer overhead would dwarf them.
function benchSyncBatch(label: string, n: number, fn: (i: number) => unknown): Stats {
  for (let i = 0; i < WARMUP; i++) fn(i);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const avgMs = (performance.now() - t0) / n;
  return { label, n, avgMs, minMs: avgMs, maxMs: avgMs, opsPerSec: 1000 / avgMs };
}

function report(s: Stats): void {
  const ops = Math.round(s.opsPerSec).toLocaleString();
  // eslint-disable-next-line no-console
  console.log(
    `[perf] ${s.label.padEnd(32)} ${String(s.n).padStart(6)}x   ` +
    `avg ${s.avgMs.toFixed(4)}ms   min ${s.minMs.toFixed(4)}   max ${s.maxMs.toFixed(4)}   ${ops} ops/s`,
  );
}

describe('performance (local benchmark — `npm run test:perf`, PERF_ITER to scale)', () => {
  let clientWallet: ProtoWallet;
  let serverWallet: ProtoWallet;
  let serverKey: string;
  const consumeOk = (): boolean => true;

  beforeAll(async () => {
    clientWallet = new ProtoWallet(PrivateKey.fromRandom());
    serverWallet = new ProtoWallet(PrivateKey.fromRandom());
    serverKey = (await serverWallet.getPublicKey({ identityKey: true })).publicKey;
  });

  it(`createAuthProof — bodyless vs body-bound (${ITER}x)`, async () => {
    const login = await benchAsync('createAuthProof (login)', ITER, () =>
      createAuthProof({ wallet: clientWallet, counterparty: serverKey, action: 'login', ...OPTIONS }));
    const body = await benchAsync('createAuthProof (body)', ITER, () =>
      createAuthProof({ wallet: clientWallet, counterparty: serverKey, action: 'update', body: BODY, ...OPTIONS }));
    report(login);
    report(body);
    expect(login.avgMs).toBeLessThan(500);
    expect(body.avgMs).toBeLessThan(500);
  }, 120_000);

  it(`verifyAuthProof — bodyless vs body-bound (${ITER}x)`, async () => {
    const loginProofs = await Promise.all(Array.from({ length: ITER }, async () =>
      createAuthProof({ wallet: clientWallet, counterparty: serverKey, action: 'login', ...OPTIONS })));
    const bodyProofs = await Promise.all(Array.from({ length: ITER }, async () =>
      createAuthProof({ wallet: clientWallet, counterparty: serverKey, action: 'update', body: BODY, ...OPTIONS })));

    const vLogin = await benchAsync('verifyAuthProof (login)', ITER, (i) =>
      verifyAuthProof({ wallet: serverWallet, proof: loginProofs[i], action: 'login', consumeNonce: consumeOk, ...OPTIONS }));
    const vBody = await benchAsync('verifyAuthProof (body)', ITER, (i) =>
      verifyAuthProof({ wallet: serverWallet, proof: bodyProofs[i], action: 'update', consumeNonce: consumeOk, body: BODY, ...OPTIONS }));
    report(vLogin);
    report(vBody);
    expect(vLogin.avgMs).toBeLessThan(500);
    expect(vBody.avgMs).toBeLessThan(500);
  }, 120_000);

  it(`pure serialization, no crypto (${PURE_ITER}x) — should dwarf the crypto path`, () => {
    const data = createAuthSigData('login', '02abc', OPTIONS);
    const ser = benchSyncBatch('serializeSignablePayload(body)', PURE_ITER, () => serializeSignablePayload(data, BODY));
    const norm = benchSyncBatch('normalizeBody(object)', PURE_ITER, () => normalizeBody(BODY));
    report(ser);
    report(norm);
    expect(ser.avgMs).toBeLessThan(1);
    expect(norm.avgMs).toBeLessThan(1);
  });
});
