// Lightweight profiler for tracing async + sync hot paths in SDK.
// Disable by setting `globalThis.__BSV_PROFILE__ = false` before first use.
// Output goes to console.log so it surfaces in React Native Metro logs.

const g = globalThis as Record<string, unknown>
const NS = '[bsv-sdk]'

function enabled (): boolean {
  return g.__BSV_PROFILE__ !== false
}

function now (): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function fmt (ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  if (ms >= 1) return `${ms.toFixed(1)}ms`
  return `${ms.toFixed(2)}ms`
}

export function plog (label: string, extra?: unknown): void {
  if (!enabled()) return
  if (extra === undefined) console.log(`${NS} ${label}`)
  else console.log(`${NS} ${label}`, extra)
}

export interface ProfileSpan {
  end: (extra?: unknown) => number
  mark: (sub: string, extra?: unknown) => void
}

export function pstart (label: string, extra?: unknown): ProfileSpan {
  if (!enabled()) {
    return {
      end: () => 0,
      mark: () => undefined
    }
  }
  const t0 = now()
  if (extra === undefined) console.log(`${NS} >>> ${label}`)
  else console.log(`${NS} >>> ${label}`, extra)
  let lastMark = t0
  return {
    end (extraEnd?: unknown): number {
      const dt = now() - t0
      if (extraEnd === undefined) console.log(`${NS} <<< ${label} ${fmt(dt)}`)
      else console.log(`${NS} <<< ${label} ${fmt(dt)}`, extraEnd)
      return dt
    },
    mark (sub: string, extraSub?: unknown): void {
      const tNow = now()
      const dtTotal = tNow - t0
      const dtStep = tNow - lastMark
      lastMark = tNow
      if (extraSub === undefined) console.log(`${NS}  · ${label} | ${sub} (+${fmt(dtStep)}, t=${fmt(dtTotal)})`)
      else console.log(`${NS}  · ${label} | ${sub} (+${fmt(dtStep)}, t=${fmt(dtTotal)})`, extraSub)
    }
  }
}

export async function pAsync<T> (label: string, fn: () => Promise<T>, extra?: unknown): Promise<T> {
  const span = pstart(label, extra)
  try {
    const r = await fn()
    span.end()
    return r
  } catch (err) {
    span.end({ error: (err as Error)?.message ?? String(err) })
    throw err
  }
}
