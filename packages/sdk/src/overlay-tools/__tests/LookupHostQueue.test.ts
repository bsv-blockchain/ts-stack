import { LookupHostQueue } from '../LookupHostQueue.js'

describe('LookupHostQueue', () => {
  it('does not enqueue hosts after sources close or the queue is cancelled', async () => {
    const ran: string[] = []
    const closed = new LookupHostQueue(
      8,
      1,
      async host => {
        ran.push(host)
      },
      () => {}
    )
    closed.finishSources()
    closed.add('late', ['https://late.example'])
    await closed.done

    const cancelled = new LookupHostQueue(
      8,
      1,
      async host => {
        ran.push(host)
      },
      () => {}
    )
    cancelled.cancel()
    cancelled.add('late', ['https://cancelled.example'])
    await cancelled.done

    expect(ran).toEqual([])
  })

  it('ignores duplicate hosts and reports overflow past maxHosts', async () => {
    const ran: string[] = []
    const skipped: Array<[number, boolean]> = []
    const queue = new LookupHostQueue(
      2,
      2,
      async host => {
        ran.push(host)
      },
      (count, limited) => {
        skipped.push([count, limited])
      }
    )
    queue.add('tracker-a', [
      'https://a.example',
      'https://a.example',
      'https://b.example',
      'https://c.example'
    ])
    queue.add('tracker-b', ['https://a.example', 'https://d.example'])
    queue.finishSources()
    await queue.done

    expect(ran).toEqual(['https://a.example', 'https://b.example'])
    expect(skipped).toEqual([
      [1, true],
      [1, true]
    ])
  })
})
