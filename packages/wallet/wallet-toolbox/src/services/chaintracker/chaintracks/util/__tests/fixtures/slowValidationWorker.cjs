const { parentPort } = require('node:worker_threads')

parentPort.on('message', ({ id, request }) => {
  const started = Date.now()
  while (Date.now() - started < 75) {
    // Deliberately occupy only the worker thread for event-loop isolation tests.
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
