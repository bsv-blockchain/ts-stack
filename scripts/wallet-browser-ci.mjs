#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = fileURLToPath(new URL('..', import.meta.url))
const gitExecutable =
  process.platform === 'win32' ? String.raw`C:\Program Files\Git\cmd\git.exe` : '/usr/bin/git'
const componentIds = [
  'verifyCompleteBrowserRestoreResumeAndIndependentNativeInventory',
  'verifyCompleteBrowserScalarTextRestoreAndOriginalInventory',
  'verifyCompleteBrowserRestoreLostAckAndAuthenticatedRefusal',
  'verifyBrowserProfilePublicationActivationLostAckAndManagerRestart',
  'verifyBrowserPublicationCurrentChainAndNativeSelectionRefusal',
  'verifyAuthenticatedBrowserPreviewHasNoDestinationEffectsOrAdmissionGrant',
  'verifyBrowserAuthenticationAndCompleteReplay',
  'verifyBrowserAuthenticationRefusals',
  'verifyBrowserAuthenticatedBinaryStaging',
  'verifyBrowserAuthenticatedStructuredStaging',
  'verifyBrowserAuthenticatedScalarTextStagingAndReplay',
  'verifyBrowserLargeAuthenticatedStreamAndReplay',
  'verifyBrowserStreamRefusalsAndOriginalSourceClose',
  'verifyBrowserStreamScalarTextAndAuthenticationRefusal',
  'verifyIdbImportAtomicRollbackLostAckAndOriginalMappings',
  'verifyIdbImportRejectsDriftResumeGrowthAndCopiedOwners',
  'verifyIdbInactiveHistoryUsesCurrentMappingAndOriginalAllocation',
  'verifyIdbImportOriginalWorkingRefusalAndNamespaceDefaults',
  'verifyIdbImportRejectsUnawaitedProviderAndMapperEffects',
  'verifyIsolatedIdbRestorePreservesHistoricalPolicyAcrossReopen',
  'verifyIdbStreamedOriginalReferencesAreAtomicWithRowsAndCheckpoint',
  'verifyIdbExpiredOriginalRetirementIsBoundedAndRestartable',
  'verifyPackedBrowserSnapshotSourceNegotiationAndReplicaCursorContract',
  'verifyExpiredBrowserNamespaceRetirementRequiresOriginalScopeAndNativeState',
  'verifyBrowserNamespaceRetirementNeverDeletesCompleteCandidates',
  'verifyIdbExpiredCleanupPreservesCompleteAndActivatedProfiles',
  'verifyIdbGlobalReferenceMultiplicityQuotaAndOrphanRefusal',
  'verifyPrivateIdbProofCurrentChainAndIndependentHeader',
  'verifyPrivateIdbProofLateNetworkRetainsOriginalResources',
  'verifyPrivateIdbAll13AndReleasedResume',
  'verifyPrivateIdbClaimIsolation',
  'verifyPrivateIdbScalarPersistedUtf8AndOwnershipRefusals',
  'verifyPrivateIdbRejectsExtraMetadataRecord',
  'verifyPrivateIdbDeletionDrain',
  'verifyExpiredPrivateIdbCleanup',
  'verifyPrivateIdbDeletingRecovery',
  'verifyPrivateIdbStreamedBinaryClosureAndReplay',
  'verifyPrivateIdbBinaryReplayAndQuotaRefusal',
  'verifyBrowserStructuredClosureDuplicateSelectionAndReplay',
  'verifyBrowserStructuredVisibleNullRefusal',
  'verifyBrowserStructuredStaleIndexRetirement',
  'verifyBrowserLargeHistoryProjectionAndCurrentJournal',
  'verifyBrowserStructuredReaderRevocationAndOriginalLimit',
  'verifyBrowserLargeOriginalAndMappedUtf16Staging',
  'verifyBrowserOwnedSmallEnvelopeAndRefusal',
  'verifyBrowserStreamExportIndependentLegacyDecoder',
  'verifyBrowserStreamExportSemanticFailureAndCancellation',
  'verifyBrowserIncrementalGcmIndependentOracles',
  'verifyBrowserIncrementalGcmRefusals',
  'verifyBrowserIncrementalEncryptionIndependentOracles',
  'verifyIdbSnapshotSyncCertificateFields',
  'verifyPackedIdbSnapshotContentReceipts',
  'verifyOccupiedPackedIdbSnapshotJournal',
  'verifyIdbSnapshotSyncProvenTxReqs',
  'verifyIdbSnapshotSyncProvenTxs',
  'verifyPackedIdbCurrentRowAndExtentMetadata',
  'verifyOccupiedPackedIdbStructuredField',
  'verifyOccupiedPackedIdbHistoryStaging',
  'verifyPackedIdbBoundedNaturalMergeLookup',
  'verifyPackedIdbReplicaFieldOrderingAndRetainedExtents',
  'verifyBrowserArgon2Worker'
]
const wallet = 'packages/wallet/wallet-toolbox/'
export const walletBrowserSuites = Object.freeze(
  [
    {
      file: wallet + 'src/storage/portable/Brc38NativeBrowserComponents.test.cjs',
      names: componentIds.map(id => `native browser component: ${id}`)
    },
    {
      file: wallet + 'src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts',
      names: [
        'occupied packed TEXT reads retain the original session, current row and resource owner',
        'occupied history preparation stages the exact legacy UTF16 bytes without destination effects'
      ]
    },
    {
      file: wallet + 'src/utility/BrowserArgon2idWorker.native.test.cjs',
      names: ['actual dedicated workers preserve original KDF/cancellation and per-test coverage']
    }
  ].map(value => Object.freeze({ ...value, names: Object.freeze(value.names) }))
)
const caseCount = 64
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const ordered = values =>
  [...values].sort((left, right) => Number(left > right) - Number(left < right))

