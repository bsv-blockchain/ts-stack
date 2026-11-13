import { verifyPackedIdbSnapshotContentReceipts } from '../../src/storage/snapshot/IdbSnapshotSyncContent.browser.case'
const { nativeBrowserCaseTimeout } = require('./native-browser-budgets.cjs')
// Authored UNRUN. Every current exported native-browser case is selected
// explicitly. A fresh native browser/controller/resource agreement is required
// before executing this catalogue; fake IDB does not qualify it.
import {
  verifyCompleteBrowserRestoreResumeAndIndependentNativeInventory,
  verifyCompleteBrowserScalarTextRestoreAndOriginalInventory,
  verifyCompleteBrowserRestoreLostAckAndAuthenticatedRefusal,
  verifyBrowserProfilePublicationActivationLostAckAndManagerRestart,
  verifyBrowserPublicationCurrentChainAndNativeSelectionRefusal,
  verifyAuthenticatedBrowserPreviewHasNoDestinationEffectsOrAdmissionGrant
} from '../../src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case'
import {
  verifyBrowserAuthenticationAndCompleteReplay,
  verifyBrowserAuthenticationRefusals,
  verifyBrowserAuthenticatedBinaryStaging,
  verifyBrowserAuthenticatedStructuredStaging,
  verifyBrowserAuthenticatedScalarTextStagingAndReplay
} from '../../src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.browser.case'
import {
  verifyBrowserLargeAuthenticatedStreamAndReplay,
  verifyBrowserStreamRefusalsAndOriginalSourceClose,
  verifyBrowserStreamScalarTextAndAuthenticationRefusal
} from '../../src/storage/portable/Brc38AuthenticatedStreamStageBrowser.browser.case'
import {
  verifyIdbImportAtomicRollbackLostAckAndOriginalMappings,
  verifyIdbImportRejectsDriftResumeGrowthAndCopiedOwners,
  verifyIdbInactiveHistoryUsesCurrentMappingAndOriginalAllocation,
  verifyIdbImportOriginalWorkingRefusalAndNamespaceDefaults,
  verifyIdbImportRejectsUnawaitedProviderAndMapperEffects,
  verifyIsolatedIdbRestorePreservesHistoricalPolicyAcrossReopen,
  verifyIdbStreamedOriginalReferencesAreAtomicWithRowsAndCheckpoint,
  verifyIdbExpiredOriginalRetirementIsBoundedAndRestartable,
  verifyPackedBrowserSnapshotSourceNegotiationAndReplicaCursorContract,
  verifyExpiredBrowserNamespaceRetirementRequiresOriginalScopeAndNativeState,
  verifyBrowserNamespaceRetirementNeverDeletesCompleteCandidates,
  verifyIdbExpiredCleanupPreservesCompleteAndActivatedProfiles,
  verifyIdbGlobalReferenceMultiplicityQuotaAndOrphanRefusal
} from '../../src/storage/portable/Brc38IdbImportJournal.browser.case'
import {
  verifyPrivateIdbProofCurrentChainAndIndependentHeader,
  verifyPrivateIdbProofLateNetworkRetainsOriginalResources
} from '../../src/storage/portable/Brc38IdbStreamedProof.browser.case'
import {
  verifyPrivateIdbAll13AndReleasedResume,
  verifyPrivateIdbClaimIsolation,
  verifyPrivateIdbScalarPersistedUtf8AndOwnershipRefusals,
  verifyPrivateIdbRejectsExtraMetadataRecord,
  verifyPrivateIdbDeletionDrain,
  verifyExpiredPrivateIdbCleanup,
  verifyPrivateIdbDeletingRecovery,
  verifyPrivateIdbStreamedBinaryClosureAndReplay,
  verifyPrivateIdbBinaryReplayAndQuotaRefusal
} from '../../src/storage/portable/Brc38PrivateIdbStage.browser.case'
import {
  verifyBrowserStructuredClosureDuplicateSelectionAndReplay,
  verifyBrowserStructuredVisibleNullRefusal,
  verifyBrowserStructuredStaleIndexRetirement,
  verifyBrowserLargeHistoryProjectionAndCurrentJournal,
  verifyBrowserStructuredReaderRevocationAndOriginalLimit,
  verifyBrowserLargeOriginalAndMappedUtf16Staging
} from '../../src/storage/portable/Brc38PrivateIdbStructured.browser.case'
import { verifyBrowserOwnedSmallEnvelopeAndRefusal } from '../../src/storage/portable/Brc39OwnedBrowserEnvelope.browser.case'
import {
  verifyBrowserStreamExportIndependentLegacyDecoder,
  verifyBrowserStreamExportSemanticFailureAndCancellation
} from '../../src/storage/portable/Brc39StreamBrowser.browser.case'
import {
  verifyBrowserIncrementalGcmIndependentOracles,
  verifyBrowserIncrementalGcmRefusals,
  verifyBrowserIncrementalEncryptionIndependentOracles
} from '../../src/storage/portable/Brc39WebCryptoGcm.browser.case'
import { verifyIdbSnapshotSyncCertificateFields } from '../../src/storage/snapshot/IdbSnapshotSyncCertificateFields.browser.case'
import { verifyOccupiedPackedIdbSnapshotJournal } from '../../src/storage/snapshot/IdbSnapshotSyncJournal.browser.case'
import { verifyIdbSnapshotSyncProvenTxReqs } from '../../src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.browser.case'
import { verifyIdbSnapshotSyncProvenTxs } from '../../src/storage/snapshot/IdbSnapshotSyncProvenTxs.browser.case'
import { verifyPackedIdbCurrentRowAndExtentMetadata } from '../../src/storage/snapshot/PackedIdbCurrentMetadata.browser.case'
import {
  verifyOccupiedPackedIdbStructuredField,
  verifyOccupiedPackedIdbHistoryStaging
} from '../../src/storage/snapshot/PackedIdbCurrentStructuredRead.browser.case'
import { verifyPackedIdbBoundedNaturalMergeLookup } from '../../src/storage/snapshot/PackedIdbMergeLookup.browser.case'
import { verifyPackedIdbReplicaFieldOrderingAndRetainedExtents } from '../../src/storage/snapshot/PackedIdbSyncFieldSource.browser.case'
import { verifyBrowserArgon2Worker } from '../../src/utility/BrowserArgon2idWorker.browser.case'

