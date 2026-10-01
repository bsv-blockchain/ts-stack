import { execFileSync } from 'node:child_process'

describe('packaged UMD facade and classic global contract', () => {
  for (const mode of ['esm', 'cjs'] as const) {
    const aliases = mode === 'esm' ? ['@bsv/sdk/umd', '@bsv/sdk/umd.ts'] : ['@bsv/sdk/umd.ts']
    for (const alias of aliases) {
      test.each(['side-effect', 'named'])(
        `${mode} ${alias} %s preserves canonical globals`,
        pattern => {
          const loader =
            mode === 'esm'
              ? 'const load = async name => await import(name)'
              : `import { createRequire } from 'node:module';
             const require = createRequire(import.meta.url);
             const load = async name => require(name)`
          const script = `
          import assert from 'node:assert/strict';
          import fs from 'node:fs';
          import vm from 'node:vm';
          ${loader};
          const previous = { previousSDK: true };
          globalThis.bsv = previous;
          const facade = await load(${JSON.stringify(alias)});
          const globalSDK = globalThis.bsv;
          assert.notEqual(globalSDK, previous);
          const browser = vm.createContext({ TextEncoder, TextDecoder, atob, btoa,
            crypto: globalThis.crypto, URL, URLSearchParams, AbortController,
            setTimeout, clearTimeout,
            fetch() { throw new Error('Import must not make network requests'); } });
          vm.runInContext(fs.readFileSync('./dist/umd/bundle.js', 'utf8'), browser,
            { timeout: 20000 });
          const names = Object.keys(browser.bsv).sort();
          assert.deepEqual(Object.keys(globalSDK).sort(), names);
          const shape = d => ({ enumerable: d.enumerable, configurable: d.configurable,
            ...('writable' in d ? { writable: d.writable } : {}),
            ...('get' in d ? { getter: typeof d.get === 'function' } : {}),
            ...('set' in d ? { setter: typeof d.set === 'function' } : {}) });
          for (const key of [...names, '__esModule', Symbol.toStringTag]) {
            assert.deepEqual(shape(Object.getOwnPropertyDescriptor(globalSDK, key)),
              shape(Object.getOwnPropertyDescriptor(browser.bsv, key)));
          }
          assert.equal(globalSDK.__esModule, true);
          assert.equal(globalSDK[Symbol.toStringTag], 'Module');
          const generator = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
          const publicKey = globalSDK.PrivateKey.fromString('1').toPublicKey();
          assert.equal(publicKey.toString(), generator);
          assert.equal(browser.bsv.PrivateKey.fromString('1').toPublicKey().toString(), generator);
          assert.ok(publicKey instanceof globalSDK.PublicKey);
          assert.ok(publicKey instanceof globalSDK.Point);
          if (${JSON.stringify(pattern)} === 'named') {
            const canonicalSDK = await load('@bsv/sdk');
            assert.deepEqual(Object.keys(facade).sort(), names);
            for (const name of names) {
              assert.equal(globalSDK[name], canonicalSDK[name], name);
              assert.equal(facade[name], canonicalSDK[name], name);
            }
            assert.ok(publicKey instanceof canonicalSDK.Point);
            assert.equal(new globalSDK.Curve(), new canonicalSDK.Curve());
          }
        `
          expect(
            execFileSync(process.execPath, ['--input-type=module', '-e', script], {
              cwd: process.cwd(),
              encoding: 'utf8',
              timeout: 30_000
            })
          ).toBe('')
        }
      )
    }
  }

  test('the explicit ./umd entry keeps its import-only condition', () => {
    const script = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      assert.throws(() => require('@bsv/sdk/umd'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    `
    expect(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 20_000
      })
    ).toBe('')
  })
})
