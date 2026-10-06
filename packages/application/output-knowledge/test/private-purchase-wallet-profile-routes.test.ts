import { expect, it, jest } from '@jest/globals'
import {
  Beef,
  Hash,
  P2PKH,
  PrivateKey,
  PublicKey,
  ScriptEvaluationError,
  Spend,
  Transaction,
  Utils,
  canonicalOutputJSON,
  outputAssert,
  verifyOutputPacket,
  type CreateActionArgs
} from '@bsv/sdk'
import { RevenueListingProfileSpend } from '@bsv/sdk/script/templates/RevenueListingProfileSpend'
import type { RevenueListingProfileAction } from '@bsv/sdk/script/templates/RevenueListingProfilePlan'
import { revenueListingChildPublicKey } from '@bsv/sdk/script/templates/RevenueListingKeys'
import { RevenueListingProfileAuthority } from '../src/revenue-listing/RevenueListingProfileAuthority.js'
import { RevenueListingProfileLineageVerifier } from '../src/revenue-listing/RevenueListingProfileLineageVerifier.js'
import { REVENUE_LISTING_LINEAGE_LIMITS } from '../src/revenue-listing/LineagePackage.js'
import { SDKEvidenceVerifier } from '../src/SDKEvidenceVerifier.js'
import { isOutputTransactionFinal } from '../src/SpendReconciler.js'
import { BitcoinKnowledge } from '../src/BitcoinKnowledge.js'
import { KnowledgeStore } from '../src/KnowledgeStore.js'
import { MemoryJournal } from '../src/storage/MemoryJournal.js'
import { knowledgeMutation } from '../src/storage/Journal.js'
import type { OutputScope, SourceBatch, VerificationContext } from '../src/ports.js'
import { acquisitionNativeWalletFixture } from './private-acquisition-wallet.fixture.js'
import { nativeProfilePurchaseWalletFixture } from './private-purchase-wallet-profile.fixture.js'
import { profile } from './revenue-profile.fixture.js'

async function expiryKnowledge(
  id: string,
  verifier: SDKEvidenceVerifier,
  context: VerificationContext,
  previous: { txid: string; outputIndex: number; beef: string },
  txid: string,
  beef: string
) {
  const owners = []
  const scope: OutputScope = {
    chain: context.view.chain,
    provider: 'owned-native-listing',
    service: 'listing-state',
    queryDigest: '8a'.repeat(32),
    rulesDigest: '8b'.repeat(32),
    access: 'public',
    epoch: 'initial'
  }
  const batch: SourceBatch = {
    provenance: {
      partition: context.partition,
      generation: context.generation,
      adapter: 'owned-native-routes',
      scope,
      authentication: 'configured-transport',
      peer: scope.provider,
      receivedAt: context.now
    },
    groups: [
      {
        id,
        sequence: '0',
        observations: [
          { id: 'original-predecessor', scope, kind: 'output', payload: { evidence: previous } },
          {
            id: 'expiry-intent',
            scope,
            kind: 'spend',
            payload: {
              previous: {
                chain: context.view.chain,
                txid: previous.txid,
                outputIndex: previous.outputIndex
              },
              spendingTxid: txid,
              beef
            }
          }
        ]
      }
    ],
    coverage: { scope, phase: 'finite', status: 'complete' }
  }
  for (const nonFinal of [false, true]) {
    const journal = new MemoryJournal(id + '-' + nonFinal),
      worker = new BitcoinKnowledge({
        journalId: journal.namespace,
        partition: context.partition,
        nonFinal,
        verifier
      }),
      store = new KnowledgeStore(journal, worker, { partition: context.partition })
    try {
      await store.commit('0', knowledgeMutation({ kind: 'context', context }))
      await store.commit(
        (await store.revision()).received,
        knowledgeMutation({ kind: 'receive', batch })
      )
      await worker.advance(store, new AbortController().signal)
      const input = await store.read()
      expect(input.reconciled.transactions.find(row => row.txid === txid)?.status).toBe(
        nonFinal ? 'selected-non-final' : 'unsupported'
      )
      expect(
        input.assessments.find(
          row =>
            row.origin.kind === 'local' &&
            row.outpoint.txid === previous.txid &&
            row.outpoint.outputIndex === previous.outputIndex
        )?.state
      ).not.toBe('spent')
      expect(input.pendingGroups).toEqual([])
      owners.push({ store, worker, nonFinal, before: input })
    } catch (error) {
      await store.close()
      for (const owner of owners) await owner.store.close()
      throw error
    }
  }
  return owners
}

