import { execFileSync } from 'node:child_process'

// Each cold process imports its leaf first. Importing the root SDK in this test
// process would initialize the graph and hide an import-order regression.
describe('packaged primitive leaf initialization and canonical class identity', () => {
  for (const mode of ['esm', 'cjs'] as const) {
    for (const leaf of ['BasePoint', 'JacobianPoint'] as const) {
      test.each(['', '.ts'])(`${mode} ${leaf}%s is safe as the first import`, suffix => {
        const alias = `@bsv/sdk/primitives/${leaf}${suffix}`
        const loader =
          mode === 'esm'
            ? 'const load = async name => await import(name)'
            : `import { createRequire } from 'node:module';
             const require = createRequire(import.meta.url);
             const load = async name => require(name)`
        const construct =
          leaf === 'BasePoint'
            ? `class TestPoint extends Leaf { constructor() { super('affine') } }
             const entryInstance = new TestPoint()`
            : 'const entryInstance = new Leaf(null, null, null)'
        const script = `
          import assert from 'node:assert/strict';
          ${loader};
          const Leaf = (await load(${JSON.stringify(alias)})).default;
          ${construct};
          const Original = (await load('./dist/${mode}/src/primitives/${leaf}.js')).default;
          const sdk = await load('@bsv/sdk');
          const primitives = await load('@bsv/sdk/primitives');
          const Curve = (await load('@bsv/sdk/primitives/Curve')).default;
          const Point = (await load('@bsv/sdk/primitives/Point')).default;
          const BasePoint = (await load('@bsv/sdk/primitives/BasePoint')).default;
          const JacobianPoint = (await load('@bsv/sdk/primitives/JacobianPoint')).default;
          assert.equal(Leaf, Original);
          assert.equal(Leaf, (await load(${JSON.stringify(`@bsv/sdk/primitives/${leaf}${suffix === '' ? '.ts' : ''}`)})).default);
          assert.equal(sdk.Curve, Curve);
          assert.equal(primitives.Curve, Curve);
          assert.equal(sdk.Point, Point);
          assert.equal(primitives.Point, Point);
          const curve = new Curve();
          assert.equal(entryInstance.curve, curve);
          assert.equal(new Curve(), curve);
          assert.equal(curve.g.toString(), '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
          assert.ok(curve.g instanceof Point);
          assert.ok(curve.g instanceof BasePoint);
          assert.ok(curve.g.toJ() instanceof JacobianPoint);
          assert.ok(curve.g.toJ() instanceof BasePoint);
          assert.ok(curve.g.toJ().toP() instanceof Point);
          assert.ok(curve.g.toJ().toP().eq(curve.g));
        `
        expect(
          execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 20_000
          })
        ).toBe('')
      })
    }
  }
})
