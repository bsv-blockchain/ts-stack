import { HttpClient, HttpClientRequestOptions, HttpClientResponse } from '@bsv/sdk'
import * as walletToolbox from '../../../index.all'
import { TaskArcadeSSE, TaskBsvBroadcasterSSE } from '../../../monitor/tasks/TaskArcSSE'
import {
  ARCADE_POST_BEEF_CONCURRENCY,
  Arcade,
  BSV_BROADCASTER_POST_BEEF_CONCURRENCY,
  BsvBroadcaster,
  validateArcadeTxData,
  validateBsvBroadcasterTxData
} from '../Arcade'
import * as newPath from '../BsvBroadcaster'

/**
 * Arcade was renamed to BSV Broadcaster. The old names and the old `providers/Arcade` import
 * path stay as deprecated aliases; these tests pin that they keep constructing and behaving
 * exactly like the new ones.
 */

const TXID = 'ab'.repeat(32)

function recordingHttpClient(captured: string[]): HttpClient {
  return {
    async request<D>(url: string, _options: HttpClientRequestOptions): Promise<HttpClientResponse<D>> {
      captured.push(url)
      return {
        ok: true,
        status: 202,
        statusText: 'Accepted',
        data: { txid: TXID, status: 202, txStatus: 'RECEIVED' } as D
      }
    }
  } as HttpClient
}

describe('deprecated Arcade aliases', () => {
  test('the old import path exports the same values as the new one', () => {
    expect(Arcade).toBe(BsvBroadcaster)
    expect(Arcade).toBe(newPath.Arcade)
    expect(BsvBroadcaster).toBe(newPath.BsvBroadcaster)
    expect(ARCADE_POST_BEEF_CONCURRENCY).toBe(BSV_BROADCASTER_POST_BEEF_CONCURRENCY)
    expect(validateArcadeTxData).toBe(validateBsvBroadcasterTxData)
  })

  test('new Arcade(...) constructs a BsvBroadcaster with unchanged defaults', () => {
    const arcade: Arcade = new Arcade('https://arcade.example', 'key')
    expect(arcade).toBeInstanceOf(BsvBroadcaster)
    expect(arcade.name).toBe('arcade')
    expect(arcade.URL).toBe('https://arcade.example')
    expect(arcade.apiKey).toBe('key')
  })

  test('an Arcade instance broadcasts like a BsvBroadcaster', async () => {
    const viaAlias: string[] = []
    const viaNew: string[] = []
    const fromAlias = await new Arcade('https://arcade.example', {
      httpClient: recordingHttpClient(viaAlias),
      deploymentId: 'd'
    }).postRawTx('00', [TXID])
    const fromNew = await new BsvBroadcaster('https://arcade.example', {
      httpClient: recordingHttpClient(viaNew),
      deploymentId: 'd'
    }).postRawTx('00', [TXID])

    expect(viaAlias).toEqual(['https://arcade.example/tx'])
    expect(viaNew).toEqual(viaAlias)
    expect(fromAlias.status).toBe('success')
    expect({ ...fromAlias, notes: undefined }).toEqual({ ...fromNew, notes: undefined })
  })

  test('TaskArcadeSSE is TaskBsvBroadcasterSSE and keeps its stored task name', () => {
    expect(TaskArcadeSSE).toBe(TaskBsvBroadcasterSSE)
    expect(TaskArcadeSSE.taskName).toBe('ArcadeSSE')
    expect(walletToolbox.Task.TaskArcadeSSE).toBe(TaskBsvBroadcasterSSE)
    expect(walletToolbox.Task.TaskBsvBroadcasterSSE).toBe(TaskBsvBroadcasterSSE)
  })
})
