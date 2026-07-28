/**
 * If a log is being kept, add a time stamped line.
 * @param log  Optional time stamped log to extend, or an object with a log property to update
 * @param lineToAdd Content to add to line.
 * @returns undefined or log extended by time stamped `lineToAdd` and new line.
 */
export function stampLog(log: string | undefined | { log?: string }, lineToAdd: string): string | undefined {
  const add = `${new Date().toISOString()} ${lineToAdd}\n`
  if (typeof log === 'object' && typeof log.log === 'string') {
    log.log = log.log + add
    return log.log
  }
  if (typeof log === 'string') return log + add
  return undefined
}

interface StampLogEntry {
  when: number
  rest: string
  delta: number
  newClock: boolean
}

function parseStampLog(log: string): { data: StampLogEntry[]; newClocks: number[] } {
  const data: StampLogEntry[] = []
  const newClocks: number[] = []
  let last = 0
  for (const line of log.split('\n')) {
    const spaceAt = line.indexOf(' ')
    if (spaceAt < 0) continue
    const when = new Date(line.substring(0, spaceAt)).getTime()
    const rest = line.substring(spaceAt + 1)
    const delta = when - (last !== 0 ? last : when)
    const newClock = rest.includes('**NETWORK**')
    if (newClock) newClocks.push(data.length)
    data.push({ when, rest, delta, newClock })
    last = when
  }
  return { data, newClocks }
}

function adjustNetworkDeltas(data: StampLogEntry[], newClocks: number[], total: number): void {
  if (newClocks.length % 2 !== 0) return

  let network = total
  let lastNewClock = 0
  for (const newClock of newClocks) {
    network -= data[newClock - 1].when - data[lastNewClock].when
    lastNewClock = newClock
  }
  network -= data[data.length - 1].when - data[lastNewClock].when

  let networks = newClocks.length
  for (const newClock of newClocks) {
    const delta = networks > 1 ? Math.floor(network / networks) : network
    data[newClock].delta = delta
    network -= delta
    networks--
  }
}

function formatStampLog(data: StampLogEntry[], total: number): string {
  let formatted = `${new Date(data[0].when).toISOString()} Total = ${total} msecs\n`
  for (const entry of data) {
    const delta = entry.delta.toString()
    formatted += `${' '.repeat(8 - delta.length)}${delta} ${entry.rest}\n`
  }
  return formatted
}

/**
 * Replaces individual timestamps with delta msecs.
 * Looks for two network crossings and adjusts clock for clock skew if found.
 * Assumes log built by repeated calls to `stampLog`
 * @param log Each logged event starts with ISO time stamp, space, rest of line, terminated by `\n`.
 * @returns reformated multi-line event log
 */
export function stampLogFormat(log?: string): string {
  if (typeof log !== 'string') return ''
  const { data, newClocks } = parseStampLog(log)
  const total = data[data.length - 1].when - data[0].when
  adjustNetworkDeltas(data, newClocks, total)
  return formatStampLog(data, total)
}
