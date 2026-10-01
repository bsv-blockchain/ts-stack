#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { builtinModules, createRequire } from 'node:module'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { selectAffectedMutationTargets } from './mutation-testing.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let typescript
function syntaxTree(file, source) {
  typescript ??= createRequire(new URL('../packages/sdk/package.json', import.meta.url))(
    'typescript'
  )
  return typescript.createSourceFile(file, source, typescript.ScriptTarget.Latest, true)
}
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const CODE = /\.(?:[cm]?[jt]sx?)$/
const DOC = /(?:^|\/)(?:LICENSE(?:\.txt)?|[^/]+\.md)$/
function compare(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
const sorted = values => [...values].sort(compare)
// The standalone scheduler is not an input to PR mutation execution. Existing
// critical obligations still remain selected when that scheduler changes.
const controls = file =>
  file === 'pnpm-lock.yaml' ||
  file === 'pnpm-workspace.yaml' ||
  file === 'package.json' ||
  file === 'tsconfig.base.json' ||
  (file.startsWith('.github/workflows/') && file !== '.github/workflows/mutation-tests.yml') ||
  file.startsWith('scripts/') ||
  file.startsWith('governance/') ||
  file.startsWith('conformance/') ||
  file.startsWith('specs/')
const REVIEWED_RUNTIME_INPUTS = new Map([
  [
    'packages/helpers/air-gap/tests/helpers.ts',
    {
      digest: 'b1ff76f69582702965a244c2609ba8003fa1a646256dafa2e7fdfd65c9693e6c',
      inputs: ['conformance/vectors/transport/air-gap-optical.json']
    }
  ]
])

export function reviewedRuntimeInputs(file, source, paths) {
  const reviewed = REVIEWED_RUNTIME_INPUTS.get(file)
  return reviewed &&
    createHash('sha256').update(source).digest('hex') === reviewed.digest &&
    reviewed.inputs.every(
      input =>
        paths.has(input) && ![...paths].some(file => file !== input && file.endsWith(`/${input}`))
    )
    ? reviewed.inputs
    : undefined
}
const git = (root, arguments_, options = {}) =>
  execFileSync('/usr/bin/git', arguments_, { cwd: root, maxBuffer: 128 * 1024 * 1024, ...options })

export function readSnapshot(root, revision) {
  const sha = git(root, ['rev-parse', '--verify', `${revision}^{commit}`], {
    encoding: 'utf8'
  }).trim()
  const records = git(root, ['ls-tree', '-r', '-z', sha], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map(record => {
      const match = /^(\d+) blob ([a-f0-9]{40})\t(.*)$/s.exec(record)
      if (!match) return undefined
      return { mode: match[1], oid: match[2], file: match[3] }
    })
    .filter(Boolean)
  const wanted = records.filter(
    ({ file }) =>
      CODE.test(file) ||
      file === 'package.json' ||
      file.endsWith('/package.json') ||
      file.endsWith('/tsconfig.json') ||
      file === 'governance/repository-health/projects.json'
  )
  const bytes = git(root, ['cat-file', '--batch'], {
    input: wanted.map(record => record.oid).join('\n') + '\n'
  })
  const files = new Map()
  let offset = 0
  for (const record of wanted) {
    const end = bytes.indexOf(10, offset)
    const header = bytes.subarray(offset, end).toString('utf8').split(' ')
    if (header[0] !== record.oid || header[1] !== 'blob' || !/^\d+$/.test(header[2]))
      throw new Error('Incomplete Git snapshot')
    const size = Number(header[2])
    offset = end + 1
    if (bytes[offset + size] !== 10) throw new Error('Truncated Git blob')
    files.set(record.file, bytes.subarray(offset, offset + size).toString('utf8'))
    offset += size + 1
  }
  if (offset !== bytes.length) throw new Error('Unexpected Git snapshot data')
  return { sha, files, records }
}

function projectsIn(snapshot) {
  const registry = JSON.parse(snapshot.files.get('governance/repository-health/projects.json'))
  return registry.projects
    .filter(project => project.path !== '.')
    .map(project => {
      const manifest = JSON.parse(snapshot.files.get(`${project.path}/package.json`))
      return {
        ...project,
        manifest,
        name: manifest.name,
        roots: [project.path, ...(project.sourceRoots ?? [])]
      }
    })
}
const owners = (projects, file) =>
  projects
    .filter(project => project.roots.some(root => file === root || file.startsWith(`${root}/`)))
    .map(project => project.name)
function addEdge(edges, consumer, dependency) {
  if (consumer === dependency) return
  const values = edges.get(dependency) ?? new Set()
  values.add(consumer)
  edges.set(dependency, values)
}

function reverseClosure(seed, reverse) {
  const selected = new Set(seed)
  const queue = [...selected]
  while (queue.length)
    for (const consumer of reverse.get(queue.shift()) ?? []) {
      if (!selected.has(consumer)) {
        selected.add(consumer)
        queue.push(consumer)
      }
    }
  return selected
}

function recordInput(context, input, consumers) {
  const values = context.importedInputs.get(input) ?? new Set()
  for (const consumer of consumers) values.add(consumer)
  context.importedInputs.set(input, values)
}

function connectOwners(context, consumers, dependencies) {
  for (const consumer of consumers)
    for (const dependency of dependencies) addEdge(context.reverse, consumer, dependency)
}

function relativeInput(file, specifier, paths) {
  const stem = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
  const base = stem.replace(/\.(?:mjs|cjs|js|jsx)$/, '')
  const candidates = [
    stem,
    ...[
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.json',
      '/index.ts',
      '/index.js'
    ].map(extension => base + extension)
  ]
  return candidates.find(candidate => paths.has(candidate))
}

function declaredExternal(specifier, manifests) {
  if (builtinModules.includes(specifier) || specifier.startsWith('node:')) return true
  const name = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
  return manifests.some(manifest =>
    FIELDS.some(field => Object.hasOwn(manifest[field] ?? {}, name))
  )
}

function inputConnector(context, file, current, paths, consumers, rootManifest, uncertain) {
  return specifier => {
    const workspaceName = [...context.names].find(
      name => specifier === name || specifier.startsWith(`${name}/`)
    )
    if (workspaceName) {
      connectOwners(context, consumers, [workspaceName])
      return
    }
    if (!specifier.startsWith('.')) {
      const manifests = [
        rootManifest,
        ...current
          .filter(project => consumers.includes(project.name))
          .map(project => project.manifest)
      ]
      if (!declaredExternal(specifier, manifests))
        uncertain(`unresolved external or internal alias ${specifier}`)
      return
    }
    const resolved = relativeInput(file, specifier, paths)
    if (!resolved) {
      uncertain(`unresolved relative input ${specifier}`)
      return
    }
    recordInput(context, resolved, consumers)
    const dependencies = owners(current, resolved)
    if (!dependencies.length) {
      uncertain(`unowned relative input ${specifier}`)
      return
    }
    connectOwners(context, consumers, dependencies)
  }
}

function literalInput(node, uncertain, reason) {
  const ts = typescript
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
    return node.text
  uncertain(reason)
  return undefined
}

function callInput(node, uncertain, reviewed) {
  const ts = typescript
  const expression = node.expression
  const moduleCall =
    expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(expression) && expression.text === 'require')
  if (moduleCall) return literalInput(node.arguments[0], uncertain, 'computed module input')
  let name = ''
  if (ts.isIdentifier(expression)) name = expression.text
  else if (ts.isPropertyAccessExpression(expression)) name = expression.name.text
  if (
    !reviewed &&
    /^(?:readFile(?:Sync)?|createReadStream|readdir(?:Sync)?|glob(?:Sync)?|open(?:Sync)?)$/.test(
      name
    )
  )
    uncertain('runtime filesystem input lacks a proven dependency boundary')
  return undefined
}

function moduleInput(node, uncertain, reviewed) {
  const ts = typescript
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
    return literalInput(node.moduleSpecifier, uncertain, 'computed module reference')
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
    return literalInput(node.moduleReference.expression, uncertain, 'computed module reference')
  if (ts.isCallExpression(node)) return callInput(node, uncertain, reviewed)
  const localUrl =
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'URL' &&
    node.arguments?.length === 2
  if (localUrl) {
    const value = literalInput(node.arguments[0], uncertain, 'computed URL input')
    return value?.startsWith('.') ? value : undefined
  }
  return undefined
}

function recordSource(context, file, source, current, paths, rootManifest) {
  const consumers = owners(current, file)
  if (!consumers.length) return
  const uncertain = reason => {
    for (const consumer of consumers) context.unknown.add(consumer)
    context.reasons.add(`${file}: ${reason}`)
  }
  if (!paths.has(file)) {
    uncertain('symlink input has no proven source boundary')
    return
  }
  const reviewed = reviewedRuntimeInputs(file, source, paths)
  for (const input of reviewed ?? []) recordInput(context, input, consumers)
  const connect = inputConnector(context, file, current, paths, consumers, rootManifest, uncertain)
  const tree = syntaxTree(file, source)
  if (tree.parseDiagnostics.length) uncertain('unparsed source')
  const visit = node => {
    const specifier = moduleInput(node, uncertain, reviewed)
    if (specifier !== undefined) connect(specifier)
    typescript.forEachChild(node, visit)
  }
  visit(tree)
}

function recordManifest(context, project) {
  for (const field of FIELDS)
    for (const dependency of Object.keys(project.manifest[field] ?? {})) {
      if (context.names.has(dependency)) addEdge(context.reverse, project.name, dependency)
    }
}

function recordSnapshot(context, snapshot) {
  const current = projectsIn(snapshot)
  const paths = new Set(
    snapshot.records.filter(record => record.mode !== '120000').map(record => record.file)
  )
  const rootManifest = JSON.parse(snapshot.files.get('package.json') ?? '{}')
  for (const project of current) recordManifest(context, project)
  for (const [file, source] of snapshot.files) {
    if (CODE.test(file)) recordSource(context, file, source, current, paths, rootManifest)
  }
}

export function dependencyEvidence(snapshots) {
  const projects = snapshots.flatMap(projectsIn)
  const context = {
    projects,
    names: new Set(projects.map(project => project.name)),
    reverse: new Map(),
    unknown: new Set(),
    reasons: new Set(),
    importedInputs: new Map()
  }
  for (const snapshot of snapshots) recordSnapshot(context, snapshot)
  return {
    projects,
    reverse: context.reverse,
    unknown: reverseClosure(context.unknown, context.reverse),
    importedInputs: context.importedInputs,
    reasons: sorted(context.reasons)
  }
}

function impactedProjects(files, dependency, reasons, docsOnly) {
  if (docsOnly) return new Set()
  if (!dependency) {
    reasons.add('dependency snapshots unavailable')
    return new Set()
  }
  const direct = new Set()
  for (const file of files) {
    if (
      (DOC.test(file) && !dependency.importedInputs?.has(file)) ||
      file === '.github/workflows/mutation-tests.yml'
    )
      continue
    const fileOwners = owners(dependency.projects, file)
    if (!fileOwners.length) reasons.add(`unowned input changed: ${file}`)
    for (const owner of [...fileOwners, ...(dependency.importedInputs?.get(file) ?? [])])
      direct.add(owner)
  }
  return reverseClosure(direct, dependency.reverse)
}

function targetDisposition(id, target, risk, context) {
  const { dependency, docsOnly, impacted, reasons, legacyRequired } = context
  const targetOwners = dependency
    ? owners(dependency.projects, target.manifest ?? `${target.packageDirectory}/package.json`)
    : []
  const uncertain =
    !docsOnly &&
    (targetOwners.length === 0 || targetOwners.some(owner => dependency?.unknown.has(owner)))
  const affected = targetOwners.some(owner => impacted.has(owner))
  const knownRisk = risk === 'critical' || risk === 'high'
  if (
    reasons.size ||
    uncertain ||
    affected ||
    !knownRisk ||
    (risk === 'critical' && legacyRequired.includes(id))
  )
    return 'required'
  return risk === 'high' ? 'deferred' : 'outside'
}

export function classifyMutationScope({
  targets,
  policy,
  changedFiles,
  dependency,
  legacyRequired = [],
  unknownReason
}) {
  const files = [...new Set(changedFiles)]
  const ids = Object.keys(targets)
  const risks = new Map(policy.targets.map(target => [target.id, target.risk]))
  const docsOnly = files.every(file => DOC.test(file) && !dependency?.importedInputs?.has(file))
  const reasons = new Set(unknownReason ? [unknownReason] : [])
  if (!docsOnly && files.some(controls))
    reasons.add('shared control or unproved lock resolution changed')
  const impacted = impactedProjects(files, dependency, reasons, docsOnly)
  const partition = { required: [], deferred: [], outside: [] }
  const context = { dependency, docsOnly, impacted, reasons, legacyRequired }
  for (const id of ids)
    partition[targetDisposition(id, targets[id], risks.get(id), context)].push(id)
  const { required, deferred, outside } = partition
  return {
    // Preserve canonical registry order: moving long established targets to
    // alphabetic queue positions can lengthen a six-runner campaign tail.
    required,
    deferred,
    outside,
    newlyDeferred: sorted(deferred.filter(id => legacyRequired.includes(id))),
    affectedProjects: sorted(impacted),
    unknownReasons: sorted(reasons),
    uncertainProjects: docsOnly ? [] : sorted(dependency?.unknown ?? []),
    finalQualification:
      'Every canonical target at the exact publication-candidate SHA; deferred is not passed.'
  }
}

export function mutationScope(root, { base, head = 'HEAD', targets, policy, legacyRequired }) {
  let snapshots, files
  try {
    const current = readSnapshot(root, head),
      previous = readSnapshot(root, base)
    snapshots = [previous, current]
    files = git(
      root,
      ['diff', '--no-renames', '--name-only', '-z', `${previous.sha}...${current.sha}`],
      { encoding: 'utf8' }
    )
      .split('\0')
      .filter(Boolean)
    const dependency = dependencyEvidence(snapshots)
    const legacy = legacyRequired ?? selectAffectedMutationTargets(targets, files)
    return {
      ...classifyMutationScope({
        targets,
        policy,
        changedFiles: files,
        dependency,
        legacyRequired: legacy
      }),
      baseSha: previous.sha,
      headSha: current.sha
    }
  } catch (error) {
    return classifyMutationScope({
      targets,
      policy,
      changedFiles: [],
      unknownReason: `Unresolved classification: ${error instanceof Error ? error.message : 'unknown snapshot'}`
    })
  }
}

function main(argv) {
  const options = { head: 'HEAD' }
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (
      !['--base', '--head'].includes(key) ||
      !argv[index + 1] ||
      (options[key.slice(2)] !== undefined && key !== '--head')
    )
      throw new Error('Use --base REV [--head REV]')
    options[key.slice(2)] = argv[index + 1]
  }
  const targets = buildMutationTargets(ROOT)
  const policy = JSON.parse(
    git(ROOT, ['show', 'HEAD:governance/mutation-testing/policy.json'], { encoding: 'utf8' })
  )
  console.log(JSON.stringify(mutationScope(ROOT, { ...options, targets, policy })))
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Mutation scope failed')
    process.exitCode = 1
  }
}
