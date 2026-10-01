#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

// Discover npm without executing a PATH command or relying on Node's install
// layout. Homebrew and distro packages can store npm outside Node's prefix.
function resolveNpmCli({
  execPath = process.execPath,
  env = process.env,
  platform = process.platform
} = {}) {
  const pathCandidates = (env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(directory => path.resolve(directory, platform === 'win32' ? 'npm.cmd' : 'npm'))
  const runtimeDirectory = path.dirname(execPath)
  const candidates = [
    ...pathCandidates,
    env.npm_execpath,
    path.resolve(runtimeDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(runtimeDirectory, 'node_modules/npm/bin/npm-cli.js')
  ].filter(candidate => typeof candidate === 'string' && path.isAbsolute(candidate))
  const resolved = candidates
    .map(candidate => {
      try {
        const launcher = realpathSync(candidate)
        // Windows distributes a batch shim alongside npm's JavaScript CLI.
        const cli =
          path.basename(launcher).toLowerCase() === 'npm.cmd'
            ? realpathSync(path.join(path.dirname(launcher), 'node_modules/npm/bin/npm-cli.js'))
            : launcher
        if (path.basename(cli) !== 'npm-cli.js' || !statSync(cli).isFile()) return undefined
        const npmManifest = JSON.parse(
          readFileSync(path.resolve(path.dirname(cli), '../package.json'), 'utf8')
        )
        return npmManifest.name === 'npm' ? cli : undefined
      } catch {
        return undefined
      }
    })
    .find(Boolean)
  if (!resolved)
    throw new Error(
      'Cannot find an installed npm JavaScript CLI from PATH, npm_execpath, or the Node installation'
    )
  return resolved
}

// The default profile packs the already-built SDK and installs that exact
// tarball offline without lifecycle scripts or peer-resolution exceptions.
// --consumer can instead qualify an existing installed exact SDK artifact.
const options = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  options.set(process.argv[index], process.argv[index + 1])
}
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourcePackage = path.resolve(scriptDirectory, '..')
const toolRoot = path.resolve(options.get('--tools-root') ?? path.join(scriptDirectory, '../../..'))
let consumer
let packedArtifact
if (options.has('--consumer')) {
  consumer = path.resolve(options.get('--consumer'))
} else {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-umd-contract-'))
  consumer = path.join(temporary, 'consumer')
  const npmCli = resolveNpmCli()
  function npm(args, cwd) {
    const run = spawnSync(process.execPath, [npmCli, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_userconfig: '/dev/null',
        npm_config_cache: path.join(temporary, 'npm-cache')
      }
    })
    if (run.status !== 0) throw new Error(`Offline SDK artifact setup failed: ${run.stderr}`)
    return run.stdout
  }
  const packed = JSON.parse(
    npm(
      ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', temporary],
      sourcePackage
    )
  )[0]
  const tarball = path.join(temporary, packed.filename)
  await fs.mkdir(consumer, { recursive: true })
  await fs.writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }) + '\n'
  )
  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer)
  packedArtifact = {
    tarball,
    sha256: sha256(await fs.readFile(tarball)),
    npmCli,
    nodeExecutable: process.execPath
  }
}
const output = path.resolve(options.get('--output') ?? path.join(consumer, 'umd-contract-results'))
assert.ok(
  output.startsWith(consumer + path.sep),
  'Output must be inside the consumer for module resolution'
)
const aliases = (options.get('--aliases') ?? '@bsv/sdk/umd,@bsv/sdk/umd.ts').split(',')
const requireAliases = (options.get('--require-aliases') ?? '@bsv/sdk/umd.ts')
  .split(',')
  .filter(Boolean)
const packageRoot = path.join(consumer, 'node_modules/@bsv/sdk')
const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
const toolRequire = createRequire(path.join(toolRoot, 'package.json'))
const { build: esbuild } = await import(pathToFileURL(toolRequire.resolve('esbuild')).href)
const { build: vite, createLogger } = await import(pathToFileURL(toolRequire.resolve('vite')).href)
const generator = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sizes(bytes) {
  return {
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
    }).length
  }
}

