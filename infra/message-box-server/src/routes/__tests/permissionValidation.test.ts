import { jest } from '@jest/globals'
import type { Response } from 'express'
import type { Knex } from 'knex'
import { PublicKey } from '@bsv/sdk'
import setPermission, {
  MAX_PERMISSION_MESSAGE_BOX_BYTES,
  MAX_RECIPIENT_FEE
} from '../permissions/setPermission.js'
import listPermissions, {
  MAX_PERMISSION_OFFSET,
  MAX_PERMISSION_PAGE_SIZE
} from '../permissions/listPermissions.js'
import getPermission from '../permissions/getPermission.js'
import { bindMessageBoxRuntime } from '../../runtimeDeps.js'

const VALID_SENDER = '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1'
const UNCOMPRESSED_SENDER = PublicKey.fromString(VALID_SENDER).encode(false, 'hex') as string

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

  it.each([' inbox', 'inbox ', 'in\nbox', 'in\u0085box'])(
    'rejects an ambiguous permission message-box name %#',
    async messageBox => {
      const res = response()
      await setPermission.func(
        {
          auth: { identityKey: VALID_SENDER },
          body: { messageBox, recipientFee: 0 }
        } as never,
        res
      )
      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'ERR_INVALID_MESSAGE_BOX' })
      )
    }
  )

  it('fails closed when a permission write is not persisted', async () => {
    const query = {
      insert: () => query,
      onConflict: () => query,
      merge: async () => {
        throw new Error('database unavailable')
      }
    }
    bindMessageBoxRuntime({ knex: (() => query) as unknown as Knex })
    const res = response()

    await setPermission.func(
      {
        auth: { identityKey: 'identity-key' },
        body: { messageBox: 'inbox', recipientFee: -1 }
      } as never,
      res
    )

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', code: 'ERR_DATABASE_ERROR' })
    )
  })

  it('stores an accepted uncompressed sender under its canonical identity', async () => {
    const insert = jest.fn()
    const query = {
      insert: (value: unknown) => {
        insert(value)
        return query
      },
      onConflict: () => query,
      merge: async () => 1
    }
    bindMessageBoxRuntime({ knex: (() => query) as unknown as Knex })
    const res = response()

    await setPermission.func(
      {
        auth: { identityKey: VALID_SENDER },
        body: { sender: UNCOMPRESSED_SENDER, messageBox: 'inbox', recipientFee: -1 }
      } as never,
      res
    )

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ sender: VALID_SENDER, sender_scope: VALID_SENDER })
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('looks up an accepted uncompressed sender under its canonical identity', async () => {
    const where = jest.fn()
    const query = {
      where: (value: unknown) => {
        where(value)
        return query
      },
      select: () => query,
      first: async () => undefined
    }
    bindMessageBoxRuntime({ knex: (() => query) as unknown as Knex })
    const res = response()

    await getPermission.func(
      {
        auth: { identityKey: VALID_SENDER },
        query: { sender: UNCOMPRESSED_SENDER, messageBox: 'inbox' }
      } as never,
      res
    )

    expect(where).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: VALID_SENDER, sender_scope: VALID_SENDER })
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('fails closed when a returned permission fee is malformed', async () => {
    const query = {
      where: () => query,
      select: () => query,
      first: async () => ({
        recipient_fee: '0',
        created_at: new Date(),
        updated_at: new Date()
      })
    }
    bindMessageBoxRuntime({ knex: (() => query) as unknown as Knex })
    const res = response()

    await getPermission.func(
      {
        auth: { identityKey: VALID_SENDER },
        query: { sender: VALID_SENDER, messageBox: 'inbox' }
      } as never,
      res
    )

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_INTERNAL' }))
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
