import { readFileSync } from 'node:fs'
import {
  readReviewedAnalysisExceptions,
  reviewedSonarPermission
} from './pr569-reviewed-analysis.mjs'

// Scope changes require a new reviewed policy change, not a CLI switch.
export const SONAR_BUDGET = Object.freeze({
  status: 'approved',
  owner: 'ty-everett',
  repository: 'bsv-blockchain/ts-stack',
  project: 'bsv-blockchain_ts-stack',
  pullRequest: 569,
  branch: 'codex/wallet-sync-interop-reliability',
  base: 'main',
  expiresAt: '2026-10-24T23:59:59Z',
  maintainabilityRating: 1,
  maximumDuplicationPercent: 6,
  unresolvedBugs: 0,
  unresolvedVulnerabilities: 0,
  unreviewedHotspots: 0
})

export function readApprovedSonarBudget() {
  const manifest = JSON.parse(
    readFileSync(new URL('../governance/sonar-pr569-budget.json', import.meta.url), 'utf8')
  )
  for (const [key, value] of Object.entries(SONAR_BUDGET)) {
    if (manifest[key] !== value) throw new Error(`Invalid approved Sonar budget: ${key}`)
  }
  return manifest
}

const ACTIVE = new Set(['OPEN', 'CONFIRMED', 'ACCEPTED', 'FALSE_POSITIVE'])
const REQUIRED = new Map([
  ['new_reliability_rating', ['GT', 1]],
  ['new_security_rating', ['GT', 1]],
  ['new_maintainability_rating', ['GT', 1]],
  ['new_duplicated_lines_density', ['GT', 6]],
  ['new_security_hotspots_reviewed', ['LT', 100]]
])

export function sonarIssueStatus(issue) {
  if (issue?.issueStatus !== undefined) return issue.issueStatus
  if (issue?.resolution === 'FALSE-POSITIVE') return 'FALSE_POSITIVE'
  if (issue?.status === 'CLOSED' && issue?.resolution === 'FIXED') return 'FIXED'
  return issue?.status
}

function numeric(value) {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
    Number.isFinite(Number(value))
  )
}

