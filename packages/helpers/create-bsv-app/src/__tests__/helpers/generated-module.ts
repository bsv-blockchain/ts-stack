import ts from 'typescript'

// Transpiles emitted TypeScript and evaluates it as CommonJS. `@bsv/sdk` and
// `@bsv/wallet-helper` resolve to the real workspace packages, `./x.js` siblings come from
// `modules`, and anything else throws so an unexpected import fails loudly.
export function loadGenerated(
  source: string,
  modules: Record<string, unknown> = {},
  opts: { jsx?: boolean } = {}
): Record<string, unknown> {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      ...(opts.jsx === true ? { jsx: ts.JsxEmit.ReactJSX } : {})
    }
  }).outputText
  const real: Record<string, () => unknown> = {
    '@bsv/sdk': () => require('@bsv/sdk'),
    '@bsv/wallet-helper': () => require('@bsv/wallet-helper')
  }
  const resolve = (id: string): unknown => {
    if (id in real) return real[id]()
    if (id in modules) return modules[id]
    throw new Error(`generated module imported unexpected '${id}'`)
  }
  const exports: Record<string, unknown> = {}
  new Function('require', 'exports', compiled)(resolve, exports)
  return exports
}