export function validateWalletBrowserReport(report) {
  if (
    report?.success !== true ||
    report.numTotalTestSuites !== 3 ||
    report.numPassedTestSuites !== 3 ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTestSuites !== 0 ||
    report.numRuntimeErrorTestSuites !== 0 ||
    report.numTotalTests !== caseCount ||
    report.numPassedTests !== caseCount ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== 3
  )
    throw new Error('Browser report lacks all original three suites and64 passed cases')
  const seen = new Set()
  for (const suite of report.testResults) {
    const expected = walletBrowserSuites.find(
      value =>
        typeof suite?.name === 'string' &&
        suite.name.replaceAll('\\', '/').endsWith('/' + value.file)
    )
    if (
      expected === undefined ||
      seen.has(expected.file) ||
      suite.status !== 'passed' ||
      suite.message !== '' ||
      !Array.isArray(suite.assertionResults) ||
      !isDeepStrictEqual(
        ordered(suite.assertionResults.map(value => value.fullName)),
        ordered(expected.names)
      ) ||
      suite.assertionResults.some(
        value =>
          value.status !== 'passed' ||
          !Array.isArray(value.failureMessages) ||
          value.failureMessages.length !== 0
      )
    )
      throw new Error(
        'Browser suite failed, repeated, skipped or changed its original case inventory'
      )
    seen.add(expected.file)
  }
  return caseCount
}

export function validateWalletBrowserEvidence(receipt, identity, reportBytes, lcovBytes) {
  if (
    !isDeepStrictEqual(receipt?.identity, identity) ||
    receipt?.passedCases !== caseCount ||
    receipt?.reportSha256 !== digest(reportBytes) ||
    receipt?.lcovSha256 !== digest(lcovBytes) ||
    lcovBytes.length === 0 ||
    !lcovBytes.toString('utf8').includes('end_of_record')
  )
    throw new Error('Browser evidence is stale, incomplete or changed')
  return validateWalletBrowserReport(JSON.parse(reportBytes.toString('utf8')))
}

function executionIdentity() {
  const head = execFileSync(gitExecutable, ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  const files = [
    ...walletBrowserSuites.map(value => value.file),
    'scripts/wallet-browser-ci.mjs',
    '.github/workflows/ci.yml'
  ]
  if (
    !/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '') ||
    process.env.GITHUB_SHA !== head ||
    execFileSync(gitExecutable, ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8'
    }).trim() !== ''
  )
    throw new Error('Browser receipt requires the clean exact GitHub Actions revision and run')
  execFileSync(gitExecutable, ['ls-files', '--error-unmatch', '--', ...files], {
    cwd: root,
    stdio: 'pipe'
  })
  return {
    head,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    sources: Object.fromEntries(
      files.map(file => [file, digest(fs.readFileSync(path.join(root, file)))])
    )
  }
}

function receiptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return receiptFiles(filename)
    return entry.isFile() && entry.name.endsWith('.wallet-browser.json') ? [filename] : []
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'capture' && args.length === 3) {
      const bytes = fs.readFileSync(args[0]),
        lcov = fs.readFileSync(args[1])
      if (
        path.basename(args[1]) !== 'wallet-browser.lcov.info' ||
        path.dirname(path.resolve(args[1])) !== path.dirname(path.resolve(args[2]))
      )
        throw new Error('Browser LCOV must accompany its receipt under the fixed artifact name')
      const receipt = {
        identity: executionIdentity(),
        passedCases: validateWalletBrowserReport(JSON.parse(bytes)),
        reportSha256: digest(bytes),
        lcovSha256: digest(lcov)
      }
      validateWalletBrowserEvidence(receipt, receipt.identity, bytes, lcov)
      fs.writeFileSync(args[2] + '.jest.json', bytes, { flag: 'wx' })
      fs.writeFileSync(args[2], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    } else if (command === 'verify' && args.length === 1) {
      const receipts = receiptFiles(args[0])
      if (receipts.length !== 1) throw new Error('Expected exactly one mandatory browser receipt')
      const filename = receipts[0]
      validateWalletBrowserEvidence(
        JSON.parse(fs.readFileSync(filename, 'utf8')),
        executionIdentity(),
        fs.readFileSync(filename + '.jest.json'),
        fs.readFileSync(path.join(path.dirname(filename), 'wallet-browser.lcov.info'))
      )
      console.log('All64 original browser cases passed with exact-source report and LCOV evidence')
    } else throw new Error('Expected capture <report> <lcov> <receipt>, or verify <directory>')
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
