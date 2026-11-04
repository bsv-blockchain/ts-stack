import { expect, it } from '@jest/globals'
import {
  Beef,
  Hash,
  P2PKH,
  PrivateKey,
  ScriptEvaluationError,
  Spend,
  Transaction,
  Utils,
  type CreateActionArgs
} from '@bsv/sdk'
import { RevenueListingSpend } from '@bsv/sdk/script/templates/RevenueListingSpend'
import type { RevenueListingAction } from '@bsv/sdk/script/templates/RevenueListingPlan'
import { createSoftwareRevenueListingAuthority } from '../src/revenue-listing/RevenueListingAuthority.js'
import { REVENUE_LISTING_LINEAGE_LIMITS } from '../src/revenue-listing/LineagePackage.js'
import { RevenueListingLineageVerifier } from '../src/revenue-listing/RevenueListingLineageVerifier.js'
import { SDKEvidenceVerifier } from '../src/SDKEvidenceVerifier.js'
import { nativePurchaseWalletFixture } from './private-purchase-wallet-native.fixture.js'
import { chains, compact, completeGenesis, context, family } from './revenue-lineage-fixture.js'

/** Public dedicated authority keys, real native noSend funding/recovery and a
 * checked synthetic header ancestry. This never broadcasts or establishes
 * current unspentness, production authority, or live-chain inclusion.
 */
