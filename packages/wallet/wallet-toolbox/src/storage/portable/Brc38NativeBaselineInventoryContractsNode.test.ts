import { nativeTestExecutable } from './Brc38NativeTestPath'
import { composedFixtureChain, withComposedNativeFixture } from './Brc38ComposedNativeFixture'
import { seedComposedAuxiliaryFixture, assertComposedAuxiliaryFixture } from './Brc38ComposedAuxiliaryFixture'
import { withComposedFixtureRead } from './Brc38ComposedSemanticFixture'
import {
  readIndependentNativeInventory,
  readIndependentNativePriorInventory,
  wipeIndependentNativeInventory
} from './Brc38IndependentNativeInventoryFixture'
import { verifyBrc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode.case'
import { verifyBrc38NativePriorImportSource } from './Brc38NativePriorImportSourceNode.case'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'

// Admit the existing 180-second fixture owner plus 30 seconds of cleanup.
const nativeFixtureCaseTimeoutMs = 180000 + 30000

// UNRUN. Public fixture APIs populate real restored/published WAL owners;
// independent bounded SQL reads precede the source under test. No source row,
// descriptor, point hash or old receipt generates an expected postimage.
test(
  'all48 native local source tables retain independently read typed metadata and complete logical bytes',
  async () => {
    await withComposedNativeFixture(async fixture => {
      const auxiliary = await seedComposedAuxiliaryFixture(fixture.storage, fixture.manager)
      await assertComposedAuxiliaryFixture(fixture.manager, auxiliary)
      const expected = await withComposedFixtureRead(fixture.manager, readIndependentNativeInventory)
      try {
        expect(Object.keys(expected)).toHaveLength(48)
        for (const rows of Object.values(expected)) expect(rows.length).toBeGreaterThan(0)
        const user = fixture.manager.getActiveUser()
        await verifyBrc38NativeLocalBaselineSource(
          fixture.storage,
          {
            identityKey: user.identityKey,
            chain: composedFixtureChain(fixture.storage),
            targetStorageIdentityKey: fixture.manager.getActiveStore(),
            mode: 'merge'
          },
          previewReceiptPolicy,
          {
            maximumMetadataBytes: 65536,
            maximumReadBytes: 1024,
            expiresAt: fixture.expiresAt,
            workingAllocation: fixture.merge.workingAllocation
          },
          expected
        )
        await assertComposedAuxiliaryFixture(fixture.manager, auxiliary)
      } finally {
        wipeIndependentNativeInventory(expected)
      }
    }, nativeTestExecutable())
  },
  nativeFixtureCaseTimeoutMs
)

test(
  'all18 native prior-import families retain complete independent raw bytes and explicit empty inventories',
  async () => {
    await withComposedNativeFixture(async fixture => {
      const expected = await withComposedFixtureRead(fixture.manager, readIndependentNativePriorInventory),
        user = fixture.manager.getActiveUser()
      try {
        expect(Object.keys(expected)).toHaveLength(18)
        expect(expected.brc38_import_structured_original!.length).toBeGreaterThan(0)
        expect(expected.private_binary_chunks!.length).toBeGreaterThan(0)
        expect(expected.private_structured_chunks!.length).toBeGreaterThan(0)
        await verifyBrc38NativePriorImportSource(
          fixture.storage,
          {
            identityKey: user.identityKey,
            chain: composedFixtureChain(fixture.storage),
            targetStorageIdentityKey: fixture.manager.getActiveStore(),
            mode: 'merge'
          },
          previewReceiptPolicy,
          {
            maximumMetadataBytes: 65536,
            maximumReadBytes: 1024,
            expiresAt: fixture.expiresAt,
            workingAllocation: fixture.merge.workingAllocation
          },
          expected
        )
      } finally {
        for (const rows of Object.values(expected))
          for (const row of rows ?? []) {
            row.field?.fill(0)
            for (const value of Object.values(row.metadata)) if (value instanceof Uint8Array) value.fill(0)
          }
      }
    }, nativeTestExecutable())
  },
  nativeFixtureCaseTimeoutMs
)
