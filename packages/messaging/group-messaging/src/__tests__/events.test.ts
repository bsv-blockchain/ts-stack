import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '../events.js'

interface TestEvents {
  ping: { n: number }
}

describe('Emitter', () => {
  it('delivers to every listener in subscription order', () => {
    const emitter = new Emitter<TestEvents>()
    const seen: string[] = []
    emitter.on('ping', () => seen.push('first'))
    emitter.on('ping', () => seen.push('second'))

    emitter.emit('ping', { n: 1 })

    expect(seen).toEqual(['first', 'second'])
  })

  it('keeps delivering after a listener throws', () => {
    const errors: Error[] = []
    const emitter = new Emitter<TestEvents>(error => errors.push(error))
    const later = vi.fn()
    emitter.on('ping', () => {
      throw new Error('listener blew up')
    })
    emitter.on('ping', later)

    emitter.emit('ping', { n: 1 })

    expect(later).toHaveBeenCalledWith({ n: 1 })
    expect(errors.map(error => error.message)).toEqual(['listener blew up'])
  })

  it("does not let a throwing listener fail the emitter's caller", () => {
    const emitter = new Emitter<TestEvents>(() => undefined)
    emitter.on('ping', () => {
      throw new Error('nope')
    })

    expect(() => emitter.emit('ping', { n: 1 })).not.toThrow()
  })

  it('names the event a failing listener was subscribed to', () => {
    const seen: (keyof TestEvents)[] = []
    const emitter = new Emitter<TestEvents>((_error, event) => seen.push(event))
    emitter.on('ping', () => {
      throw new Error('nope')
    })

    emitter.emit('ping', { n: 1 })

    expect(seen).toEqual(['ping'])
  })

  it('wraps a non-Error throw rather than passing it through raw', () => {
    const errors: Error[] = []
    const emitter = new Emitter<TestEvents>(error => errors.push(error))
    emitter.on('ping', () => {
      throw 'a string'
    })

    emitter.emit('ping', { n: 1 })

    expect(errors[0]).toBeInstanceOf(Error)
    expect(errors[0]?.message).toBe('a string')
  })

  it('stops delivering to an unsubscribed listener', () => {
    const emitter = new Emitter<TestEvents>()
    const listener = vi.fn()
    const stop = emitter.on('ping', listener)

    stop()
    emitter.emit('ping', { n: 1 })

    expect(listener).not.toHaveBeenCalled()
  })
})
