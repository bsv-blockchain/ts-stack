'use strict'
const { runPortableBrowserCase } = require('../../../client/test/portable-program-browser.cjs')
const { nativeBrowserTestTimeout } = require('../../../client/test/native-browser-driver.cjs')

// Reuse every original native-browser oracle. The normal browser entry still
// requires the full catalogue. Per-test instrumentation returns only actual
// browser counters; these component passes cannot qualify the process tree.
const cases = [
  [
    'verifyCompleteBrowserRestoreResumeAndIndependentNativeInventory',
    'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts'
  ],
  [
    'verifyCompleteBrowserScalarTextRestoreAndOriginalInventory',
    'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts'
  ],
  [
    'verifyCompleteBrowserRestoreLostAckAndAuthenticatedRefusal',
    'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts'
  ],
  [
    'verifyBrowserProfilePublicationActivationLostAckAndManagerRestart',
    'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts'
  ],
  [
    'verifyBrowserPublicationCurrentChainAndNativeSelectionRefusal',
    'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts'
  ],
  [
    'verifyAuthenticatedBrowserPreviewHasNoDestinationEffectsOrAdmissionGrant',
    'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.browser.case.ts'
  ],
  [
    'verifyBrowserAuthenticationAndCompleteReplay',
    'src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.browser.case.ts'
  ],
  ['verifyBrowserAuthenticationRefusals', 'src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.browser.case.ts'],
  [
    'verifyBrowserAuthenticatedBinaryStaging',
    'src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.browser.case.ts'
  ],
  [
    'verifyBrowserAuthenticatedStructuredStaging',
    'src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.browser.case.ts'
  ],
  [
    'verifyBrowserAuthenticatedScalarTextStagingAndReplay',
    'src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.browser.case.ts'
  ],
  [
    'verifyBrowserLargeAuthenticatedStreamAndReplay',
    'src/storage/portable/Brc38AuthenticatedStreamStageBrowser.browser.case.ts'
  ],
  [
    'verifyBrowserStreamRefusalsAndOriginalSourceClose',
    'src/storage/portable/Brc38AuthenticatedStreamStageBrowser.browser.case.ts'
  ],
  [
    'verifyBrowserStreamScalarTextAndAuthenticationRefusal',
    'src/storage/portable/Brc38AuthenticatedStreamStageBrowser.browser.case.ts'
  ],
  [
    'verifyIdbImportAtomicRollbackLostAckAndOriginalMappings',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyIdbImportRejectsDriftResumeGrowthAndCopiedOwners',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyIdbInactiveHistoryUsesCurrentMappingAndOriginalAllocation',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyIdbImportOriginalWorkingRefusalAndNamespaceDefaults',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyIdbImportRejectsUnawaitedProviderAndMapperEffects',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyIsolatedIdbRestorePreservesHistoricalPolicyAcrossReopen',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyIdbStreamedOriginalReferencesAreAtomicWithRowsAndCheckpoint',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyIdbExpiredOriginalRetirementIsBoundedAndRestartable',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyPackedBrowserSnapshotSourceNegotiationAndReplicaCursorContract',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyExpiredBrowserNamespaceRetirementRequiresOriginalScopeAndNativeState',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyBrowserNamespaceRetirementNeverDeletesCompleteCandidates',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyIdbExpiredCleanupPreservesCompleteAndActivatedProfiles',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyIdbGlobalReferenceMultiplicityQuotaAndOrphanRefusal',
    'src/storage/portable/Brc38IdbImportJournal.browser.case.ts'
  ],
  [
    'verifyPrivateIdbProofCurrentChainAndIndependentHeader',
    'src/storage/portable/Brc38IdbStreamedProof.browser.case.ts'
  ],
  [
    'verifyPrivateIdbProofLateNetworkRetainsOriginalResources',
    'src/storage/portable/Brc38IdbStreamedProof.browser.case.ts'
  ],
  ['verifyPrivateIdbAll13AndReleasedResume', 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts'],
  ['verifyPrivateIdbClaimIsolation', 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts'],
  [
    'verifyPrivateIdbScalarPersistedUtf8AndOwnershipRefusals',
    'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts'
  ],
  ['verifyPrivateIdbRejectsExtraMetadataRecord', 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts'],
  ['verifyPrivateIdbDeletionDrain', 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts'],
  ['verifyExpiredPrivateIdbCleanup', 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts'],
  ['verifyPrivateIdbDeletingRecovery', 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts'],
  ['verifyPrivateIdbStreamedBinaryClosureAndReplay', 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts'],
  ['verifyPrivateIdbBinaryReplayAndQuotaRefusal', 'src/storage/portable/Brc38PrivateIdbStage.browser.case.ts'],
  [
    'verifyBrowserStructuredClosureDuplicateSelectionAndReplay',
    'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts'
  ],
  ['verifyBrowserStructuredVisibleNullRefusal', 'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts'],
  ['verifyBrowserStructuredStaleIndexRetirement', 'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts'],
  [
    'verifyBrowserLargeHistoryProjectionAndCurrentJournal',
    'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts'
  ],
  [
    'verifyBrowserStructuredReaderRevocationAndOriginalLimit',
    'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts'
  ],
  ['verifyBrowserLargeOriginalAndMappedUtf16Staging', 'src/storage/portable/Brc38PrivateIdbStructured.browser.case.ts'],
  ['verifyBrowserOwnedSmallEnvelopeAndRefusal', 'src/storage/portable/Brc39OwnedBrowserEnvelope.browser.case.ts'],
  ['verifyBrowserStreamExportIndependentLegacyDecoder', 'src/storage/portable/Brc39StreamBrowser.browser.case.ts'],
  [
    'verifyBrowserStreamExportSemanticFailureAndCancellation',
    'src/storage/portable/Brc39StreamBrowser.browser.case.ts'
  ],
  ['verifyBrowserIncrementalGcmIndependentOracles', 'src/storage/portable/Brc39WebCryptoGcm.browser.case.ts'],
  ['verifyBrowserIncrementalGcmRefusals', 'src/storage/portable/Brc39WebCryptoGcm.browser.case.ts'],
  ['verifyBrowserIncrementalEncryptionIndependentOracles', 'src/storage/portable/Brc39WebCryptoGcm.browser.case.ts'],
  ['verifyIdbSnapshotSyncCertificateFields', 'src/storage/snapshot/IdbSnapshotSyncCertificateFields.browser.case.ts'],
  ['verifyOccupiedPackedIdbSnapshotJournal', 'src/storage/snapshot/IdbSnapshotSyncJournal.browser.case.ts'],
  ['verifyIdbSnapshotSyncProvenTxReqs', 'src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.browser.case.ts'],
  ['verifyIdbSnapshotSyncProvenTxs', 'src/storage/snapshot/IdbSnapshotSyncProvenTxs.browser.case.ts'],
  ['verifyPackedIdbCurrentRowAndExtentMetadata', 'src/storage/snapshot/PackedIdbCurrentMetadata.browser.case.ts'],
  ['verifyOccupiedPackedIdbStructuredField', 'src/storage/snapshot/PackedIdbCurrentStructuredRead.browser.case.ts'],
  ['verifyOccupiedPackedIdbHistoryStaging', 'src/storage/snapshot/PackedIdbCurrentStructuredRead.browser.case.ts'],
  ['verifyPackedIdbBoundedNaturalMergeLookup', 'src/storage/snapshot/PackedIdbMergeLookup.browser.case.ts'],
  [
    'verifyPackedIdbReplicaFieldOrderingAndRetainedExtents',
    'src/storage/snapshot/PackedIdbSyncFieldSource.browser.case.ts'
  ],
  ['verifyBrowserArgon2Worker', 'src/utility/BrowserArgon2idWorker.browser.case.ts']
]
for (const [id, source] of cases) {
  test(
    `native browser component: ${id}`,
    async () => {
      const result = await runPortableBrowserCase(id)
      expect(result.reports).toHaveLength(1)
      expect(result.reports[0]).toMatchObject({ id, source, passed: true })
      expect(result.browserChildClose).toEqual({ code: 0, signal: null })
      expect(result.completeCatalogueRun).toBe(false)
      expect(result.processTreeQualified).toBe(false)
    },
    nativeBrowserTestTimeout(id)
  )
}
