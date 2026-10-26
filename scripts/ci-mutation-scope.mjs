#!/usr/bin/env node
// Mutation testing is a full-suite qualification, not a per-PR gate. Ordinary
// pull requests and pushes select no mutation targets; the complete governed
// registry runs on a manual `CI` dispatch, on the scheduled or dispatched
// `Mutation quality` workflow, and in release final qualification.
//
// The output keeps the canonical partition shape the merge gate verifies:
// `required` runs now, `deferred` holds unselected high-risk targets, and
// `outside` holds unselected critical targets. Deferred and outside both mean
// not executed, never passed.
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FINAL_QUALIFICATION =
  'Every canonical target at the exact publication-candidate SHA; deferred is not passed.'

export function classifyMutationScope({ targets, policy, all = false }) {
  const risks = new Map(policy.targets.map(target => [target.id, target.risk]))
  const partition = { required: [], deferred: [], outside: [] }
  // Preserve canonical registry order: moving long established targets to
  // alphabetic queue positions can lengthen a six-runner campaign tail.
  for (const id of Object.keys(targets)) {
    const risk = risks.get(id)
    if (all || (risk !== 'critical' && risk !== 'high')) partition.required.push(id)
    else partition[risk === 'high' ? 'deferred' : 'outside'].push(id)
  }
  return { ...partition, newlyDeferred: [], finalQualification: FINAL_QUALIFICATION }
}

export function parseArguments(argv) {
  const options = { all: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--all') {
      options.all = true
      continue
    }
    // Revision arguments remain accepted for callers that still pass the
    // compared range; ordinary ranges select nothing.
    if ((key === '--base' || key === '--head') && argv[index + 1]) {
      index += 1
      continue
    }
    throw new Error('Use --all, or --base REV [--head REV] for an ordinary change')
  }
  return options
}

function main(argv) {
  const options = parseArguments(argv)
  const targets = buildMutationTargets(ROOT)
  const policy = JSON.parse(
    execFileSync('/usr/bin/git', ['show', 'HEAD:governance/mutation-testing/policy.json'], {
      cwd: ROOT,
      encoding: 'utf8'
    })
  )
  console.log(JSON.stringify(classifyMutationScope({ targets, policy, all: options.all })))
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Mutation scope failed')
    process.exitCode = 1
  }
}
