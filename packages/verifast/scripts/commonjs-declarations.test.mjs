import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { emitCommonJsDeclarations } from './commonjs-declarations.mjs'

test('conditional declarations retain nominal SDK identity in ESM and CommonJS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verifast-declarations-'))
  async function put(path, contents) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, contents)
  }
  function diagnostics(path) {
    const program = ts.createProgram([join(root, path)], {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: []
    })
    return ts.getPreEmitDiagnostics(program)
  }
  const display = errors =>
    errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n')
  try {
    await put(
      'node_modules/@fixture/sdk/package.json',
      JSON.stringify({
        name: '@fixture/sdk',
        type: 'module',
        exports: {
          '.': { import: { types: './import.d.ts' }, require: { types: './require.d.cts' } },
          './transaction/Transaction': {
            import: { types: './transaction.d.ts' },
            require: { types: './transaction.d.cts' }
          }
        }
      })
    )
    const sdk = 'export declare class Transaction { #private; }\n'
    await put('node_modules/@fixture/sdk/transaction.d.ts', sdk)
    await put(
      'node_modules/@fixture/sdk/import.d.ts',
      "export { Transaction } from './transaction.js';\n"
    )
    await put('node_modules/@fixture/sdk/transaction.d.cts', sdk)
    await put(
      'node_modules/@fixture/sdk/require.d.cts',
      "export { Transaction } from './transaction.cjs';\n"
    )
    await put(
      'node_modules/@fixture/verifast/package.json',
      JSON.stringify({
        name: '@fixture/verifast',
        type: 'module',
        exports: {
          '.': { import: { types: './dist/mod.d.ts' }, require: { types: './dist/mod.d.cts' } },
          './umd': { import: { types: './dist/umd.d.ts' }, require: { types: './dist/umd.d.cts' } }
        }
      })
    )
    const prefix = 'node_modules/@fixture/verifast/dist/'
    const entry =
      "// Leave './src/comment.js' and literal types alone.\nexport { Verifier } from './src/nested/verifier.js';\nexport type Literal = './src/literal.js';\nexport type Backend = import('./src/nested/verifier.js').Verifier;\n"
    for (const name of ['mod', 'umd']) {
      await put(prefix + name + '.d.ts', entry)
      await put(prefix + name + '.d.cts', entry)
    }
    await put(
      prefix + 'src/nested/verifier.d.ts',
      "import type { Transaction } from '@fixture/sdk/transaction/Transaction';\nimport type { Result } from '../result.js';\nexport declare class Verifier { verify(transaction: Transaction): Result; }\n"
    )
    await put(prefix + 'src/result.d.ts', 'export type Result = boolean;\n')
    await put(prefix + 'mod.browser.d.ts', 'export type Browser = true;\n')
    await put(prefix + 'cjs/mod.cjs', 'runtime sentinel\n')
    await put(prefix + 'src/runtime.js', 'not a declaration\n')
    for (const extension of ['mts', 'cts']) {
      await put(
        'consumer.' + extension,
        "import { Transaction } from '@fixture/sdk';\nimport { Verifier, type Backend } from '@fixture/verifast';\nimport { Verifier as UmdVerifier } from '@fixture/verifast/umd';\nconst backend: { verify(transaction: Transaction): boolean } = new Verifier();\nconst umd: typeof backend = new UmdVerifier();\nconst imported: Backend = new Verifier();\nbackend.verify(new Transaction());\numd.verify(new Transaction());\nimported.verify(new Transaction());\n"
      )
    }
    assert.deepEqual(diagnostics('consumer.mts'), [])
    const originalErrors = diagnostics('consumer.cts')
    assert.ok(
      originalErrors.some(error => error.code === 2322 || error.code === 2345),
      display(originalErrors)
    )
    assert.match(display(originalErrors), /private/)
    const distribution = pathToFileURL(join(root, prefix))
    await emitCommonJsDeclarations(distribution)
    for (const extension of ['mts', 'cts']) {
      const errors = diagnostics('consumer.' + extension)
      assert.equal(errors.length, 0, display(errors))
    }
    for (const name of ['mod', 'umd']) {
      assert.equal(await readFile(join(root, prefix + name + '.d.ts'), 'utf8'), entry)
      const emitted = await readFile(join(root, prefix + name + '.d.cts'), 'utf8')
      assert.match(emitted, /\.\/cjs\/src\/nested\/verifier\.js/)
      assert.ok(emitted.includes("// Leave './src/comment.js' and literal types alone."))
      assert.ok(emitted.includes("export type Literal = './src/literal.js';"))
    }
    assert.equal(
      await readFile(join(root, prefix + 'mod.browser.d.ts'), 'utf8'),
      'export type Browser = true;\n'
    )
    assert.equal(await readFile(join(root, prefix + 'cjs/mod.cjs'), 'utf8'), 'runtime sentinel\n')
    await assert.rejects(readFile(join(root, prefix + 'cjs/src/runtime.js')), { code: 'ENOENT' })
    const first = await readFile(join(root, prefix + 'mod.d.cts'))
    await put(prefix + 'cjs/src/stale.d.ts', 'stale\n')
    await emitCommonJsDeclarations(distribution)
    assert.deepEqual(await readFile(join(root, prefix + 'mod.d.cts')), first)
    await assert.rejects(readFile(join(root, prefix + 'cjs/src/stale.d.ts')), { code: 'ENOENT' })
    for (const extension of ['mts', 'cts']) {
      assert.deepEqual(diagnostics('consumer.' + extension), [])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
