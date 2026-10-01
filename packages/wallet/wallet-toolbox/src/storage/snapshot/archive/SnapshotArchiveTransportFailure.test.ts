import {
  isSnapshotArchiveTransportFailure,
  snapshotArchiveFetch,
  SnapshotArchiveTransportFailure
} from './SnapshotArchiveTransportFailure'

test('the dedicated native-fetch wrapper forwards successful responses and original request arguments', async () => {
  const response = new Response('body', { headers: { 'x-fixture': 'unchanged' } })
  const native = jest.fn(async () => response)
  const fetch = snapshotArchiveFetch(native)
  const options = { method: 'POST', body: 'request', signal: new AbortController().signal }
  expect(await fetch('http://127.0.0.1:1', options)).toBe(response)
  expect(native).toHaveBeenCalledWith('http://127.0.0.1:1', options)
  expect(response.bodyUsed).toBe(false)
})

test('only an actual native-fetch rejection is marked, preserving its original cause', async () => {
  const cause = new Error('synthetic connection loss')
  const native = jest.fn(async () => {
    throw cause
  })
  const error = await snapshotArchiveFetch(native)('http://127.0.0.1:1').catch(error => error)
  expect(error).toBeInstanceOf(SnapshotArchiveTransportFailure)
  expect(error.cause).toBe(cause)
  expect(error.name).toBe('SnapshotArchiveTransportFailure')
  expect(error.message).toBe('Snapshot archive transport failed before a response was available')
  expect(isSnapshotArchiveTransportFailure(error)).toBe(true)
  const sdkWrapper = new Error('SDK network wrapper')
  Object.defineProperty(sdkWrapper, 'cause', { value: error })
  expect(isSnapshotArchiveTransportFailure(sdkWrapper)).toBe(true)
  const secondWrapper = new Error('An unrelated failure')
  Object.defineProperty(secondWrapper, 'cause', { value: sdkWrapper })
  expect(isSnapshotArchiveTransportFailure(secondWrapper)).toBe(false)
})

test('auth, framing, body bounds and arbitrary error names never authorize recovery', async () => {
  for (const message of [
    'Invalid signature',
    'Authenticated response frame exceeds the configured limit.',
    'SnapshotArchiveTransportFailure'
  ]) {
    const error = new Error(message)
    error.name = 'SnapshotArchiveTransportFailure'
    expect(isSnapshotArchiveTransportFailure(error)).toBe(false)
  }
  for (const value of [undefined, null, 1, 'network error', { cause: new SnapshotArchiveTransportFailure('loss') }])
    expect(isSnapshotArchiveTransportFailure(value)).toBe(false)
  const getter = new Error('Unrelated')
  Object.defineProperty(getter, 'cause', {
    get: () => {
      throw new Error('Getter must not run')
    }
  })
  expect(isSnapshotArchiveTransportFailure(getter)).toBe(false)
  const bodyFailure = new Error('synthetic body read failure')
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(bodyFailure)
      }
    })
  )
  const native = jest.fn(async () => response)
  const fetched = await snapshotArchiveFetch(native)('http://127.0.0.1:1')
  const error = await fetched.text().catch(error => error)
  expect(error).toBe(bodyFailure)
  expect(isSnapshotArchiveTransportFailure(error)).toBe(false)
})