// This evaluator is not an authority source. The production controller obtains
// workflow/PR context and the complete bracketed inventory itself.
export function evaluateSonarBudget(snapshot, now = Date.now()) {
  const failures = []
  const reject = message => failures.push(message)
  for (const key of ['repository', 'project', 'pullRequest', 'branch', 'base']) {
    if (snapshot[key] !== SONAR_BUDGET[key]) reject(`outside approved scope: ${key}`)
  }
  if (!Number.isFinite(now) || now >= Date.parse(SONAR_BUDGET.expiresAt)) reject('budget expired')
  const revision = snapshot.revision
  if (!/^[0-9a-f]{40}$/.test(revision ?? '')) reject('missing exact source revision')
  for (const analysis of [snapshot.analysisBefore, snapshot.analysisAfter]) {
    if (
      analysis?.commit?.sha !== revision ||
      analysis?.key !== '569' ||
      analysis?.branch !== SONAR_BUDGET.branch ||
      analysis?.base !== SONAR_BUDGET.base ||
      typeof analysis?.analysisDate !== 'string' ||
      !Number.isFinite(Date.parse(analysis.analysisDate))
    )
      reject('analysis differs from the exact PR/source context')
  }
  if (snapshot.analysisBefore?.analysisDate !== snapshot.analysisAfter?.analysisDate)
    reject('analysis changed while collecting evidence')
  const reviewed = readReviewedAnalysisExceptions()
  const reviewedPermissionFindings = []
  const issues = snapshot.issues
  const keys = new Set()
  let maintainabilityFindings = 0
  let activeFindings = 0
  if (
    !Array.isArray(issues) ||
    !Number.isSafeInteger(snapshot.issueTotal) ||
    snapshot.issueTotal < 0 ||
    issues.length !== snapshot.issueTotal
  )
    reject('incomplete issue inventory')
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (typeof issue?.key !== 'string' || !issue.key || keys.has(issue.key))
      reject('missing or duplicate finding key')
    keys.add(issue?.key)
    if (issue?.project !== SONAR_BUDGET.project || String(issue?.pullRequest) !== '569')
      reject(`finding outside approved project/PR: ${issue?.key}`)
    const status = sonarIssueStatus(issue)
    if (!ACTIVE.has(status)) {
      if (status !== 'FIXED') reject(`unknown finding state: ${issue?.key}`)
      continue
    }
    activeFindings++
    if (reviewedSonarPermission(issue, reviewed, now)) {
      reviewedPermissionFindings.push(issue.key)
      continue
    }
    // Finding states alone never waive correctness or security.
    if (
      issue?.type !== 'CODE_SMELL' ||
      !Array.isArray(issue.impacts) ||
      !issue.impacts.length ||
      issue.impacts.some(
        impact =>
          impact?.softwareQuality !== 'MAINTAINABILITY' ||
          !['INFO', 'LOW', 'MEDIUM', 'HIGH', 'BLOCKER'].includes(impact?.severity)
      )
    )
      reject(`unresolved correctness/security or unclassified finding: ${issue?.key}`)
    else maintainabilityFindings++
  }
  const hotspots = snapshot.hotspots
  if (
    !Array.isArray(hotspots) ||
    !Number.isSafeInteger(snapshot.hotspotTotal) ||
    snapshot.hotspotTotal < 0 ||
    hotspots.length !== snapshot.hotspotTotal
  )
    reject('incomplete hotspot inventory')
  const hotspotKeys = new Set()
  let unreviewedHotspots = 0
  for (const hotspot of Array.isArray(hotspots) ? hotspots : []) {
    if (typeof hotspot?.key !== 'string' || !hotspot.key || hotspotKeys.has(hotspot.key))
      reject('missing or duplicate hotspot key')
    hotspotKeys.add(hotspot?.key)
    if (hotspot?.status === 'TO_REVIEW') unreviewedHotspots++
    else if (
      hotspot?.status !== 'REVIEWED' ||
      !['FIXED', 'SAFE', 'ACKNOWLEDGED'].includes(hotspot?.resolution)
    )
      reject(`unknown hotspot review state: ${hotspot?.key}`)
  }
  if (unreviewedHotspots !== 0) reject('unreviewed security hotspots')
  const gate = snapshot.qualityGate?.projectStatus
  if (
    !['OK', 'ERROR'].includes(gate?.status) ||
    gate?.ignoredConditions !== false ||
    !Array.isArray(gate?.conditions)
  )
    reject('missing, ignored or unknown quality conditions')
  const seen = new Set()
  for (const condition of Array.isArray(gate?.conditions) ? gate.conditions : []) {
    if (seen.has(condition?.metricKey))
      reject(`duplicate quality condition: ${condition?.metricKey}`)
    seen.add(condition?.metricKey)
    const expected = REQUIRED.get(condition?.metricKey)
    const value = Number(condition?.actualValue)
    const threshold = Number(condition?.errorThreshold)
    const valid =
      typeof condition?.metricKey === 'string' &&
      condition.metricKey !== '' &&
      ['OK', 'ERROR'].includes(condition.status) &&
      ['GT', 'LT'].includes(condition.comparator) &&
      numeric(condition.actualValue) &&
      numeric(condition.errorThreshold)
    const originalFailure =
      valid && (condition.comparator === 'GT' ? value > threshold : value < threshold)
    if (!valid || (condition.status === 'ERROR') !== originalFailure)
      reject(`malformed or inconsistent quality condition: ${condition?.metricKey}`)
    if (!expected) {
      if (condition?.status !== 'OK') reject(`unknown failed condition: ${condition?.metricKey}`)
      continue
    }
    const duplication = condition.metricKey === 'new_duplicated_lines_density'
    const reviewedSecurityRating =
      condition.metricKey === 'new_security_rating' &&
      reviewedPermissionFindings.length === 2 &&
      value === reviewed.reportedSecurityRating
    const allowed = reviewedSecurityRating ? reviewed.reportedSecurityRating : expected[1]
    if (
      !valid ||
      condition.comparator !== expected[0] ||
      (duplication ? threshold < 0 || threshold > 6 : threshold !== expected[1]) ||
      (expected[0] === 'GT' ? value > allowed : value < allowed) ||
      value < 0 ||
      (condition.metricKey.endsWith('_rating') && value !== allowed) ||
      (duplication && value > 100) ||
      (condition.metricKey === 'new_security_hotspots_reviewed' && value !== 100)
    )
      reject(`required metric failed or malformed: ${condition.metricKey}`)
  }
  for (const metric of REQUIRED.keys())
    if (!seen.has(metric)) reject(`missing required metric: ${metric}`)
  const hasError =
    Array.isArray(gate?.conditions) && gate.conditions.some(c => c?.status === 'ERROR')
  if ((gate?.status === 'ERROR') !== Boolean(hasError))
    reject('aggregate and condition status disagree')
  return {
    mode: 'approved-pr569-budget',
    revision,
    originalGateStatus: gate?.status ?? 'missing',
    originalZeroFindingsSatisfied:
      failures.length === 0 && activeFindings === 0 && gate?.status === 'OK',
    scopedBudgetSatisfied: failures.length === 0,
    reviewedPermissionFindings,
    reportedSecurityRating: gate?.conditions?.find(c => c.metricKey === 'new_security_rating')
      ?.actualValue,
    maintainabilityFindings,
    activeFindings,
    issueTotal: snapshot.issueTotal,
    hotspotTotal: snapshot.hotspotTotal,
    unreviewedHotspots,
    failures
  }
}