const classicBytes = await fs.readFile(path.join(packageRoot, 'dist/umd/bundle.js'))
// Execute a normal, isolated module fixture rather than dynamically evaluating
// the classic asset. The function's receiver preserves its browser script `this`.
// Keep the raw packed bytes unchanged inside the wrapper and record provenance.
await fs.mkdir(output, { recursive: true })
const classicProbe = path.join(output, 'classic-probe.mjs')
const classicPrefix = Buffer.from(`import assert from 'node:assert/strict';
const previousClassicGlobal = { previousSDK: true };
globalThis.bsv = previousClassicGlobal;
globalThis.fetch = () => { throw new Error('The SDK import must not make network requests'); };
function loadClassic() {
`)
const classicSuffix = Buffer.from(`
}
loadClassic.call(globalThis);
assert.notEqual(globalThis.bsv, previousClassicGlobal, 'Classic asset must replace the existing global');
assert.equal(globalThis.bsv.PrivateKey.fromString('1').toPublicKey().toString(), ${JSON.stringify(generator)});
assert.equal(globalThis.bsv.__esModule, true);
assert.equal(globalThis.bsv[Symbol.toStringTag], 'Module');
function descriptorShape(descriptor) {
  return {
    enumerable: descriptor.enumerable,
    configurable: descriptor.configurable,
    ...('writable' in descriptor ? { writable: descriptor.writable } : {}),
    ...('get' in descriptor ? { getter: typeof descriptor.get === 'function' } : {}),
    ...('set' in descriptor ? { setter: typeof descriptor.set === 'function' } : {})
  };
}
const names = Object.keys(globalThis.bsv).sort((left, right) => left.localeCompare(right, 'en'));
const descriptors = Object.fromEntries(names.map(name =>
  [name, descriptorShape(Object.getOwnPropertyDescriptor(globalThis.bsv, name))]));
const markerDescriptors = {
  module: descriptorShape(Object.getOwnPropertyDescriptor(globalThis.bsv, '__esModule')),
  tag: descriptorShape(Object.getOwnPropertyDescriptor(globalThis.bsv, Symbol.toStringTag))
};
const globalDescriptor = descriptorShape(Object.getOwnPropertyDescriptor(globalThis, 'bsv'));
console.log(JSON.stringify({ names, descriptors, markerDescriptors, globalDescriptor }));
`)
await fs.writeFile(classicProbe, Buffer.concat([classicPrefix, classicBytes, classicSuffix]))
const classicProbeBytes = await fs.readFile(classicProbe)
assert.deepEqual(
  classicProbeBytes.subarray(classicPrefix.length, classicPrefix.length + classicBytes.length),
  classicBytes,
  'Classic probe must contain the exact packed asset bytes'
)
const classicRun = spawnSync(process.execPath, [classicProbe], {
  cwd: consumer,
  encoding: 'utf8',
  timeout: 30_000,
  maxBuffer: 4 * 1024 * 1024
})
assert.equal(classicRun.status, 0, `Classic asset contract failed: ${classicRun.stderr}`)
const { names, descriptors, markerDescriptors, globalDescriptor } = JSON.parse(classicRun.stdout)

