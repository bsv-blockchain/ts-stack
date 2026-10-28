import fc from 'fast-check'
import type { Knex } from 'knex'
import type { Brc38ImportJournalReceipt } from './Brc38ImportJournalCore'
import type { FixedProfile, State } from './Brc38PublishedProfileReceiptNode'
import { verifyBrc38PublishedWalletData } from './Brc38PublishedWalletData'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026)
})

interface User {
  userId: number
  identityKey: string
  activeStorage: string
}
interface Settings {
  chain: string
  storageIdentityKey: string
}
function readOnlyRows(users: readonly User[], settings: readonly Settings[]): Knex {
  return ((table: string) => {
    expect(['users', 'settings']).toContain(table)
    return {
      select: (...columns: string[]) => {
        expect(columns).toEqual(
          table === 'users' ? ['userId', 'identityKey', 'activeStorage'] : ['chain', 'storageIdentityKey']
        )
        return {
          limit: (maximum: number) => {
            expect(maximum).toBe(2)
            return Promise.resolve(table === 'users' ? users : settings)
          }
        }
      }
    }
  }) as unknown as Knex
}

describe('published-wallet data retains the complete scoped identity', () => {
  test('generated completed profiles reject a changed user, chain, destination, completion or primary', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1000000 }),
        fc.integer({ min: 0, max: 1000000 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.constantFrom('main', 'test'),
        fc.constantFrom<State>('RECEIVING', 'READY', 'ACTIVATING', 'ACTIVE'),
        async (userId, totalRows, identity, chain, state) => {
          const destination = 'selected:' + identity
          const user: User = {
            userId,
            identityKey: identity,
            activeStorage: state === 'ACTIVE' ? destination : ''
          }
          const setting: Settings = { chain, storageIdentityKey: destination }
          const fixed = {
            binding: { identityKey: identity, chain, targetStorageIdentityKey: destination },
            admission: { totalRows, scope: { userId } }
          } as unknown as FixedProfile
          const receipt = { state: 'COMPLETE', nextRow: totalRows } as Brc38ImportJournalReceipt
          const before = JSON.stringify({ user, setting, fixed, receipt })
          await expect(
            verifyBrc38PublishedWalletData(readOnlyRows([user], [setting]), fixed, state, receipt)
          ).resolves.toBeUndefined()
          expect(JSON.stringify({ user, setting, fixed, receipt })).toBe(before)
          for (const changed of [
            { ...user, userId: userId + 1 },
            { ...user, identityKey: identity + ':different' },
            { ...user, activeStorage: 'foreign:' + identity }
          ]) {
            await expect(
              verifyBrc38PublishedWalletData(readOnlyRows([changed], [setting]), fixed, state, receipt)
            ).rejects.toThrow('differs')
          }
          for (const changed of [
            { ...setting, chain: chain === 'main' ? 'test' : 'main' },
            { ...setting, storageIdentityKey: destination + ':different' }
          ]) {
            await expect(
              verifyBrc38PublishedWalletData(readOnlyRows([user], [changed]), fixed, state, receipt)
            ).rejects.toThrow('differs')
          }
          await expect(
            verifyBrc38PublishedWalletData(readOnlyRows([], [setting]), fixed, state, receipt)
          ).rejects.toThrow('differs')
          await expect(
            verifyBrc38PublishedWalletData(readOnlyRows([user, user], [setting]), fixed, state, receipt)
          ).rejects.toThrow('differs')
          await expect(verifyBrc38PublishedWalletData(readOnlyRows([user], []), fixed, state, receipt)).rejects.toThrow(
            'differs'
          )
          await expect(
            verifyBrc38PublishedWalletData(readOnlyRows([user], [setting, setting]), fixed, state, receipt)
          ).rejects.toThrow('differs')
          await expect(
            verifyBrc38PublishedWalletData(readOnlyRows([user], [setting]), fixed, state, {
              ...receipt,
              nextRow: totalRows + 1
            })
          ).rejects.toThrow('differs')
          await expect(
            verifyBrc38PublishedWalletData(readOnlyRows([user], [setting]), fixed, state, {
              ...receipt,
              state: 'IMPORTING'
            } as unknown as Brc38ImportJournalReceipt)
          ).rejects.toThrow('differs')
          if (state === 'READY')
            await expect(
              verifyBrc38PublishedWalletData(
                readOnlyRows([{ ...user, activeStorage: destination }], [setting]),
                fixed,
                state,
                receipt
              )
            ).rejects.toThrow('differs')
          if (state === 'ACTIVE')
            await expect(
              verifyBrc38PublishedWalletData(
                readOnlyRows([{ ...user, activeStorage: '' }], [setting]),
                fixed,
                state,
                receipt
              )
            ).rejects.toThrow('differs')
        }
      ),
      {
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true,
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
      }
    )
  })
})
