import path from 'path'

/**
 * Used to run a named function from a command line of the form:
 *
 * `npx txs filename.ts functionName`
 *
 * Where `functionName` is an exported async function taking no arguments returning void.
 *
 * Does nothing if functionName doesn't resolve to an exported function.
 *
 * Optionally, if there is a functionName in `module_exports` that matches the filename,
 * then 'functionName' can be ommitted.
 *
 * @param module_exports pass in `module.exports` to resolve functionName
 */
export function runArgv2Function(module_exports: object): void {
  let functionName = process.argv[2] || path.parse(process.argv[1]).name
  if (functionName && module_exports[functionName]) {
    const fn = module_exports[functionName] as () => Promise<void>
    fn().catch(console.error)
  }
}
