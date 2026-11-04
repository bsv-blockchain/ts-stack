import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Changing these identities requires a newly reviewed policy change.
const APPROVED = {
  status: 'approved',
  reportedSecurityRating: 3,
  owner: 'BraydenLangley',
  repository: 'bsv-blockchain/ts-stack',
  project: 'bsv-blockchain_ts-stack',
  pullRequest: 569,
  branch: 'codex/wallet-sync-interop-reliability',
  base: 'main',
  approvedAt: '2026-10-19T18:28:00Z',
  expiresAt: '2026-10-24T23:59:59Z',
  findings: [
    {
      analyzer: 'CodeQL',
      alert: 353,
      rule: 'js/http-to-file-access',
      file: 'scripts/sonar-policy-gate.mjs',
      sha256: '3aba1f218aa36a86a584448c53c6c5682978bba046dbf5f1ed28d2d2d56cb8c9'
    },
    {
      analyzer: 'Sonar',
      key: 'AaExP-k5m5nztHJVpve2',
      rule: 'javascript:S2612',
      file: 'packages/wallet/wallet-toolbox/tools/Brc38RootNativeInstallation.cjs',
      sha256: 'c22043383de5f7846aaf99f442390f7210b0b0d236a9d4d7b63e1afc0d3cb893',
      line: 188,
      type: 'VULNERABILITY',
      message: 'Make sure this permission is safe.',
      impacts: [
        {
          softwareQuality: 'SECURITY',
          severity: 'MEDIUM'
        }
      ]
    },
    {
      analyzer: 'Sonar',
      key: 'AaExP751m5nztHJVpurV',
      rule: 'javascript:S2612',
      file: 'packages/wallet/wallet-toolbox/src/storage/portable/native/copy_artifacts.cjs',
      sha256: '71d00b7d5c4cb677122ec8c84e16939d5d053a29ffe3aeaa0f8833f5a2e94535',
      line: 78,
      type: 'VULNERABILITY',
      message: 'Make sure this permission is safe.',
      impacts: [
        {
          softwareQuality: 'SECURITY',
          severity: 'MEDIUM'
        }
      ]
    }
  ]
}

export function readReviewedAnalysisExceptions(read = readFileSync) {
  const manifest = JSON.parse(
    read(new URL('../governance/pr569-reviewed-analysis-exceptions.json', import.meta.url), 'utf8')
  )
  for (const [key, value] of Object.entries(APPROVED)) {
    const actual =
      key === 'findings'
        ? manifest.findings?.map(({ rationale: _rationale, ...identity }) => identity)
        : manifest[key]
    if (JSON.stringify(actual) !== JSON.stringify(value))
      throw new Error(`Invalid reviewed analysis exception: ${key}`)
  }
  for (const finding of manifest.findings) {
    const source = read(new URL(`../${finding.file}`, import.meta.url))
    if (createHash('sha256').update(source).digest('hex') !== finding.sha256)
      throw new Error(`Reviewed analysis source changed: ${finding.file}`)
    if (typeof finding.rationale !== 'string' || !finding.rationale.trim())
      throw new Error('Missing reviewed analysis rationale')
  }
  if (typeof manifest.removeWhen !== 'string' || !manifest.removeWhen.trim())
    throw new Error('Missing reviewed analysis removal condition')
  return manifest
}

export function reviewedSonarPermission(issue, manifest, now) {
  if (
    !Number.isFinite(now) ||
    now < Date.parse(manifest.approvedAt) ||
    now >= Date.parse(manifest.expiresAt)
  )
    return false
  return manifest.findings.some(
    finding =>
      finding.analyzer === 'Sonar' &&
      ['key', 'rule', 'line', 'type', 'message'].every(key => issue?.[key] === finding[key]) &&
      issue.component === `${manifest.project}:${finding.file}` &&
      JSON.stringify(issue.impacts) === JSON.stringify(finding.impacts)
  )
}
