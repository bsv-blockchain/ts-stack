import path from 'node:path'

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
 * @param moduleExports pass in `module.exports` to resolve functionName
 * @returns the example execution promise, or `undefined` when no function matches
 */
export function runArgv2Function(
  moduleExports: Record<string, unknown>
): Promise<void> | undefined {
  const scriptPath = process.argv[1] ?? ''
  const functionName = process.argv[2] || path.parse(scriptPath).name
  const candidate = moduleExports[functionName]
  if (typeof candidate !== 'function') return undefined

  const run = candidate as () => void | Promise<void>
  return Promise.resolve()
    .then(() => run())
    .catch(error => {
      console.error(error)
    })
}
