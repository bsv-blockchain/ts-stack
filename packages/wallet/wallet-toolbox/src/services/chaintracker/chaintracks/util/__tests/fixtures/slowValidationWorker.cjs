const { parentPort } = require('node:worker_threads')

parentPort.on('message', ({ id, request }) => {
  if (request.fileName === 'exit.headers') process.exit(17)
  if (request.fileName === 'error.headers') throw new Error('worker fixture failure')
  if (request.fileName === 'failure-string.headers') {
    parentPort.postMessage({ id, ok: false, error: 'string failure', data: request.data }, [request.data])
    return
  }
  if (request.fileName === 'failure-empty.headers') {
    parentPort.postMessage({ id, ok: false, error: {}, data: request.data }, [request.data])
    return
  }
  if (request.fileName === 'mismatch.headers') parentPort.postMessage({ id: id + 1000, ok: false, error: 'stale' })
  if (request.fileName === 'slow.headers' || request.fileName === 'timeout.headers') {
    const started = Date.now()
    const duration = request.fileName === 'timeout.headers' ? 5000 : 75
    while (Date.now() - started < duration) {
      // Deliberately occupy only the worker thread for event-loop isolation tests.
    }
  }
  parentPort.postMessage(
    {
      id,
      ok: true,
      result: {
        data: request.data,
        fileHash: request.fileHash || 'exported',
        lastHeaderHash: request.lastHash || '00'.repeat(32),
        lastChainWork: request.lastChainWork || '00'.repeat(32)
      }
    },
    [request.data]
  )
})
