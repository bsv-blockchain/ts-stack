import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function limitedOutput(value, maximumCharacters) {
  const output = value?.toString().trim()
  if (!output || maximumCharacters == null || output.length <= maximumCharacters) {
    return output
  }

  const retainedCharacters = Math.floor(maximumCharacters / 2)
  return [
    output.slice(0, retainedCharacters),
    `\n... ${output.length - maximumCharacters} characters omitted ...\n`,
    output.slice(-retainedCharacters)
  ].join('')
}

function commandError(error, maximumCharacters) {
  const details = [error.stdout, error.stderr]
    .map(value => limitedOutput(value, maximumCharacters))
    .filter(Boolean)
    .join('\n')
  return details || error.message
}

export function createCommandRunner({ timeoutMs, maxBufferBytes, maxErrorOutputCharacters }) {
  return async function run(command, arguments_, options = {}) {
    try {
      return await execFileAsync(command, arguments_, {
        encoding: 'utf8',
        maxBuffer: maxBufferBytes,
        timeout: timeoutMs,
        ...options
      })
    } catch (error) {
      throw new Error(
        `${command} ${arguments_.join(' ')} failed:\n${commandError(error, maxErrorOutputCharacters)}`
      )
    }
  }
}