const trustedWorker = (): Worker => new Worker(new URL('/argon-worker.js', location.origin), { type: 'module' })
export const portableBrowserCases: ReadonlyArray<Readonly<{ id: string; source: string; run: () => Promise<void> }>> =
  Object.freeze([
    Object.freeze({
      id: 'verifyCompleteBrowserRestoreResumeAndIndependentNativeInventory',
      source: 'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts',
      run: async () => await verifyCompleteBrowserRestoreResumeAndIndependentNativeInventory()
    }),
    Object.freeze({
      id: 'verifyCompleteBrowserScalarTextRestoreAndOriginalInventory',
      source: 'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts',
      run: async () => await verifyCompleteBrowserScalarTextRestoreAndOriginalInventory()
    }),
    Object.freeze({
      id: 'verifyCompleteBrowserRestoreLostAckAndAuthenticatedRefusal',
      source: 'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts',
      run: async () => await verifyCompleteBrowserRestoreLostAckAndAuthenticatedRefusal()
    }),
    Object.freeze({
      id: 'verifyBrowserProfilePublicationActivationLostAckAndManagerRestart',
      source: 'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts',
      run: async () => await verifyBrowserProfilePublicationActivationLostAckAndManagerRestart()
    }),
    Object.freeze({
      id: 'verifyBrowserPublicationCurrentChainAndNativeSelectionRefusal',
      source: 'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts',
      run: async () => await verifyBrowserPublicationCurrentChainAndNativeSelectionRefusal()
    }),
    Object.freeze({
      id: 'verifyAuthenticatedBrowserPreviewHasNoDestinationEffectsOrAdmissionGrant',
      source: 'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts',
      run: async () => await verifyAuthenticatedBrowserPreviewHasNoDestinationEffectsOrAdmissionGrant()
    }),
    Object.freeze({
      id: 'verifyBrowserAuthenticationAndCompleteReplay',
      source: 'src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.browser.case.ts',
      run: async () => await verifyBrowserAuthenticationAndCompleteReplay()
    }),
    Object.freeze({
      id: 'verifyBrowserAuthenticationRefusals',
      source: 'src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.browser.case.ts',
      run: async () => await verifyBrowserAuthenticationRefusals()
    }),
    Object.freeze({
      id: 'verifyBrowserAuthenticatedBinaryStaging',
      source: 'src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.browser.case.ts',
      run: async () => await verifyBrowserAuthenticatedBinaryStaging()
    }),
    Object.freeze({
      id: 'verifyBrowserAuthenticatedStructuredStaging',
      source: 'src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.browser.case.ts',
      run: async () => await verifyBrowserAuthenticatedStructuredStaging()
    }),
    Object.freeze({
      id: 'verifyBrowserAuthenticatedScalarTextStagingAndReplay',
      source: 'src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.browser.case.ts',
      run: async () => await verifyBrowserAuthenticatedScalarTextStagingAndReplay()
    }),
    Object.freeze({
      id: 'verifyBrowserLargeAuthenticatedStreamAndReplay',
      source: 'src/storage/portable/Brc38AuthenticatedStreamStageBrowser.browser.case.ts',
      run: async () => await verifyBrowserLargeAuthenticatedStreamAndReplay()
    }),
    Object.freeze({
      id: 'verifyBrowserStreamRefusalsAndOriginalSourceClose',
      source: 'src/storage/portable/Brc38AuthenticatedStreamStageBrowser.browser.case.ts',
      run: async () => await verifyBrowserStreamRefusalsAndOriginalSourceClose()
    }),
    Object.freeze({
      id: 'verifyBrowserStreamScalarTextAndAuthenticationRefusal',
      source: 'src/storage/portable/Brc38AuthenticatedStreamStageBrowser.browser.case.ts',
      run: async () => await verifyBrowserStreamScalarTextAndAuthenticationRefusal()
    }),
    Object.freeze({
      id: 'verifyIdbImportAtomicRollbackLostAckAndOriginalMappings',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyIdbImportAtomicRollbackLostAckAndOriginalMappings()
    }),
    Object.freeze({
      id: 'verifyIdbImportRejectsDriftResumeGrowthAndCopiedOwners',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyIdbImportRejectsDriftResumeGrowthAndCopiedOwners()
    }),
    Object.freeze({
      id: 'verifyIdbInactiveHistoryUsesCurrentMappingAndOriginalAllocation',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyIdbInactiveHistoryUsesCurrentMappingAndOriginalAllocation()
    }),
    Object.freeze({
      id: 'verifyIdbImportOriginalWorkingRefusalAndNamespaceDefaults',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyIdbImportOriginalWorkingRefusalAndNamespaceDefaults()
    }),
    Object.freeze({
      id: 'verifyIdbImportRejectsUnawaitedProviderAndMapperEffects',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyIdbImportRejectsUnawaitedProviderAndMapperEffects()
    }),
    Object.freeze({
      id: 'verifyIsolatedIdbRestorePreservesHistoricalPolicyAcrossReopen',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyIsolatedIdbRestorePreservesHistoricalPolicyAcrossReopen()
    }),
    Object.freeze({
      id: 'verifyIdbStreamedOriginalReferencesAreAtomicWithRowsAndCheckpoint',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyIdbStreamedOriginalReferencesAreAtomicWithRowsAndCheckpoint()
    }),
    Object.freeze({
      id: 'verifyIdbExpiredOriginalRetirementIsBoundedAndRestartable',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyIdbExpiredOriginalRetirementIsBoundedAndRestartable()
    }),
    Object.freeze({
      id: 'verifyPackedBrowserSnapshotSourceNegotiationAndReplicaCursorContract',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyPackedBrowserSnapshotSourceNegotiationAndReplicaCursorContract()
    }),
    Object.freeze({
      id: 'verifyExpiredBrowserNamespaceRetirementRequiresOriginalScopeAndNativeState',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyExpiredBrowserNamespaceRetirementRequiresOriginalScopeAndNativeState()
    }),
    Object.freeze({
      id: 'verifyBrowserNamespaceRetirementNeverDeletesCompleteCandidates',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyBrowserNamespaceRetirementNeverDeletesCompleteCandidates()
    }),
    Object.freeze({
      id: 'verifyIdbExpiredCleanupPreservesCompleteAndActivatedProfiles',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyIdbExpiredCleanupPreservesCompleteAndActivatedProfiles()
    }),
    Object.freeze({
      id: 'verifyIdbGlobalReferenceMultiplicityQuotaAndOrphanRefusal',
      source: 'src/storage/portable/Brc38IdbImportJournal.browser.case.ts',
      run: async () => await verifyIdbGlobalReferenceMultiplicityQuotaAndOrphanRefusal()
    }),
    Object.freeze({
      id: 'verifyPrivateIdbProofCurrentChainAndIndependentHeader',
      source: 'src/storage/portable/Brc38IdbStreamedProof.browser.case.ts',
      run: async () => await verifyPrivateIdbProofCurrentChainAndIndependentHeader()
    }),
    Object.freeze({
      id: 'verifyPrivateIdbProofLateNetworkRetainsOriginalResources',
      source: 'src/storage/portable/Brc38IdbStreamedProof.browser.case.ts',
      run: async () => await verifyPrivateIdbProofLateNetworkRetainsOriginalResources()
    }),
    Object.freeze({
      id: 'verifyPrivateIdbAll13AndReleasedResume',
      source: 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts',
      run: async () => await verifyPrivateIdbAll13AndReleasedResume()
    }),
    Object.freeze({
      id: 'verifyPrivateIdbClaimIsolation',
      source: 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts',
      run: async () => await verifyPrivateIdbClaimIsolation()
    }),
    Object.freeze({
      id: 'verifyPrivateIdbScalarPersistedUtf8AndOwnershipRefusals',
      source: 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts',
      run: async () => await verifyPrivateIdbScalarPersistedUtf8AndOwnershipRefusals()
    }),
    Object.freeze({
      id: 'verifyPrivateIdbRejectsExtraMetadataRecord',
      source: 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts',
      run: async () => await verifyPrivateIdbRejectsExtraMetadataRecord()
    }),
    Object.freeze({
      id: 'verifyPrivateIdbDeletionDrain',
      source: 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts',
      run: async () => await verifyPrivateIdbDeletionDrain()
    }),
    Object.freeze({
      id: 'verifyExpiredPrivateIdbCleanup',
      source: 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts',
      run: async () => await verifyExpiredPrivateIdbCleanup()
    }),
    Object.freeze({
      id: 'verifyPrivateIdbDeletingRecovery',
      source: 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts',
      run: async () => await verifyPrivateIdbDeletingRecovery()
    }),
    Object.freeze({
      id: 'verifyPrivateIdbStreamedBinaryClosureAndReplay',
      source: 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts',
      run: async () => await verifyPrivateIdbStreamedBinaryClosureAndReplay()
    }),
    Object.freeze({
      id: 'verifyPrivateIdbBinaryReplayAndQuotaRefusal',
      source: 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts',
      run: async () => await verifyPrivateIdbBinaryReplayAndQuotaRefusal()
    }),
    Object.freeze({
      id: 'verifyBrowserStructuredClosureDuplicateSelectionAndReplay',
      source: 'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts',
      run: async () => await verifyBrowserStructuredClosureDuplicateSelectionAndReplay()
    }),
    Object.freeze({
      id: 'verifyBrowserStructuredVisibleNullRefusal',
      source: 'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts',
      run: async () => await verifyBrowserStructuredVisibleNullRefusal()
    }),
    Object.freeze({
      id: 'verifyBrowserStructuredStaleIndexRetirement',
      source: 'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts',
      run: async () => await verifyBrowserStructuredStaleIndexRetirement()
    }),
    Object.freeze({
      id: 'verifyBrowserLargeHistoryProjectionAndCurrentJournal',
      source: 'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts',
      run: async () => await verifyBrowserLargeHistoryProjectionAndCurrentJournal()
    }),
    Object.freeze({
      id: 'verifyBrowserStructuredReaderRevocationAndOriginalLimit',
      source: 'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts',
      run: async () => await verifyBrowserStructuredReaderRevocationAndOriginalLimit()
    }),
    Object.freeze({
      id: 'verifyBrowserLargeOriginalAndMappedUtf16Staging',
      source: 'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts',
      run: async () => await verifyBrowserLargeOriginalAndMappedUtf16Staging()
    }),
    Object.freeze({
      id: 'verifyBrowserOwnedSmallEnvelopeAndRefusal',
      source: 'src/storage/portable/Brc39OwnedBrowserEnvelope.browser.case.ts',
      run: async () => await verifyBrowserOwnedSmallEnvelopeAndRefusal()
    }),
    Object.freeze({
      id: 'verifyBrowserStreamExportIndependentLegacyDecoder',
      source: 'src/storage/portable/Brc39StreamBrowser.browser.case.ts',
      run: async () => await verifyBrowserStreamExportIndependentLegacyDecoder(trustedWorker)
    }),
    Object.freeze({
      id: 'verifyBrowserStreamExportSemanticFailureAndCancellation',
      source: 'src/storage/portable/Brc39StreamBrowser.browser.case.ts',
      run: async () => await verifyBrowserStreamExportSemanticFailureAndCancellation()
    }),
    Object.freeze({
      id: 'verifyBrowserIncrementalGcmIndependentOracles',
      source: 'src/storage/portable/Brc39WebCryptoGcm.browser.case.ts',
      run: async () => await verifyBrowserIncrementalGcmIndependentOracles()
    }),
    Object.freeze({
      id: 'verifyBrowserIncrementalGcmRefusals',
      source: 'src/storage/portable/Brc39WebCryptoGcm.browser.case.ts',
      run: async () => await verifyBrowserIncrementalGcmRefusals()
    }),
    Object.freeze({
      id: 'verifyBrowserIncrementalEncryptionIndependentOracles',
      source: 'src/storage/portable/Brc39WebCryptoGcm.browser.case.ts',
      run: async () => await verifyBrowserIncrementalEncryptionIndependentOracles()
    }),
    Object.freeze({
      id: 'verifyIdbSnapshotSyncCertificateFields',
      source: 'src/storage/snapshot/IdbSnapshotSyncCertificateFields.browser.case.ts',
      run: async () => await verifyIdbSnapshotSyncCertificateFields(Date.now() + 30000)
    }),
    Object.freeze({
      id: 'verifyPackedIdbSnapshotContentReceipts',
      source: 'src/storage/snapshot/IdbSnapshotSyncContent.browser.case.ts',
      run: async () => await verifyPackedIdbSnapshotContentReceipts(Date.now() + 30000)
    }),
    Object.freeze({
      id: 'verifyOccupiedPackedIdbSnapshotJournal',
      source: 'src/storage/snapshot/IdbSnapshotSyncJournal.browser.case.ts',
      run: async () => await verifyOccupiedPackedIdbSnapshotJournal(Date.now() + 30000)
    }),
    Object.freeze({
      id: 'verifyIdbSnapshotSyncProvenTxReqs',
      source: 'src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.browser.case.ts',
      run: async () =>
        await verifyIdbSnapshotSyncProvenTxReqs(
          Date.now() + nativeBrowserCaseTimeout('verifyIdbSnapshotSyncProvenTxReqs')
        )
    }),
    Object.freeze({
      id: 'verifyIdbSnapshotSyncProvenTxs',
      source: 'src/storage/snapshot/IdbSnapshotSyncProvenTxs.browser.case.ts',
      run: async () => await verifyIdbSnapshotSyncProvenTxs(Date.now() + 30000)
    }),
    Object.freeze({
      id: 'verifyPackedIdbCurrentRowAndExtentMetadata',
      source: 'src/storage/snapshot/PackedIdbCurrentMetadata.browser.case.ts',
      run: async () => await verifyPackedIdbCurrentRowAndExtentMetadata(Date.now() + 30000)
    }),
    Object.freeze({
      id: 'verifyOccupiedPackedIdbStructuredField',
      source: 'src/storage/snapshot/PackedIdbCurrentStructuredRead.browser.case.ts',
      run: async () => await verifyOccupiedPackedIdbStructuredField(Date.now() + 30000)
    }),
    Object.freeze({
      id: 'verifyOccupiedPackedIdbHistoryStaging',
      source: 'src/storage/snapshot/PackedIdbCurrentStructuredRead.browser.case.ts',
      run: async () => await verifyOccupiedPackedIdbHistoryStaging()
    }),
    Object.freeze({
      id: 'verifyPackedIdbBoundedNaturalMergeLookup',
      source: 'src/storage/snapshot/PackedIdbMergeLookup.browser.case.ts',
      run: async () => await verifyPackedIdbBoundedNaturalMergeLookup(Date.now() + 30000)
    }),
    Object.freeze({
      id: 'verifyPackedIdbReplicaFieldOrderingAndRetainedExtents',
      source: 'src/storage/snapshot/PackedIdbSyncFieldSource.browser.case.ts',
      run: async () => await verifyPackedIdbReplicaFieldOrderingAndRetainedExtents(Date.now() + 30000)
    }),
    Object.freeze({
      id: 'verifyBrowserArgon2Worker',
      source: 'src/utility/BrowserArgon2idWorker.browser.case.ts',
      run: async () => await verifyBrowserArgon2Worker(trustedWorker)
    })
  ])
Object.defineProperty(globalThis, 'portableBrowserProgram', {
  value: Object.freeze({
    cases: Object.freeze(portableBrowserCases.map(({ id, source }) => Object.freeze({ id, source }))),
    run: async (id: string): Promise<void> => {
      const entry = portableBrowserCases.find(value => value.id === id)
      if (entry === undefined) throw new Error('Unregistered native browser case')
      await entry.run()
    }
  }),
  configurable: false,
  writable: false
})