// The import-only case contains no SDK root import: a bundler dropping the
// facade's initialization must fail. The named case compares every export
// with the canonical root and verifies cross-entry class identity.
const assertions = `
const expectedNames = ${JSON.stringify(names)};
const expectedDescriptors = ${JSON.stringify(descriptors)};
const markerDescriptors = ${JSON.stringify(markerDescriptors)};
const expectedGlobalDescriptor = ${JSON.stringify(globalDescriptor)};
const globalSDK = globalThis.bsv;
if (!globalSDK || globalSDK.previousSDK) throw new Error('Missing global bsv replacement');
if (JSON.stringify(Object.keys(globalSDK).sort((left, right) => left.localeCompare(right, 'en'))) !== JSON.stringify(expectedNames))
  throw new Error('Global exports differ from the classic asset');
function shape(d) {
  return { enumerable: d.enumerable, configurable: d.configurable,
    ...('writable' in d ? { writable: d.writable } : {}),
    ...('get' in d ? { getter: typeof d.get === 'function' } : {}),
    ...('set' in d ? { setter: typeof d.set === 'function' } : {}) };
}
for (const name of expectedNames)
  if (JSON.stringify(shape(Object.getOwnPropertyDescriptor(globalSDK, name))) !==
      JSON.stringify(expectedDescriptors[name])) throw new Error('Export descriptor changed: ' + name);
if (globalSDK.__esModule !== true || globalSDK[Symbol.toStringTag] !== 'Module')
  throw new Error('Global module markers changed');
if (JSON.stringify(shape(Object.getOwnPropertyDescriptor(globalSDK, '__esModule'))) !==
    JSON.stringify(markerDescriptors.module)) throw new Error('__esModule descriptor changed');
if (JSON.stringify(shape(Object.getOwnPropertyDescriptor(globalSDK, Symbol.toStringTag))) !==
    JSON.stringify(markerDescriptors.tag)) throw new Error('Module tag descriptor changed');
if (JSON.stringify(shape(Object.getOwnPropertyDescriptor(globalThis, 'bsv'))) !==
    JSON.stringify(expectedGlobalDescriptor)) throw new Error('Global bsv descriptor changed');
const publicKey = globalSDK.PrivateKey.fromString('1').toPublicKey();
if (publicKey.toString() !== ${JSON.stringify(generator)}) throw new Error('Public generator changed');
if (!(publicKey instanceof globalSDK.PublicKey) || !(publicKey instanceof globalSDK.Point))
  throw new Error('Global class graph differs');
`

await fs.mkdir(output, { recursive: true })
const browserPages = []
const classicDirectory = path.join(output, 'classic')
await fs.mkdir(classicDirectory, { recursive: true })
await fs.writeFile(path.join(classicDirectory, 'bundle.js'), classicBytes)
await fs.writeFile(
  path.join(classicDirectory, 'index.html'),
  `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>SDK classic UMD global</title>
<body data-result="pending"><pre id="result">PENDING</pre>
<script>globalThis.bsv = { previousSDK: true };
globalThis.fetch = () => { throw new Error('Unexpected provider request'); };</script>
<script src="./bundle.js"></script><script>
try {
${assertions}
  document.body.dataset.result = 'pass';
  document.querySelector('#result').textContent = 'PASS: original classic UMD asset; ' +
    Object.keys(globalThis.bsv).length + ' exports; original descriptors and fixed public generator';
} catch (error) {
  document.body.dataset.result = 'fail';
  document.querySelector('#result').textContent = 'FAIL: ' + error.name + ': ' + error.message;
  throw error;
}
</script></body></html>\n`
)
browserPages.push('classic/index.html')
const result = {
  sdkVersion: manifest.version,
  packedArtifact,
  manifestSHA256: sha256(await fs.readFile(path.join(packageRoot, 'package.json'))),
  sideEffects: manifest.sideEffects,
  classic: {
    sha256: sha256(classicBytes),
    bytes: sizes(classicBytes),
    exportCount: names.length,
    descriptorParityReference: true,
    publicGenerator: true,
    runtimeProbe: 'static-node-child',
    rawAssetBytesPreserved: true,
    probeSHA256: sha256(classicProbeBytes)
  },
  cases: [],
  leafCases: []
}
const requireBoundaryFixture = path.join(output, 'require-boundary.cjs')
await fs.writeFile(
  requireBoundaryFixture,
  `try { require('@bsv/sdk/umd'); throw new Error('Explicit ./umd unexpectedly accepts require'); }
catch (error) {
  if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    console.error(error.name + ': ' + error.message); process.exitCode = 1;
  }
}`
)
const requireBoundary = spawnSync(process.execPath, [requireBoundaryFixture], {
  cwd: consumer,
  encoding: 'utf8',
  timeout: 30_000
})
result.explicitImportOnlyContract = {
  exitCode: requireBoundary.status,
  error: requireBoundary.stderr
}
// Fixture imports and globals must be exercised in deterministic order.
function forEachSequential(values, callback) {
  return values.reduce(
    (previous, value, index) => previous.then(() => callback(value, index)),
    Promise.resolve()
  )
}

