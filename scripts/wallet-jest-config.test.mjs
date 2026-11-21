import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'

const wallet = resolve(import.meta.dirname, '../packages/wallet/wallet-toolbox')
const require = createRequire(join(wallet, 'package.json'))
const { createTransformer } = require('ts-jest').default

test('actual Jest local intrinsic bindings preserve realm identity, spies and dynamic host capabilities', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'wallet-jest-intrinsics-'))
  const source = await require(join(wallet, 'jest.config.cjs'))()
  assert.deepEqual(source.sandboxInjectedGlobals, [
    'Math',
    'String',
    'Number',
    'Object',
    'Array',
    'Reflect'
  ])
  try {
    writeFileSync(
      join(sandbox, 'intrinsics.test.cjs'),
      `
      const { Buffer } = require('node:buffer');
      test('realm and replaceable capabilities remain intact', () => {
        for (const [name, value] of Object.entries({Math, String, Number, Object, Array, Reflect}))
          expect(value).toBe(globalThis[name]);
        expect(Object.getPrototypeOf({})).toBe(Object.prototype);
        expect(Object.getPrototypeOf([])).toBe(Array.prototype);
        expect(Buffer).toBe(globalThis.Buffer);
        const original = Number.isSafeInteger;
        const spy = jest.spyOn(Number, 'isSafeInteger');
        expect(globalThis.Number.isSafeInteger).toBe(spy);
        expect(Number.isSafeInteger(3)).toBe(true);
        expect(spy).toHaveBeenCalledWith(3);
        spy.mockRestore();
        expect(Number.isSafeInteger).toBe(original);
        try {
          jest.useFakeTimers({now: 123456});
          expect(Date).toBe(globalThis.Date);
          expect(Date.now()).toBe(123456);
        } finally { jest.useRealTimers(); }
        const beforeFetch = globalThis.fetch, beforeWasm = globalThis.WebAssembly;
        try {
          const marker = () => Promise.reject(new Error('synthetic offline host'));
          globalThis.fetch = marker;
          globalThis.WebAssembly = undefined;
          expect(fetch).toBe(marker);
          expect(WebAssembly).toBeUndefined();
        } finally {
          globalThis.fetch = beforeFetch;
          globalThis.WebAssembly = beforeWasm;
        }
      });
    `
    )
    // This temporary control fixture has no wallet assets to own. Real wallet
    // invocations retain their source-owned lifecycle and compiler configuration.
    const config = {
      ...source,
      rootDir: sandbox,
      roots: [sandbox],
      testMatch: ['**/*.test.cjs'],
      moduleNameMapper: {},
      transform: {},
      globalSetup: undefined,
      globalTeardown: undefined
    }
    execFileSync(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        '--runInBand',
        '--watchman=false',
        '--config',
        JSON.stringify(config)
      ],
      { cwd: wallet, encoding: 'utf8' }
    )
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('wallet TypeScript transform retains its compiler configuration in a relocated mutation sandbox', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'wallet-jest-config-'))
  try {
    // Mirror the copied package's relative extends: it is invalid at this depth.
    // A transform that discovers this file from the relocated root must fail.
    writeFileSync(
      join(sandbox, 'tsconfig.json'),
      JSON.stringify({ extends: './missing-shared-config.json' })
    )
    copyFileSync(join(wallet, 'jest.config.cjs'), join(sandbox, 'jest.config.cjs'))
    copyFileSync(join(wallet, 'tsconfig.jest.json'), join(sandbox, 'tsconfig.jest.json'))
    const copiedConfig = await require(join(sandbox, 'jest.config.cjs'))()
    const target = buildMutationTargets(resolve(import.meta.dirname, '..'))[
      'wallet-current-brc38-authenticated-private-stage-node'
    ]
    const config = { ...copiedConfig, ...target.runnerOptions.jest.config, rootDir: sandbox }
    const source = 'export const result: number = 6 * 7'
    const filename = join(sandbox, 'example.ts')
    writeFileSync(filename, source)
    const options = {
      config,
      configString: JSON.stringify(config),
      cacheFS: new Map(),
      instrument: false,
      supportsDynamicImport: false,
      supportsExportNamespaceFrom: false,
      supportsStaticESM: false,
      supportsTopLevelAwait: false
    }
    const [, compiler] = config.transform['^.+\\.ts$']
    const transformed = createTransformer(compiler).process(source, filename, options)
    const exports = {}
    runInNewContext(transformed.code, { exports })
    assert.equal(exports.result, 42)
    const copiedOptions = { ...copiedConfig, rootDir: sandbox }
    const [, copiedCompiler] = copiedConfig.transform['^.+\\.ts$']
    assert.throws(
      () =>
        createTransformer(copiedCompiler).process(source, filename, {
          ...options,
          config: copiedOptions,
          configString: JSON.stringify(copiedOptions)
        }),
      /missing-shared-config/
    )
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('browser compilation retains package class-field semantics without relocated config inheritance', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'wallet-browser-config-'))
  const { build, stop } = require('esbuild')
  try {
    const filename = join(sandbox, 'example.ts')
    writeFileSync(filename, 'export class Example { optional?: string }')
    copyFileSync(join(wallet, 'tsconfig.json'), join(sandbox, 'tsconfig.json'))
    copyFileSync(
      join(wallet, 'client/test/tsconfig.browser.json'),
      join(sandbox, 'tsconfig.browser.json')
    )
    const compile = tsconfig =>
      build({
        entryPoints: [filename],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'cjs',
        target: 'es2022',
        logLevel: 'silent',
        tsconfig
      })
    const original = await compile(join(wallet, 'tsconfig.json'))
    const relocated = await compile(join(sandbox, 'tsconfig.browser.json'))
    const broken = await compile(join(sandbox, 'tsconfig.json'))
    assert.equal(original.warnings.length, 0)
    assert.equal(relocated.warnings.length, 0)
    assert.deepEqual(relocated.outputFiles[0].contents, original.outputFiles[0].contents)
    assert.ok(
      broken.warnings.some(warning => warning.text.includes('Cannot find base config file'))
    )
    const module = { exports: {} }
    runInNewContext(relocated.outputFiles[0].text, { module })
    assert.ok(Object.hasOwn(new module.exports.Example(), 'optional'))
    assert.notDeepEqual(broken.outputFiles[0].contents, original.outputFiles[0].contents)
  } finally {
    await stop()
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('actual Stryker project discovery excludes copied Worker ownership but retains authored inputs', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'wallet-stryker-assets-'))
  const root = resolve(import.meta.dirname, '..')
  const reader = resolve(root, 'node_modules/@stryker-mutator/core/dist/src/fs/project-reader.js')
  const config = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { default: config } = await import(${JSON.stringify(join(root, 'governance/mutation-testing/stryker.config.mjs'))}); console.log(JSON.stringify(config))`
      ],
      {
        cwd: wallet,
        env: { ...process.env, TS_STACK_MUTATION_TARGET: 'wallet-portable-canonical-chunks' },
        encoding: 'utf8'
      }
    )
  )
  const generated = [
    'test/.jest-worker-assets/manifest.json',
    'src/storage/portable/Brc39Argon2Worker.js',
    'src/utility/hashWasm.js',
    'src/utility/Argon2idBackend.js'
  ]
  const authored = [
    'src/storage/portable/Brc39Argon2Worker.ts',
    'src/utility/hashWasm.ts',
    'src/utility/Argon2idBackend.ts',
    'src/utility/promiseFromSync.ts',
    'src/utility/promiseFromSync.test.ts',
    'test/utils/ownedBrc39WorkerAssets.cjs'
  ]
  try {
    for (const file of [...generated, ...authored]) {
      const filename = join(sandbox, file)
      mkdirSync(resolve(filename, '..'), { recursive: true })
      writeFileSync(filename, 'public synthetic fixture')
    }
    writeFileSync(
      join(sandbox, 'config.json'),
      JSON.stringify({
        ...config,
        tempDirName: '.stryker-tmp',
        incrementalFile: 'incremental.json',
        htmlReporter: { fileName: 'reports/index.html' }
      })
    )
    const files = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import fs from 'node:fs/promises'; import path from 'node:path';
      await import(${JSON.stringify(require.resolve('@stryker-mutator/core'))});
      const { ProjectReader } = await import(${JSON.stringify(reader)});
      const config = JSON.parse(await fs.readFile('config.json', 'utf8'));
      const reader = new ProjectReader(fs, console, config);
      console.log(JSON.stringify((await reader.resolveInputFileNames()).map(file => path.relative(process.cwd(), file))));
    `
        ],
        { cwd: sandbox, encoding: 'utf8' }
      )
    )
    for (const file of generated) assert.ok(!files.includes(file), file)
    for (const file of authored) assert.ok(files.includes(file), file)
    assert.equal(config.concurrency, 1)
    assert.equal(config.maxTestRunnerReuse, 20)
    assert.equal(config.timeoutMS, 2000)
    assert.equal(config.timeoutFactor, 3)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})
