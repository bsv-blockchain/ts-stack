import { expect, test } from '@jest/globals'
import routes from '../routes'

test('keeps legacy cloud-bucket routes while adding CHIRP', () => {
  const preAuth = routes.preAuth.map(route => route.path)
  const postAuth = routes.postAuth.map(route => route.path)
  expect(preAuth).toEqual(
    expect.arrayContaining([
      '/advertise',
      '/quote',
      '/chirp/v1/openapi.json',
      '/chirp/v1/:rootIdentifier/objects/:objectIdentifier'
    ])
  )
  expect(postAuth).toEqual(
    expect.arrayContaining([
      '/upload',
      '/list',
      '/renew',
      '/find',
      '/chirp/v1/uploads',
      '/chirp/v1/uploads/:uploadId/commit'
    ])
  )
})
