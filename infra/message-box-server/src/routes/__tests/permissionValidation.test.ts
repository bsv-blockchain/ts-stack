import type { Response } from 'express'
import setPermission, {
  MAX_PERMISSION_MESSAGE_BOX_BYTES,
  MAX_RECIPIENT_FEE
} from '../permissions/setPermission.js'
import listPermissions, {
  MAX_PERMISSION_OFFSET,
  MAX_PERMISSION_PAGE_SIZE
} from '../permissions/listPermissions.js'
import getPermission from '../permissions/getPermission.js'

function response(): jest.Mocked<Response> {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  } as unknown as jest.Mocked<Response>
}

describe('permission route validation', () => {
  it.each([-2, 1.5, Number.NaN, MAX_RECIPIENT_FEE + 1])(
    'rejects invalid recipient fee %s',
    async recipientFee => {
      const res = response()
      await setPermission.func(
        {
          auth: { identityKey: 'identity-key' },
          body: { messageBox: 'inbox', recipientFee }
        } as never,
        res
      )
      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'ERR_INVALID_FEE_VALUE'
        })
      )
    }
  )

  it('bounds the message-box name consistently', async () => {
    const res = response()
    await setPermission.func(
      {
        auth: { identityKey: 'identity-key' },
        body: {
          messageBox: 'x'.repeat(MAX_PERMISSION_MESSAGE_BOX_BYTES + 1),
          recipientFee: 0
        }
      } as never,
      res
    )
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ERR_INVALID_MESSAGE_BOX'
      })
    )
  })

  it.each([
    [{ limit: String(MAX_PERMISSION_PAGE_SIZE + 1) }, 'ERR_INVALID_LIMIT'],
    [{ limit: '10x' }, 'ERR_INVALID_LIMIT'],
    [{ offset: String(MAX_PERMISSION_OFFSET + 1) }, 'ERR_INVALID_OFFSET'],
    [{ createdAtOrder: 'sideways' }, 'ERR_INVALID_SORT_ORDER'],
    [{ messageBox: '' }, 'ERR_INVALID_MESSAGE_BOX']
  ])('strictly validates permission-list pagination and filters', async (query, code) => {
    const res = response()
    await listPermissions.func(
      {
        auth: { identityKey: 'identity-key' },
        query
      } as never,
      res
    )
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }))
  })

  it('requires a bounded non-empty messageBox for permission lookup', async () => {
    const res = response()
    await getPermission.func(
      {
        auth: { identityKey: 'identity-key' },
        query: { messageBox: '   ' }
      } as never,
      res
    )
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ERR_INVALID_MESSAGE_BOX'
      })
    )
  })
})
