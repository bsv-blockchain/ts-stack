export type ScriptResource = 'stack' | 'alt-stack' | 'element-size'

/**
 * Raised when an explicitly configured local interpreter budget is exhausted.
 *
 * This is deliberately distinct from ScriptEvaluationError: exhausting a
 * caller-supplied resource budget does not prove that a script is invalid.
 */
export default class ScriptResourceLimitError extends Error {
  constructor (
    public readonly resource: ScriptResource,
    public readonly limit: number | bigint,
    public readonly attempted: number | bigint
  ) {
    const labels: Record<ScriptResource, string> = {
      stack: 'Stack memory usage',
      'alt-stack': 'Alt stack memory usage',
      'element-size': 'Script element allocation'
    }
    const label = labels[resource]
    super(`${label} has exceeded ${limit} bytes`)
    this.name = 'ScriptResourceLimitError'
  }
}
