/**
 * If a log is being kept, add a time stamped line.
 * @param log  Optional time stamped log to extend, or an object with a log property to update
 * @param lineToAdd Content to add to line.
 * @returns undefined or log extended by time stamped `lineToAdd` and new line.
 */
export function stampLog(log: string | undefined | { log?: string }, lineToAdd: string): string | undefined {
  const add = `${new Date().toISOString()} ${lineToAdd}\n`
  if (typeof log === 'object' && typeof log.log === 'string') return (log.log = log.log + add)
  if (typeof log === 'string') return log + add
  return undefined
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
  const logLines = log.split('\n')
  const data: {
    when: number
    rest: string
    delta: number
    newClock: boolean
  }[] = []
  let last = 0
  const newClocks: number[] = []
  for (const line of logLines) {
    const spaceAt = line.indexOf(' ')
    if (spaceAt > -1) {
      const when = new Date(line.substring(0, spaceAt)).getTime()
      const rest = line.substring(spaceAt + 1)
      const delta = when - (last || when)
      const newClock = rest.indexOf('**NETWORK**') > -1
      if (newClock) newClocks.push(data.length)
      data.push({ when, rest, delta, newClock })
      last = when
    }
  }
  const total = data[data.length - 1].when - data[0].when
  if (newClocks.length % 2 === 0) {
    // Adjust for paired network crossing times and clock skew between clocks.
    let network = total
    let lastNewClock = 0
    for (const newClock of newClocks) {
      network -= data[newClock - 1].when - data[lastNewClock].when
      lastNewClock = newClock
    }
    network -= data[data.length - 1].when - data[lastNewClock].when
    let networks = newClocks.length
    for (const newClock of newClocks) {
      const n = networks > 1 ? Math.floor(network / networks) : network
      data[newClock].delta = n
      network -= n
      networks--
    }
  }
  let log2 = `${new Date(data[0].when).toISOString()} Total = ${total} msecs\n`
  for (const d of data) {
    let df = d.delta.toString()
    df = `${' '.repeat(8 - df.length)}${df}`
    log2 += `${df} ${d.rest}\n`
  }
  return log2
}
