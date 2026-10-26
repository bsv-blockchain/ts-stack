import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function mutationBuildDependencies(args) {
  const dependencies = []
  for (let index = 0; index < args.length; index += 2) {
    const dependency = args[index + 1]
    if (
      args[index] !== '--dependency' ||
      typeof dependency !== 'string' ||
      !/^@bsv\/[a-z0-9][a-z0-9-]*$/.test(dependency) ||
      dependencies.includes(dependency)
    ) {
      throw new Error('Expected distinct --dependency @bsv/package arguments')
    }
    dependencies.push(dependency)
  }
  return dependencies
}

/** Build the same prerequisites in order, then the instrumented sandbox itself. */
export function executeMutationBuilds(
  args,
  { cwd = process.cwd(), env = process.env, run = spawnSync } = {}
) {
  const dependencies = mutationBuildDependencies(args)
  const commands = [...dependencies.map(name => ['--filter', name, 'build']), ['build']]
  for (const command of commands) {
    const result = run('pnpm', command, { cwd, env, stdio: 'inherit', shell: false })
    if (result.error) throw result.error
    if (result.signal) throw new Error('Mutation build terminated by ' + result.signal)
    if (result.status !== 0) return result.status ?? 1
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = executeMutationBuilds(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Mutation build failed')
    process.exitCode = 1
  }
}