async function reassessExpiry(
  owners: Awaited<ReturnType<typeof expiryKnowledge>>,
  context: VerificationContext,
  previous: { txid: string; outputIndex: number },
  txid: string,
  mature: boolean
) {
  for (const owner of owners) {
    await owner.store.commit(
      (await owner.store.revision()).received,
      knowledgeMutation({ kind: 'context', context })
    )
    await owner.worker.advance(owner.store, new AbortController().signal)
    const input = await owner.store.read()
    expect(input.context.id).toBe(context.id)
    expect(input.reconciled.transactions.find(row => row.txid === txid)?.status).toBe(
      mature ? 'selected-final' : owner.nonFinal ? 'selected-non-final' : 'unsupported'
    )
    const state = input.assessments.find(
      row =>
        row.origin.kind === 'local' &&
        row.outpoint.txid === previous.txid &&
        row.outpoint.outputIndex === previous.outputIndex
    )?.state
    if (mature) expect(state).toBe('spent')
    else expect(state).not.toBe('spent')
    expect(input.pendingGroups).toEqual([])
  }
}

// Disclosed, independently owned synthetic wallets and checked easy-work headers.
// No production identities, external funding, broadcast or mining are involved.
it.each(['auto', 'legacy'] as const)(
  'funds all six current-profile routes and native eight-recipient child payouts (%s)',
  async mode => {
    const recipientActors = Array.from({ length: 8 }, (_, index) => ({
      scalar: 61 + index,
      identity: new PrivateKey(61 + index).toPublicKey().toString(),
      weight: index + 1
    })).sort((a, b) => a.identity.localeCompare(b.identity))
    const revenue = {
      recipients: recipientActors.map(({ identity, weight }) => ({ identity, weight }))
    }
    const recipients: Awaited<ReturnType<typeof acquisitionNativeWalletFixture>>[] = []
    const signingWallets: Awaited<ReturnType<typeof acquisitionNativeWalletFixture>>[] = []
    const knowledgeOwners: Awaited<ReturnType<typeof expiryKnowledge>> = []
    let listingFixture: Awaited<ReturnType<typeof nativeProfilePurchaseWalletFixture>> | undefined
    let authority: RevenueListingProfileAuthority | undefined
    const originator = 'native-current-routes.local'
    const expiry = 102
    try {
      const f = (listingFixture = await nativeProfilePurchaseWalletFixture(524288, expiry, {
        revenue,
        purchasePrice: '100001',
        genesisFeeSatoshis: 40,
        maximumVerifiedHeight: 103,
        actionBatchMode: mode,
        prepareGenesisAuthority: async ({ descriptor, chain, tracker }) => {
          // All actual protected signing/storage capabilities precede genesis funding.
          const seller = await acquisitionNativeWalletFixture(chain, tracker, 41, undefined, mode)
          signingWallets.push(seller)
          authority = await RevenueListingProfileAuthority.create({
            wallet: seller.native.wallet,
            identity: descriptor.seller,
            originator,
            checkCurrent: () =>
              outputAssert(
                descriptor.seller === seller.native.identities.wallet,
                'Selected synthetic seller changed'
              )
          })
          for (const actor of recipientActors) {
            const recipient = await acquisitionNativeWalletFixture(
              chain,
              tracker,
              actor.scalar,
              undefined,
              mode
            )
            recipients.push(recipient)
            const capability = await recipient.native.wallet.getBrc197InternalizationCapabilities()
            expect(capability.recipientIdentityKey).toBe(actor.identity)
            expect(capability.childPublicKey).toBe(revenueListingChildPublicKey(actor.identity))
            await RevenueListingProfileAuthority.create({
              wallet: recipient.native.wallet,
              identity: actor.identity,
              originator,
              checkCurrent: () =>
                outputAssert(
                  actor.identity === recipient.native.identities.wallet,
                  'Selected synthetic recipient changed'
                )
            })
          }
          expect(profile.lock('activation', descriptor).toBinary()).toHaveLength(34127)
          expect(profile.lock('active', descriptor).toBinary()).toHaveLength(5627)
          return authority
        }
      }))
      outputAssert(authority !== undefined, 'Protected seller preflight required')
      const seller = authority
      const installed = f.lineage.descriptor
      expect(verifyOutputPacket('sale-genesis', f.lineage.genesis, installed.seller)).toBe(true)
      const genesis = f.lineage.genesis.body.genesis
      const creation = Beef.fromBinaryStrict(
        Utils.toArray(f.lineage.transactions.find(row => row.txid === genesis.txid)!.beef, 'base64')
      ).findTransactionForSigning(genesis.txid)!
      expect(
        creation.inputs[0].sourceTransaction!.outputs[0].satoshis! -
          creation.outputs.reduce((sum, output) => sum + output.satoshis!, 0)
      ).toBeGreaterThanOrEqual(Math.ceil(creation.toBinary().length / 1000))
      const packet = {
        ...structuredClone(f.lineage),
        target: structuredClone(genesis),
        transactions: f.lineage.transactions.filter(row => row.txid === genesis.txid)
      }
      const bounds = REVENUE_LISTING_LINEAGE_LIMITS
      const bitcoin = new SDKEvidenceVerifier(f.chains, {
        candidateBytes: bounds.bytes,
        transactions: bounds.transactions,
        inputs: bounds.inputs,
        scriptBytes: bounds.bytes,
        scriptMemoryBytes: bounds.scriptMemoryBytes,
        attemptTimeoutMs: bounds.timeoutMs,
        requestTimeoutMs: bounds.timeoutMs,
        consumers: bounds.concurrentRequests
      })
      const lineage = new RevenueListingProfileLineageVerifier(profile, f.chains)
      expect((await lineage.verify(packet, f.currentContext())).status).toBe('verified')
      let owner = f,
        source: number[] | Uint8Array = Utils.toArray(packet.transactions[0].beef, 'base64')
      let outputIndex = 0,
        pendingChange: string[] | undefined
      let splitSource: number[] | Uint8Array | undefined
      let splitPacket: typeof packet | undefined
      let payout: { beef: number[] | Uint8Array; firstOutput: number; units: number } | undefined
      const actions: RevenueListingProfileAction[] = [
        { operation: 'activate' },
        {
          operation: 'purchase',
          acquisitionId: f.terms.body.acquisitionId,
          requestDigest: f.terms.body.requestDigest,
          recipient: f.prepare.recipient
        },
        { operation: 'split', firstAmount: '50000' },
        { operation: 'payout', units: '1300' },
        { operation: 'retire', authority: 'seller' },
        { operation: 'retire', authority: 'expiry', lockHeight: expiry }
      ]
      for (const action of actions) {
        if (action.operation === 'retire' && action.authority === 'expiry') {
          outputAssert(
            splitSource !== undefined && splitPacket !== undefined,
            'Split branch required'
          )
          source = splitSource
          outputIndex = 1
          Object.assign(packet, structuredClone(splitPacket))
          expect(f.currentContext().view.tipHeight).toBe(String(expiry - 1))
        }
        const previous = Transaction.fromAtomicBEEF(source)
        const spend = new RevenueListingProfileSpend(
          profile,
          installed,
          [{ rawTransaction: previous.toHex(), outputIndex }],
          action
        )
        const plan = spend.plan()
        const id =
          'current-native-' +
          action.operation +
          (action.operation === 'retire' ? '-' + action.authority : '')
        const request: CreateActionArgs = {
          description: 'Synthetic current listing ' + action.operation,
          inputBEEF: source,
          version: 1,
          lockTime: plan.lockTime,
          inputs: [
            {
              outpoint: `${plan.input.txid}.${plan.input.outputIndex}`,
              inputDescription: 'Authenticated listing predecessor',
              sequenceNumber: plan.listingSequence,
              unlockingScriptLength: spend.estimateUnlockingLength(0)
            }
          ],
          outputs: plan.outputs.map(output => ({
            ...output,
            satoshis: Number(output.satoshis),
            outputDescription: 'Required current-profile output',
            basket: 'current-native-routes'
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
        expect(reopened.owner.wallet.actionBatch.mode).toBe(mode)
        const funded = Transaction.fromAtomicBEEF(original.signableTransaction!.tx)
        const evidence = Beef.fromBinaryStrict(original.signableTransaction!.tx)
        for (const input of funded.inputs)
          input.sourceTransaction = evidence.findTransactionForSigning(input.sourceTXID!)!
        const prepared = spend.prepare(funded)
        const requests = prepared.signingRequests()
        expect(requests).toHaveLength(plan.sellerAuthorization === undefined ? 0 : 1)
        // Approve the complete funded snapshot before giving the protected wallet a request.
        expect(
          funded.outputs.slice(0, plan.outputs.length).map(output => ({
            satoshis: String(output.satoshis),
            lockingScript: output.lockingScript.toHex()
          }))
        ).toEqual(plan.outputs)
        const signatures: { seller?: string } = {}
        for (const required of requests) signatures.seller = await seller.signTransaction(required)
        const complete = prepared.complete(signatures)
        const final = await reopened.actions.finalize(id, request, {
          reference: original.signableTransaction!.reference,
          spends: {
            0: {
              unlockingScript: complete.inputs[0].unlockingScript!.toHex(),
              sequenceNumber: plan.listingSequence
            }
          }
        })
        const actual = Transaction.fromAtomicBEEF(final.tx!)
        prepared.assertFinalLayout(actual)
        expect(await reopened.actions.recover(id, request)).toEqual({
          state: 'finalized',
          result: final
        })
        const inputSum = funded.inputs.reduce(
          (sum, input) =>
            sum + BigInt(input.sourceTransaction!.outputs[input.sourceOutputIndex].satoshis!),
          0n
        )
        const outputSum = actual.outputs.reduce((sum, output) => sum + BigInt(output.satoshis!), 0n)
        expect(inputSum - outputSum).toBeGreaterThanOrEqual(
          BigInt(Math.ceil(actual.toBinary().length / 1000))
        )
        expect(actual.inputs.length).toBeLessThanOrEqual(8)
        expect(actual.outputs.length).toBeLessThanOrEqual(11)
        expect(actual.toBinary().length).toBeLessThanOrEqual(524288)
        const checked = await bitcoin.verify(
          {
            chain: f.selected,
            evidence: { txid: final.txid!, outputIndex: 0, beef: Utils.toBase64(final.tx!) },
            variantId: Utils.toHex(Hash.sha256(Array.from(final.tx!)))
          },
          f.currentContext(),
          new AbortController().signal
        )
        expect({ operation: id, status: checked.status }).toEqual({
          operation: id,
          status: 'verified'
        })
        if (action.operation !== 'retire') {
          packet.target = { ...packet.target, txid: final.txid!, outputIndex: 0 }
          packet.transactions.push({ txid: final.txid!, beef: Utils.toBase64(final.tx!) })
          packet.transactions.sort((a, b) => a.txid.localeCompare(b.txid))
          const history = await lineage.verify(packet, f.currentContext())
          expect({ operation: id, status: history.status }).toEqual({
            operation: id,
            status: 'verified'
          })
          if (history.status === 'verified') expect(history.stage).toBe('active')
        }
        if (action.operation === 'split') {
          expect(plan.outputs.slice(0, 2).map(output => output.satoshis)).toEqual([
            '50000',
            '50002'
          ])
          splitSource = final.tx!
          splitPacket = structuredClone(packet)
        }
        if (action.operation === 'payout') {
          expect(actual.outputs[0].satoshis).toBe(3200)
          payout = { beef: final.tx!, firstOutput: plan.receiptIndex! + 1, units: 1300 }
        }
        if (action.operation === 'retire') {
          expect(plan.retirementTopUp).toBe(action.authority === 'seller' ? '4' : '2')
          expect(plan.outputs[plan.receiptIndex!].satoshis).toBe('1')
          if (action.authority === 'expiry') {
            expect(actual.lockTime).toBe(expiry)
            expect(actual.inputs[0].sequence).toBe(0xfffffffe)
            const early = f.currentContext()
            expect(early.view.tipHeight).toBe(String(expiry - 1))
            expect(isOutputTransactionFinal(actual, early.view)).toBe(false)
            const previousOutput = {
              txid: previous.id('hex'),
              outputIndex,
              beef: Utils.toBase64(Array.from(source))
            }
            knowledgeOwners.push(
              ...(await expiryKnowledge(
                id + '-' + mode,
                bitcoin,
                early,
                previousOutput,
                final.txid!,
                Utils.toBase64(final.tx!)
              ))
            )
            const effects = { ...f.counts }
            f.setVerifiedHeight(expiry)
            const mature = f.currentContext()
            expect(mature.id).not.toBe(early.id)
            expect(mature.view.tipHash).not.toBe(early.view.tipHash)
            expect(isOutputTransactionFinal(actual, mature.view)).toBe(true)
            await reassessExpiry(knowledgeOwners, mature, previousOutput, final.txid!, true)
            f.setVerifiedHeight(expiry - 1)
            const regressed = f.currentContext()
            regressed.id += '-regressed'
            regressed.generation = '1'
            expect(isOutputTransactionFinal(actual, regressed.view)).toBe(false)
            await reassessExpiry(knowledgeOwners, regressed, previousOutput, final.txid!, false)
            expect(f.counts).toEqual(effects)
            expect(await reopened.actions.recover(id, request)).toEqual({
              state: 'finalized',
              result: final
            })
            // The old snapshots retain their exact early view and never become
            // retroactive spend decisions. Observation/replay did no wallet work.
            for (const knowledge of knowledgeOwners) {
              expect(knowledge.before.context).toEqual(early)
              expect(
                knowledge.before.assessments.find(
                  row =>
                    row.origin.kind === 'local' &&
                    row.outpoint.txid === previousOutput.txid &&
                    row.outpoint.outputIndex === previousOutput.outputIndex
                )?.state
              ).not.toBe('spent')
            }
            f.setVerifiedHeight(expiry)
            expect(requests).toEqual([])
          }
        }
        const payoutStart = plan.receiptIndex === null ? plan.outputs.length : plan.receiptIndex + 1
        if (action.operation === 'payout' || action.operation === 'retire')
          expect(plan.outputs.slice(payoutStart).map(output => output.lockingScript)).toEqual(
            recipientActors.map(actor =>
              new P2PKH()
                .lock(
                  PublicKey.fromString(revenueListingChildPublicKey(actor.identity)).toAddress()
                )
                .toHex()
            )
          )
        // A signed, syntactically valid transaction with underpayment must fail Script.
        if (action.operation === 'purchase') {
          const altered = Transaction.fromHex(actual.toHex())
          altered.outputs[0].satoshis!--
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
        source = final.tx!
        outputIndex = 0
        pendingChange = original.noSendChange?.map(
          point => `${final.txid}.${point.slice(point.lastIndexOf('.') + 1)}`
        )
        owner = { ...f, ...reopened }
      }
      expect(f.counts.prepare).toBe(6)
      expect(f.counts.finalize).toBe(6)
      outputAssert(payout !== undefined, 'Full eight-recipient payout required')
      for (const [index, recipient] of recipients.entries()) {
        const actor = recipientActors[index],
          amount = payout.units * actor.weight
        const args = {
          profile: 'brc197-fixed-child-v1' as const,
          recipientIdentityKey: actor.identity,
          tx: payout.beef,
          outputs: [
            {
              outputIndex: payout.firstOutput + index,
              protocol: 'wallet payment' as const,
              paymentRemittance: {
                senderIdentityKey:
                  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
                derivationPrefix: 'brc197',
                derivationSuffix: 'authority'
              }
            }
          ],
          description: 'Current-profile proportional child payout'
        }
        expect(
          (await recipient.native.wallet.internalizeBrc197Action(args, originator)).satoshis
        ).toBe(amount)
        await recipient.native.close()
        const reopened = await recipient.open()
        expect((await reopened.wallet.internalizeBrc197Action(args, originator)).satoshis).toBe(0)
        const row = (
          await reopened.active.findOutputs({
            partial: {
              txid: Transaction.fromAtomicBEEF(payout.beef).id('hex'),
              vout: payout.firstOutput + index
            }
          })
        )[0]
        expect(row).toMatchObject({
          satoshis: amount,
          derivationPrefix: 'brc197',
          derivationSuffix: 'authority',
          senderIdentityKey: args.outputs[0].paymentRemittance.senderIdentityKey
        })
        const result = await reopened.wallet.createAction(
          {
            description: 'Spend actual proportional child payout',
            outputs: [
              {
                satoshis: amount - 2,
                lockingScript: '51',
                outputDescription: 'Synthetic recipient destination'
              }
            ],
            options: { noSend: true, randomizeOutputs: false, returnTXIDOnly: false }
          },
          originator
        )
        expect(result.tx).toBeDefined()
        const spend = Transaction.fromAtomicBEEF(result.tx!)
        expect(spend.inputs[0].sourceTXID).toBe(Transaction.fromAtomicBEEF(payout.beef).id('hex'))
        expect(spend.inputs[0].sourceOutputIndex).toBe(payout.firstOutput + index)
        expect(
          await spend.verify(
            (await f.chains.resolve(f.currentContext().view, new AbortController().signal)).tracker
          )
        ).toBe(true)
        expect(reopened.wallet.actionBatch.hasWorkspace).toBe(mode === 'auto')
        const outpoint = `${Transaction.fromAtomicBEEF(payout.beef).id('hex')}.${payout.firstOutput + index}`
        expect(
          (await reopened.wallet.listOutputs({ basket: 'default' })).outputs.map(
            output => output.outpoint
          )
        ).not.toContain(outpoint)
        if (mode === 'auto') {
          expect(await reopened.active.findReservedActionBatchOutputIds([row.outputId])).toContain(
            row.outputId
          )
          expect(
            (await reopened.active.findOutputs({ partial: { outputId: row.outputId } }))[0]
              .spendable
          ).toBe(true)
        }
        // Complete the native local journal through the public API. This owned,
        // synthetic response performs no network call and proves no mining.
        jest.spyOn(reopened.active, 'getServices').mockReturnValue(reopened.services)
        const syntheticPost = jest
          .spyOn(reopened.services, 'postBeef')
          .mockImplementation(async (_beef, txids) => {
            expect(txids).toContain(result.txid)
            return [
              {
                name: 'owned-synthetic-no-network',
                status: 'success',
                txidResults: txids.map(txid => ({ txid, status: 'success' }))
              }
            ]
          })
        const committed = await reopened.wallet.createAction(
          {
            description: 'Commit owned synthetic protected payout spend',
            options: { sendWith: [result.txid!], acceptDelayedBroadcast: false }
          },
          originator
        )
        expect(committed.sendWithResults).toContainEqual(
          expect.objectContaining({ txid: result.txid })
        )
        expect(syntheticPost).toHaveBeenCalledTimes(1)
        expect(reopened.wallet.actionBatch.hasWorkspace).toBe(false)
        expect(await reopened.active.findReservedActionBatchOutputIds([row.outputId])).toEqual([])
        const storedSpend = await reopened.active.findTransactions({
          partial: { txid: result.txid },
          noRawTx: true
        })
        expect(storedSpend).toHaveLength(1)
        expect(
          (await reopened.active.findOutputs({ partial: { outputId: row.outputId } }))[0]
        ).toMatchObject({
          spendable: false,
          spentBy: storedSpend[0].transactionId
        })
        await reopened.close()
        const second = await recipient.open()
        expect(
          (await second.active.findOutputs({ partial: { outputId: row.outputId } }))[0]
        ).toMatchObject({
          spendable: false,
          spentBy: storedSpend[0].transactionId,
          derivationPrefix: 'brc197',
          derivationSuffix: 'authority',
          senderIdentityKey: args.outputs[0].paymentRemittance.senderIdentityKey
        })
        expect(
          (await second.wallet.listOutputs({ basket: 'default' })).outputs.map(
            output => output.outpoint
          )
        ).not.toContain(outpoint)
        await second.close()
        expect(canonicalOutputJSON(args.outputs[0].paymentRemittance)).toContain('brc197')
        expect(recipient.broadcast).not.toHaveBeenCalled()
        await reopened.close()
      }
      expect(f.native.broadcast).not.toHaveBeenCalled()
    } finally {
      for (const knowledge of knowledgeOwners) await knowledge.store.close()
      await listingFixture?.close()
      for (const wallet of [...recipients, ...signingWallets]) await wallet.close()
    }
  },
  180000
)
