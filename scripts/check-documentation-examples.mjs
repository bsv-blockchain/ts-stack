#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const EXAMPLES = join(ROOT, 'docs/guides/compiled-package-examples.md')
const INVENTORY = join(ROOT, 'governance/repository-health/projects.json')
const inventory = JSON.parse(await readFile(INVENTORY, 'utf8'))
const publicProjects = inventory.projects.filter(project => project.release === 'npm-oidc')
const projectsByName = new Map(publicProjects.map(project => [project.name, project]))
const sdkProject = projectsByName.get('@bsv/sdk')
if (!sdkProject) throw new Error('Governed project inventory is missing @bsv/sdk')
const sdkManifest = JSON.parse(await readFile(join(ROOT, sdkProject.path, 'package.json'), 'utf8'))
const nodeTypesVersion = sdkManifest.devDependencies?.['@types/node']
if (!nodeTypesVersion)
  throw new Error('@bsv/sdk must govern the compiled-example @types/node version')
const nativeTypeScript = join(ROOT, sdkProject.path, 'node_modules/.bin/tsc')

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      maxBuffer: 16 * 1024 * 1024
    })
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n')
    throw new Error(`${command} ${args.join(' ')} failed\n${output}`, { cause: error })
  }
}

function extractExamples(markdown) {
  const blocks = []
  const ids = new Set()
  let sourceLines
  for (const line of markdown.split('\n')) {
    const marker = line.trim()
    if (sourceLines === undefined) {
      if (marker === '```ts compile' || marker === '```typescript compile') sourceLines = []
      continue
    }
    if (marker !== '```') {
      sourceLines.push(line)
      continue
    }
    const source = sourceLines.join('\n').trim()
    const id = /^\/\/ example-id:\s*([a-z0-9-]+)\s*$/m.exec(source)?.[1]
    if (!id) throw new Error('Every compiled example needs a // example-id: <id> marker')
    if (ids.has(id)) throw new Error(`Duplicate compiled example id: ${id}`)
    ids.add(id)
    blocks.push({ id, source })
    sourceLines = undefined
  }
  if (sourceLines !== undefined) throw new Error('Compiled example fence is not closed')
  if (blocks.length < 8) {
    throw new Error(`Expected at least 8 compiled cross-domain examples, found ${blocks.length}`)
  }
  return blocks
}

function importedPackages(blocks) {
  const names = new Set()
  const importPattern = /from\s+['"](@bsv\/[^/'"]+|create-bsv-app)(?:\/[^'"]+)?['"]/g
  for (const { source } of blocks) {
    for (const match of source.matchAll(importPattern)) names.add(match[1])
  }
  return names
}

async function firstPartyClosure(initialNames) {
  const closure = new Set(initialNames)
  const queue = [...initialNames]
  while (queue.length > 0) {
    const name = queue.shift()
    const project = projectsByName.get(name)
    if (!project) throw new Error(`Compiled example imports ungoverned package ${name}`)
    const manifest = JSON.parse(await readFile(join(ROOT, project.path, 'package.json'), 'utf8'))
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        if (!projectsByName.has(dependency) || closure.has(dependency)) continue
        closure.add(dependency)
        queue.push(dependency)
      }
    }
  }
  return [...closure].sort((left, right) => left.localeCompare(right))
}

async function packProject(name, tarballDirectory) {
  const project = projectsByName.get(name)
  const { stdout } = await run('pnpm', ['pack', '--json', '--pack-destination', tarballDirectory], {
    cwd: join(ROOT, project.path),
    env: { ...process.env, npm_config_ignore_scripts: 'true' }
  })
  const result = JSON.parse(stdout)
  const tarballPath = resolve(result.filename)
  if (!tarballPath.startsWith(`${tarballDirectory}/`)) {
    throw new Error(`${name} packed outside the temporary artifact directory`)
  }
  return tarballPath
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ts-stack-doc-examples-'))
try {
  const blocks = extractExamples(await readFile(EXAMPLES, 'utf8'))
  const packageNames = await firstPartyClosure(importedPackages(blocks))
  const tarballDirectory = join(temporaryDirectory, 'tarballs')
  const consumerDirectory = join(temporaryDirectory, 'consumer')
  await mkdir(tarballDirectory)
  await mkdir(consumerDirectory)

  const dependencies = {}
  for (const name of packageNames) {
    dependencies[name] = `file:${await packProject(name, tarballDirectory)}`
  }

  const developmentDependencies = {
    '@types/node': nodeTypesVersion
  }
  await writeFile(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'ts-stack-compiled-documentation-consumer',
        private: true,
        type: 'module',
        dependencies,
        devDependencies: developmentDependencies
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    join(consumerDirectory, 'pnpm-workspace.yaml'),
    `${JSON.stringify({ overrides: dependencies }, null, 2)}\n`
  )
  const combinedExamples = blocks
    .map(block => [`// ${block.id}`, block.source].join('\n'))
    .join('\n\n')
  await writeFile(join(consumerDirectory, 'examples.ts'), `${combinedExamples}\n`)
  await writeFile(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2024',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2024', 'DOM'],
          types: ['node'],
          skipLibCheck: false
        },
        include: ['examples.ts']
      },
      null,
      2
    )}\n`
  )

  await run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], {
    cwd: consumerDirectory
  })
  await run(
    nativeTypeScript,
    ['--project', join(consumerDirectory, 'tsconfig.json'), '--pretty', 'false'],
    { cwd: consumerDirectory }
  )

  const tarballs = (await readdir(tarballDirectory)).filter(file => file.endsWith('.tgz'))
  if (tarballs.length !== packageNames.length) {
    throw new Error(`Expected ${packageNames.length} tarballs, found ${tarballs.length}`)
  }
  console.log(
    `Compiled documentation examples passed: ${blocks.length} examples, ${packageNames.length} exact package tarballs`
  )
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