function fixtureImports(requireProfile, named, alias) {
  if (requireProfile) {
    if (named) {
      return `const moduleSDK = require(${JSON.stringify(alias)});\nconst canonicalSDK = require('@bsv/sdk');`
    }
    return `require(${JSON.stringify(alias)});`
  }
  if (named) {
    return `import * as moduleSDK from ${JSON.stringify(alias)};\nimport * as canonicalSDK from '@bsv/sdk';`
  }
  return `import ${JSON.stringify(alias)};`
}

const profiles = [
  ...aliases.map(alias => ({ alias, requireProfile: false })),
  ...requireAliases.map(alias => ({ alias, requireProfile: true }))
]
await forEachSequential(profiles, async ({ alias, requireProfile }) => {
  const patterns = requireProfile
    ? ['require-only', 'named-require']
    : ['import-only', 'named-import']
  await forEachSequential(patterns, async pattern => {
    const caseRoot = path.join(output, alias.replaceAll('/', '_'), pattern)
    await fs.mkdir(caseRoot, { recursive: true })
    const extension = requireProfile ? 'cjs' : 'mjs'
    const entry = path.join(caseRoot, `entry.${extension}`)
    const fixture = path.join(caseRoot, `preset-global.${extension}`)
    await fs.writeFile(fixture, 'globalThis.bsv = { previousSDK: true };\n')
    const named = pattern === 'named-import' || pattern === 'named-require'
    const imports = fixtureImports(requireProfile, named, alias)
    const identity = named
      ? `
if (JSON.stringify(Object.keys(moduleSDK).sort((left, right) => left.localeCompare(right, 'en'))) !== JSON.stringify(expectedNames))
  throw new Error('Facade namespace differs');
for (const name of expectedNames)
  if (moduleSDK[name] !== canonicalSDK[name] || globalSDK[name] !== canonicalSDK[name])
    throw new Error('Global/module/root identity differs: ' + name);
if (!(publicKey instanceof canonicalSDK.Point) || !(publicKey instanceof moduleSDK.PublicKey))
  throw new Error('Cross-entry instanceof changed');
if (new globalSDK.Curve() !== new canonicalSDK.Curve()) throw new Error('Curve singleton changed');
`
      : ''
    const preset = requireProfile
      ? "require('./preset-global.cjs');"
      : "import './preset-global.mjs';"
    await fs.writeFile(entry, `${preset}\n${imports}\n${assertions}\n${identity}`)
    await forEachSequential(['native-node', 'esbuild', 'vite'], async tool => {
      let artifact = entry
      let buildError
      try {
        if (tool === 'esbuild') {
          artifact = path.join(caseRoot, 'esbuild.mjs')
          await esbuild({
            absWorkingDir: consumer,
            entryPoints: [entry],
            outfile: artifact,
            bundle: true,
            format: 'esm',
            platform: 'browser',
            target: 'es2022',
            conditions: ['browser', 'import', 'default'],
            mainFields: ['browser', 'module', 'main'],
            minify: true,
            sourcemap: true,
            logLevel: 'silent'
          })
        } else if (tool === 'vite') {
          const directory = path.join(caseRoot, 'vite')
          artifact = path.join(directory, 'bundle.mjs')
          await vite({
            root: consumer,
            configFile: false,
            logLevel: 'error',
            build: {
              lib: { entry, formats: ['es'], fileName: () => 'bundle.mjs' },
              outDir: directory,
              emptyOutDir: true,
              minify: 'esbuild',
              sourcemap: true,
              reportCompressedSize: false,
              ...(requireProfile
                ? { commonjsOptions: { include: [/node_modules/, /\.cjs$/] } }
                : {})
            }
          })
        }
      } catch (error) {
        buildError = error.message
      }
      const run = buildError
        ? undefined
        : spawnSync(process.execPath, [artifact], {
            cwd: consumer,
            encoding: 'utf8',
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024
          })
      const bytes = buildError ? undefined : await fs.readFile(artifact)
      result.cases.push({
        alias,
        pattern,
        tool,
        buildError,
        exitCode: run?.status,
        error: run?.stderr,
        sha256: bytes && sha256(bytes),
        ...(tool === 'native-node' ? {} : { bytes: bytes && sizes(bytes) })
      })
      if (!buildError && tool !== 'native-node') {
        // These pages allow the exact browser-target bundles to be exercised
        // in a real local browser in addition to the offline execution above.
        const relative = path.relative(caseRoot, artifact).split(path.sep).join('/')
        await fs.writeFile(
          path.join(caseRoot, `${tool}.html`),
          `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>SDK UMD ${tool} ${pattern}</title>
<body data-result="pending"><pre id="result">PENDING</pre><script type="module">
globalThis.fetch = () => { throw new Error('Unexpected provider request'); };
try {
  await import(${JSON.stringify('./' + relative)});
  document.body.dataset.result = 'pass';
  document.querySelector('#result').textContent = 'PASS: ${alias} ${pattern} ${tool}; ' +
    Object.keys(globalThis.bsv).length + ' canonical exports; original global descriptors and fixed public generator';
} catch (error) {
  document.body.dataset.result = 'fail';
  document.querySelector('#result').textContent = 'FAIL: ' + error.name + ': ' + error.message;
  throw error;
}
</script></body></html>\n`
        )
        browserPages.push(
          path
            .relative(output, path.join(caseRoot, `${tool}.html`))
            .split(path.sep)
            .join('/')
        )
      }
    })
  })
})
// Native fixtures construct the cold leaf before importing any SDK barrel.
// Browser fixtures import only that leaf alias, so a barrel cannot mask a
// missing initialization edge after tree shaking.
await forEachSequential(['BasePoint', 'JacobianPoint'], async leaf => {
  await forEachSequential(['', '.ts'], async suffix => {
    const alias = `@bsv/sdk/primitives/${leaf}${suffix}`
    const caseRoot = path.join(output, 'leaves', leaf + (suffix ? '-ts' : ''))
    await fs.mkdir(caseRoot, { recursive: true })
    const construction =
      leaf === 'BasePoint'
        ? "class OfflinePoint extends Leaf { constructor() { super('affine'); } }\nconst value = new OfflinePoint();"
        : 'const value = new Leaf(null, null, null);'
    const conversion = `
const curve = value.curve;
const point = curve.g;
const jacobian = point.toJ();
const converted = jacobian.toP();
if (point.toString() !== ${JSON.stringify(generator)}) throw new Error('Generator changed');
if (!converted.eq(point) || !(converted instanceof point.constructor))
  throw new Error('Point conversion or class graph changed');
if (point.curve !== curve || jacobian.curve !== curve || converted.curve !== curve ||
    new curve.constructor() !== curve) throw new Error('Curve singleton changed');
if (${JSON.stringify(leaf)} === 'BasePoint' &&
    (!(point instanceof Leaf) || !(jacobian instanceof Leaf)))
  throw new Error('Canonical BasePoint identity changed');
if (${JSON.stringify(leaf)} === 'JacobianPoint' &&
    (!(jacobian instanceof Leaf) || !value.isInfinity()))
  throw new Error('Canonical JacobianPoint identity changed');
`
    await forEachSequential(['esm', 'cjs'], async mode => {
      const loader =
        mode === 'esm'
          ? 'const load = async name => await import(name);'
          : "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst load = async name => require(name);"
      const originalPath = path.join(packageRoot, `dist/${mode}/src/primitives/${leaf}.js`)
      const original = mode === 'esm' ? pathToFileURL(originalPath).href : originalPath
      const entry = path.join(caseRoot, `native-${mode}.mjs`)
      await fs.writeFile(
        entry,
        `${loader}
const Leaf = (await load(${JSON.stringify(alias)})).default;
${construction}
${conversion}
const Original = (await load(${JSON.stringify(original)})).default;
const sdk = await load('@bsv/sdk');
const primitives = await load('@bsv/sdk/primitives');
const Point = (await load('@bsv/sdk/primitives/Point')).default;
const Curve = (await load('@bsv/sdk/primitives/Curve')).default;
const BasePoint = (await load('@bsv/sdk/primitives/BasePoint')).default;
const JacobianPoint = (await load('@bsv/sdk/primitives/JacobianPoint')).default;
if (Leaf !== Original || Leaf !== ${leaf}) throw new Error('Leaf default export changed');
if (sdk.Point !== Point || primitives.Point !== Point || sdk.Curve !== Curve || primitives.Curve !== Curve)
  throw new Error('Canonical Point or Curve identity changed');
if (!(point instanceof Point) || !(point instanceof BasePoint) ||
    !(jacobian instanceof JacobianPoint) || !(jacobian instanceof BasePoint) ||
    !(converted instanceof Point)) throw new Error('Canonical instanceof changed');
if (new Curve() !== curve) throw new Error('Canonical Curve singleton changed');
`
      )
      const run = spawnSync(process.execPath, [entry], {
        cwd: consumer,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024
      })
      result.leafCases.push({
        alias,
        mode,
        tool: 'native-node',
        exitCode: run.status,
        error: run.stderr,
        sha256: sha256(await fs.readFile(entry)),
        coldLeafBeforeBarrel: true
      })
    })
    const browserEntry = path.join(caseRoot, 'entry.mjs')
    await fs.writeFile(
      browserEntry,
      `import Leaf from ${JSON.stringify(alias)};
${construction}
${conversion}
export default Leaf;
`
    )
    await forEachSequential(['esbuild', 'vite'], async tool => {
      const directory = path.join(caseRoot, tool)
      const artifact = path.join(directory, 'bundle.mjs')
      await fs.mkdir(directory, { recursive: true })
      const warnings = []
      let buildError
      let initializationRetained = false
      let wrapperSourceProvenance = false
      let wrapperSourceSHA256
      try {
        if (tool === 'esbuild') {
          const built = await esbuild({
            absWorkingDir: consumer,
            entryPoints: [browserEntry],
            outfile: artifact,
            bundle: true,
            format: 'esm',
            platform: 'browser',
            target: 'es2022',
            conditions: ['browser', 'import', 'default'],
            mainFields: ['browser', 'module', 'main'],
            minify: true,
            sourcemap: true,
            logLevel: 'silent'
          })
          warnings.push(...built.warnings.map(warning => warning.text))
        } else {
          const logger = createLogger('silent')
          logger.warn = message => {
            warnings.push(message)
          }
          logger.warnOnce = logger.warn
          await vite({
            root: consumer,
            configFile: false,
            customLogger: logger,
            logLevel: 'silent',
            build: {
              lib: { entry: browserEntry, formats: ['es'], fileName: () => 'bundle.mjs' },
              outDir: directory,
              emptyOutDir: true,
              minify: 'esbuild',
              sourcemap: true,
              reportCompressedSize: false
            }
          })
        }
        assert.equal(warnings.length, 0, 'Leaf bundling must have zero warnings')
        const code = await fs.readFile(artifact, 'utf8')
        initializationRetained = /\.assert\(\s*(?:true|!0)\s*\)/.test(code)
        assert.ok(initializationRetained, 'Minification removed the initialization guard')
        const sourceMap = JSON.parse(await fs.readFile(artifact + '.map', 'utf8'))
        const wrapperPath = path.join(packageRoot, `dist/esm/src/primitives/entries/${leaf}.js`)
        const wrapperJavaScript = await fs.readFile(wrapperPath, 'utf8')
        const wrapperMap = JSON.parse(await fs.readFile(wrapperPath + '.map', 'utf8'))
        const wrapperTypeScript = wrapperMap.sourcesContent?.[0]
        // esbuild composes the SDK's TypeScript source map; Vite retains the
        // exact compiled wrapper JavaScript. Both must match the packed input.
        wrapperSourceProvenance = sourceMap.sources.some((source, index) => {
          const normalized = source.replaceAll('\\', '/')
          const content = sourceMap.sourcesContent?.[index]
          const matches = normalized.endsWith(`/src/primitives/entries/${leaf}.ts`)
            ? content === wrapperTypeScript
            : normalized.endsWith(`/src/primitives/entries/${leaf}.js`) &&
              content === wrapperJavaScript
          if (matches && /Curve\.assert\(true\)/.test(content ?? '')) {
            wrapperSourceSHA256 = sha256(content)
            return true
          }
          return false
        })
        assert.ok(
          wrapperSourceProvenance,
          'Bundle source map lacks the actual wrapper initialization'
        )
      } catch (error) {
        buildError = error.message
      }
      const run = buildError
        ? undefined
        : spawnSync(process.execPath, [artifact], {
            cwd: consumer,
            encoding: 'utf8',
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024
          })
      const bytes = buildError ? undefined : await fs.readFile(artifact)
      result.leafCases.push({
        alias,
        mode: 'esm',
        tool,
        buildError,
        exitCode: run?.status,
        error: run?.stderr,
        warnings,
        initializationRetained,
        wrapperSourceProvenance,
        wrapperSourceSHA256,
        aliasOnlyImport: true,
        sha256: bytes && sha256(bytes),
        bytes: bytes && sizes(bytes)
      })
      if (!buildError) {
        await fs.writeFile(
          path.join(caseRoot, `${tool}.html`),
          `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>SDK leaf ${alias} ${tool}</title>
<body data-result="pending"><pre id="result">PENDING</pre><script type="module">
globalThis.fetch = () => { throw new Error('Unexpected provider request'); };
try {
  await import(${JSON.stringify('./' + tool + '/bundle.mjs')});
  document.body.dataset.result = 'pass';
  document.querySelector('#result').textContent = 'PASS: ${alias} ${tool}; alias-only import, fixed public generator, canonical graph and conversions';
} catch (error) {
  document.body.dataset.result = 'fail';
  document.querySelector('#result').textContent = 'FAIL: ' + error.name + ': ' + error.message;
  throw error;
}
</script></body></html>\n`
        )
        browserPages.push(
          path
            .relative(output, path.join(caseRoot, `${tool}.html`))
            .split(path.sep)
            .join('/')
        )
      }
    })
  })
})
await fs.writeFile(
  path.join(output, 'index.html'),
  `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>SDK packed UMD browser contracts</title>
<body data-result="pending"><h1>SDK packed UMD browser contracts</h1><pre id="result">PENDING</pre>
${browserPages.map((page, index) => `<h2>${page}</h2><iframe title="Contract ${index + 1}" src="./${page}" style="width:100%;height:100px"></iframe>`).join('\n')}
<script>
const frames = [...document.querySelectorAll('iframe')];
const deadline = Date.now() + 30000;
const timer = setInterval(() => {
  const states = frames.map(frame => frame.contentDocument?.body?.dataset.result ?? 'pending');
  const passed = states.filter(state => state === 'pass').length;
  const failed = states.filter(state => state === 'fail').length;
  document.querySelector('#result').textContent = passed + '/' + frames.length + ' PASS; ' + failed + ' FAIL';
  if (passed === frames.length || failed || Date.now() > deadline) {
    clearInterval(timer);
    document.body.dataset.result = passed === frames.length ? 'pass' : 'fail';
  }
}, 100);
</script></body></html>\n`
)
result.browserPages = browserPages
await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(result, null, 2) + '\n')
console.log(
  JSON.stringify(
    {
      sdkVersion: result.sdkVersion,
      output,
      packedArtifact,
      explicitImportOnlyContract: result.explicitImportOnlyContract,
      classic: result.classic,
      cases: result.cases.map(({ alias, pattern, tool, exitCode, buildError, error }) => ({
        alias,
        pattern,
        tool,
        exitCode,
        buildError,
        error
      })),
      leafCases: result.leafCases
    },
    null,
    2
  )
)
if (
  result.explicitImportOnlyContract.exitCode !== 0 ||
  result.cases.some(test => test.exitCode !== 0 || test.buildError) ||
  result.leafCases.some(test => test.exitCode !== 0 || test.buildError)
)
  process.exitCode = 1
