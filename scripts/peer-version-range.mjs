/** The governed peer syntax is complete stable caret versions, optionally joined by ` || `. */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 64) return null
  const match = VERSION_PATTERN.exec(value)
  if (match === null) return null
  const parts = match.slice(1).map(Number)
  if (!parts.every(Number.isSafeInteger)) return null
  return { major: parts[0], minor: parts[1], patch: parts[2] }
}

function compareVersion(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function acceptsCaret(minimum, current) {
  if (compareVersion(current, minimum) < 0) return false
  if (minimum.major > 0) return current.major === minimum.major
  if (minimum.minor > 0) return current.major === 0 && current.minor === minimum.minor
  return current.major === 0 && current.minor === 0 && current.patch === minimum.patch
}

/** Validate every alternative before testing whether any complete caret range includes the workspace version. */
export function acceptsPeerVersion(range, workspaceVersion) {
  if (typeof range !== 'string' || range.length === 0 || range.length > 1_024) return false
  const current = parseVersion(workspaceVersion)
  if (current === null) return false
  const alternatives = range.split(' || ')
  const minimums = alternatives.map(alternative =>
    alternative.startsWith('^') ? parseVersion(alternative.slice(1)) : null
  )
  if (minimums.includes(null)) return false
  return minimums.some(minimum => acceptsCaret(minimum, current))
}
