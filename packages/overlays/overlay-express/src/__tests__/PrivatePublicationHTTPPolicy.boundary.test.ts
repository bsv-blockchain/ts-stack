import { expect, it, jest } from '@jest/globals'
import express, { type Response } from 'express'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { OutputProtocolError } from '@bsv/sdk'
import { sendPrivatePublicationHTTPError } from '../PrivatePublicationHTTPPolicy.js'

function nativeResponse() {
  const socket = new Socket(),
    request = new IncomingMessage(socket)
  const response = Object.setPrototypeOf(new ServerResponse(request), express.response) as Response
  return {
    response,
    close: () => {
      response.destroy()
      socket.destroy()
    }
  }
}

it('writes the fixed JSON control bytes and media type through the native response', () => {
  const f = nativeResponse(),
    end = jest.spyOn(f.response, 'end')
  try {
    sendPrivatePublicationHTTPError(
      f.response,
      new OutputProtocolError('not-found', 'private diagnostic')
    )
    expect(f.response.statusCode).toBe(404)
    expect(f.response.getHeader('content-type')).toBe('application/json; charset=utf-8')
    expect(end).toHaveBeenCalledTimes(1)
    expect(JSON.parse(Buffer.from(end.mock.calls[0][0] as Uint8Array).toString())).toEqual({
      version: 1,
      error: {
        code: 'not-found',
        message: 'Private publication request not-found',
        retryable: false
      }
    })
  } finally {
    end.mockRestore()
    f.close()
  }
})

it.each(['destroyed', 'ended', 'headers-sent'] as const)(
  'preserves a native %s response without another status or write',
  state => {
    const f = nativeResponse()
    if (state === 'destroyed') f.response.destroy()
    if (state === 'ended') f.response.end()
    if (state === 'headers-sent') f.response.write('already committed')
    const status = jest.spyOn(f.response, 'status'),
      end = jest.spyOn(f.response, 'end')
    try {
      expect(() =>
        sendPrivatePublicationHTTPError(f.response, new Error('private diagnostic'))
      ).not.toThrow()
      expect(status).not.toHaveBeenCalled()
      expect(end).not.toHaveBeenCalled()
    } finally {
      status.mockRestore()
      end.mockRestore()
      f.close()
    }
  }
)
