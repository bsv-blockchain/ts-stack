import { withBrc38NativeCandidateContractFixture } from './Brc38NativeCandidateContractFixture'
import { verifyBrc38PrivateLocalUniqueKeys } from './Brc38PrivateLocalUniqueNode.case'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import type { IndependentLocalCandidateRow } from './Brc38PrivateLocalCandidateNode.case'
import { writeBrc38NativePackedTextBytes } from './Brc38NativePackedTextFieldsNode'

// Full original coverage cases measured about 176 seconds, leaving almost no
// margin in the default three-minute fixture. Select one fixed whole-case
// lifetime; the extra 30 seconds is only for physical cleanup.
const nativeFixtureLifetimeMs = 300000
const nativeFixtureCaseTimeoutMs = nativeFixtureLifetimeMs + 30000

// UNRUN. These are actual migrated SQLite rows and actual source/candidate
// actors. NULL primary text keys are inactive storage data, not authenticated
// sessions. No index, schema, ownership flag or semantic admission is changed.
test(
  'actual private natural keys distinguish signed reuse, composite edges, same rows, different keys and NULL',
  async () => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        const one = (rows: readonly IndependentLocalCandidateRow[]): IndependentLocalCandidateRow => {
            if (rows.length !== 1) throw new Error('Independent unique fixture requires one original row')
            return rows[0]
          },
          basket = one(fixture.initial.output_baskets),
          certificate = one(fixture.initial.certificates),
          map = one(fixture.initial.tx_labels_map),
          tag = one(fixture.initial.output_tags),
          label = one(fixture.initial.tx_labels),
          physical = (row: IndependentLocalCandidateRow) => ({
            ...row.metadata,
            ...Object.fromEntries(Object.entries(row.fields).map(([key, value]) => [key, value === null ? null : '']))
          })
        await fixture.prepareCopied()
        await fixture.withWriter(async trx => {
          // Preserve existing parent IDs/edges. Reuse their original natural keys
          // under separately authored negative physical IDs instead of disabling FK.
          expect(
            await trx('output_baskets')
              .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(basket.rowId).toString()])
              .update({ name: 'independent displaced basket key' })
          ).toBe(1)
          await trx('output_baskets').insert({ ...physical(basket), basketId: -101 })
          expect(
            await trx('certificates')
              .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(certificate.rowId).toString()])
              .update({ serialNumber: 'independent displaced certificate key' })
          ).toBe(1)
          await trx('certificates').insert({ ...physical(certificate), certificateId: -102 })
          for (const [field, value] of Object.entries(certificate.fields))
            if (value !== null) {
              if (
                field !== 'subject' &&
                field !== 'revocationOutpoint' &&
                field !== 'signature' &&
                field !== 'verifier'
              )
                throw new Error('Independent certificate fixture contains another TEXT field')
              await writeBrc38NativePackedTextBytes(trx, { table: 'certificates', field, rowId: -102 }, value)
            }
          expect(
            await trx('tx_labels_map')
              .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(map.rowId).toString()])
              .update({ rowid: -103 })
          ).toBe(1)
          expect(
            await trx('tx_labels')
              .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(label.rowId).toString()])
              .update({ label: 'independent distinct candidate label' })
          ).toBe(1)
        })
        await verifyBrc38PrivateLocalUniqueKeys({ ...fixture, workingAllocation: fixture.options.workingAllocation }, [
          { table: 'output_baskets', rowId: basket.rowId, conflict: true },
          { table: 'certificates', rowId: certificate.rowId, conflict: true },
          { table: 'tx_labels_map', rowId: map.rowId, conflict: true },
          { table: 'output_tags', rowId: tag.rowId, conflict: false },
          { table: 'tx_labels', rowId: label.rowId, conflict: false },
          { table: 'monitor_events', rowId: 400, conflict: false },
          { table: 'auth_sessions', rowId: -104, conflict: false }
        ])
      },
      {
        lifetimeMs: nativeFixtureLifetimeMs,
        prepareSource: async source => {
          await source.manager.runAsStorageProvider(async active => {
            if (active !== source.storage) throw new Error('Independent NULL-key fixture selected another source')
            await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(source.storage, async writer => {
              await writer('auth_sessions').insert({
                rowid: -104,
                sessionNonce: null,
                peerNonce: null,
                peerIdentityKey: null,
                isAuthenticated: false,
                lastUpdate: 0,
                certificatesRequired: null,
                certificatesValidated: null,
                expiresAt: 0
              })
            })
          })
        }
      }
    )
  },
  nativeFixtureCaseTimeoutMs
)
