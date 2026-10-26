import { jest } from '@jest/globals'
import * as Logger from '../Utils/logger.js'

describe('Message Box diagnostic logging', () => {
  afterEach(() => {
    Logger.disable()
    jest.restoreAllMocks()
  })

  it('keeps every diagnostic level disabled by default', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    Logger.log('log event')
    Logger.warn('warning event')
    Logger.error('error event')

    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('forwards only bounded event strings when explicitly enabled', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    Logger.enable()

    Logger.log('fixed diagnostic event')
    Logger.log('x'.repeat(513))

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('fixed diagnostic event')
  })

  it('does not inspect or forward an attached hostile object', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const hostile = Object.defineProperty({}, 'message', {
      get: () => {
        throw new Error('diagnostic argument was inspected')
      }
    })
    Logger.enable()

    expect(() => (Logger.log as unknown as (event: unknown) => void)(hostile)).not.toThrow()
    expect(log).not.toHaveBeenCalled()
  })
})