it('funds all six economic routes and checks complete authorized lineage through native wallet reopen', async () => {
  const descriptor = structuredClone(completeGenesis().descriptor)
  const authorities = [41, 42, 43, 45].map(code =>
    createSoftwareRevenueListingAuthority(new PrivateKey(code))
  )
  descriptor.purchasePrice = '1001'
  descriptor.reserve = '1'
  descriptor.initialRevenue = {
    revision: '0',
    recipients: authorities
      .slice(1, 3)
      .map((authority, index) => ({
        identity: authority.identity,
        weight: index === 0 ? 7 : 3
      }))
      .sort((a, b) => a.identity.localeCompare(b.identity))
  }
  const f = await nativePurchaseWalletFixture(524288, {
    descriptor,
    prepare: {
      version: 1,
      requestId: 'native-six-route-purchase',
      topic: 'tm_native_routes',
      listing: descriptor.lineageAnchor,
      assetId: descriptor.assetId,
      termsDigest: descriptor.termsDigest,
      recipient: new PrivateKey(44).toPublicKey().toString(),
      request: 'AA=='
    },
    sellerKey: new PrivateKey(41),
    buyerKeyCode: 44,
    now: 20
  })
  const installed = f.lineage.descriptor,
    lineage = new RevenueListingLineageVerifier(family, chains)
  // Install the existing covenant profile rather than generic P2PKH-oriented defaults.
  const bounds = REVENUE_LISTING_LINEAGE_LIMITS
  const bitcoin = new SDKEvidenceVerifier(chains, {
      candidateBytes: bounds.bytes,
      transactions: bounds.transactions,
      inputs: bounds.inputs,
      scriptBytes: bounds.bytes,
      scriptMemoryBytes: bounds.scriptMemoryBytes,
      attemptTimeoutMs: bounds.timeoutMs,
      requestTimeoutMs: bounds.timeoutMs,
      consumers: bounds.concurrentRequests
    }),
    packet = structuredClone(f.lineage)
  const selectedView = () => {
    const view = context()
    view.view.chain = f.selected
    return view
  }
  const initial = await lineage.verify(compact(packet), selectedView())
  expect(initial.status).toBe('verified')
  let owner = f,
    source: number[] | Uint8Array = Utils.toArray(packet.transactions[0].beef, 'base64'),
    indices = [0],
    pendingChange: string[] | undefined
  const nextState = {
    revision: '1',
    recipients: [
      { identity: authorities[3].identity, weight: 4 },
      { identity: authorities[2].identity, weight: 3 }
    ].sort((a, b) => a.identity.localeCompare(b.identity))
  }
  const actions: RevenueListingAction[] = [
    {
      operation: 'purchase',
      acquisitionId: f.terms.body.acquisitionId,
      requestDigest: f.terms.body.requestDigest,
      recipient: f.prepare.recipient
    },
    { operation: 'split', firstAmount: '500' },
    { operation: 'merge' },
    { operation: 'payout', units: '99' },
    { operation: 'amend', state: nextState },
    { operation: 'retire' }
  ]
  try {
    for (const action of actions) {
      const previous = Transaction.fromAtomicBEEF(source)
      const spend = new RevenueListingSpend(
        family,
        installed,
        indices.map(outputIndex => ({
          rawTransaction: previous.toHex(),
          outputIndex
        })),
        action
      )
      const plan = spend.plan(),
        id = 'native-route-' + action.operation
      const request: CreateActionArgs = {
        description: 'Disclosed native ' + action.operation,
        inputBEEF: source,
        inputs: plan.inputs.map((input, index) => ({
          outpoint: `${input.txid}.${input.outputIndex}`,
          inputDescription: 'Authorized listing predecessor',
          unlockingScriptLength: spend.estimateUnlockingLength(index)
        })),
        outputs: plan.outputs.map(output => ({
          ...output,
          satoshis: Number(output.satoshis),
          outputDescription: 'Required economic output',
          basket: 'native-routes'
        })),
        options: {
          noSend: true,
          signAndProcess: false,
          randomizeOutputs: false,
          returnTXIDOnly: false,
          ...(pendingChange ? { noSendChange: pendingChange } : {})
        }
      }
      const original = await owner.actions.prepare(id, request)
      await owner.owner.close()
      const reopened = await f.reopen()
      expect(await reopened.actions.recover(id, request)).toEqual({
        state: 'prepared',
        result: original
      })
      const funded = Transaction.fromAtomicBEEF(original.signableTransaction!.tx)
      const evidence = Beef.fromBinaryStrict(original.signableTransaction!.tx)
      funded.inputs.forEach(input => {
        input.sourceTransaction = evidence.findTransactionForSigning(input.sourceTXID!)!
      })
      const prepared = spend.prepare(funded),
        requests = prepared.signingRequests()
      async function authorizeSpend() {
        const signatures: { seller?: string; recipients: string[] }[] = plan.inputs.map(() => ({
          recipients: []
        }))
        for (const required of requests) {
          const authority = authorities.find(authority => authority.identity === required.identity)!
          const signature = await authority.signTransaction(required)
          if (required.role === 'seller') signatures[required.inputIndex].seller = signature
          else signatures[required.inputIndex].recipients.push(signature)
        }
        return signatures
      }
      const signatures = await authorizeSpend()
      if (action.operation === 'amend') {
        expect(requests).toHaveLength(3)
        expect(new Set(requests.filter(r => r.role === 'recipient').map(r => r.identity))).toEqual(
          new Set(installed.initialRevenue.recipients.map(r => r.identity))
        )
        const missingConsent = structuredClone(signatures)
        missingConsent[0].recipients.pop()
        expect(() => prepared.complete(missingConsent)).toThrow()
      }
      const complete = prepared.complete(signatures)
      const final = await reopened.actions.finalize(id, request, {
        reference: original.signableTransaction!.reference,
        spends: Object.fromEntries(
          indices.map((_, index) => [
            index,
            { unlockingScript: complete.inputs[index].unlockingScript!.toHex() }
          ])
        )
      })
      prepared.assertFinalLayout(Transaction.fromAtomicBEEF(final.tx!))
      expect(await reopened.actions.recover(id, request)).toEqual({
        state: 'finalized',
        result: final
      })
      const checked = await bitcoin.verify(
        {
          chain: f.selected,
          evidence: { txid: final.txid!, outputIndex: 0, beef: Utils.toBase64(final.tx!) },
          variantId: Utils.toHex(Hash.sha256(Array.from(final.tx!)))
        },
        selectedView(),
        new AbortController().signal
      )
      expect({ operation: action.operation, status: checked.status }).toEqual({
        operation: action.operation,
        status: 'verified'
      })
      if (action.operation !== 'retire') {
        packet.target = { ...packet.target, txid: final.txid!, outputIndex: 0 }
        packet.transactions.push({ txid: final.txid!, beef: Utils.toBase64(final.tx!) })
        packet.transactions.sort((a, b) => a.txid.localeCompare(b.txid))
        const history = await lineage.verify(compact(packet), selectedView())
        expect({ operation: action.operation, status: history.status }).toEqual({
          operation: action.operation,
          status: 'verified'
        })
        if (action.operation === 'amend' && history.status === 'verified')
          expect(history.state).toEqual(nextState)
      }
      function checkEconomicOutputs() {
        if (action.operation === 'purchase' || action.operation === 'merge') {
          const altered = Transaction.fromHex(complete.toHex())
          altered.outputs[0].satoshis = 1
          const input = altered.inputs[0],
            prior = funded.inputs[0].sourceTransaction!.outputs[input.sourceOutputIndex]
          expect(() =>
            new Spend({
              sourceTXID: input.sourceTXID!,
              sourceOutputIndex: input.sourceOutputIndex,
              sourceSatoshis: prior.satoshis!,
              lockingScript: prior.lockingScript,
              transactionVersion: altered.version,
              otherInputs: altered.inputs.slice(1),
              outputs: altered.outputs,
              inputIndex: 0,
              unlockingScript: input.unlockingScript!,
              inputSequence: input.sequence!,
              lockTime: altered.lockTime,
              memoryLimit: 134217728
            }).validate()
          ).toThrow(ScriptEvaluationError)
        }
        if (action.operation === 'payout') {
          expect(Transaction.fromAtomicBEEF(final.tx!).outputs[0].satoshis).toBe(12)
          expect(plan.outputs[plan.receiptIndex].satoshis).toBe('1')
          expect(
            plan.outputs
              .slice(plan.receiptIndex + 1)
              .map(o => o.satoshis)
              .sort()
          ).toEqual(['297', '693'])
        }
        if (action.operation === 'retire') {
          expect(plan.retirementTopUp).toBe('2')
          expect(plan.outputs[plan.receiptIndex].satoshis).toBe('1')
          expect(
            plan.outputs
              .slice(plan.receiptIndex + 1)
              .map(o => o.satoshis)
              .sort()
          ).toEqual(['6', '8'])
          expect(requests.map(r => ({ identity: r.identity, role: r.role }))).toEqual([
            { identity: authorities[0].identity, role: 'seller' }
          ])
          expect(plan.outputs.slice(plan.receiptIndex + 1)).toEqual(
            nextState.recipients.map(recipient => ({
              satoshis: String(recipient.weight * 2),
              lockingScript: new P2PKH()
                .lock(Hash.hash160(Utils.toArray(recipient.identity, 'hex')))
                .toHex()
            }))
          )
        }
      }
      checkEconomicOutputs()
      source = final.tx!
      // Preserve wallet-identified change vouts under the actual signed txid.
      pendingChange = original.noSendChange?.map(
        point => `${final.txid}.${point.slice(point.lastIndexOf('.') + 1)}`
      )
      indices = action.operation === 'split' ? [0, 1] : [0]
      owner = { ...f, ...reopened }
    }
    expect(f.counts.prepare).toBe(6)
    expect(f.counts.finalize).toBe(6)
  } finally {
    await f.close()
  }
}, 180000)
