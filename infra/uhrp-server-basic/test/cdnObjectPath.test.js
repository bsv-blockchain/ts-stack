const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  CDN_ROOT,
  MAX_OBJECT_ID_LENGTH,
  resolveCdnObjectPath,
  writeCdnObjectExclusive
} = require('../out/src/utils/cdnObjectPath.js')
const putRoute = require('../out/src/routes/put.js').default

describe('UHRP CDN object paths', () => {
  let root
  let outside

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'uhrp-cdn-'))
    outside = `${root}-outside`
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { force: true })
  })

  test('uses the CDN directory served from the process working directory', () => {
    expect(CDN_ROOT).toBe(path.resolve(process.cwd(), 'public/cdn'))
  })

  test('resolves a canonical Base58 identifier directly beneath the CDN root', () => {
    expect(resolveCdnObjectPath('3MN5Q', root)).toBe(path.join(root, '3MN5Q'))
  })

  test.each([
    '',
    '../escape',
    '%2fescape',
    '%252fescape',
    '/tmp/escape',
    '\\\\server\\share',
    '..\\escape',
    'nested/object',
    '.',
    '0OIl',
    'A'.repeat(MAX_OBJECT_ID_LENGTH + 1),
    'A\u0000B'
  ])('rejects a non-canonical identifier: %p', (objectID) => {
    expect(resolveCdnObjectPath(objectID, root)).toBeNull()
  })

  test('uses exclusive creation to prevent symlink writes and overwrites', () => {
    const objectPath = path.join(root, '3MN5Q')
    fs.writeFileSync(outside, 'outside')
    fs.symlinkSync(outside, objectPath)

    expect(writeCdnObjectExclusive('3MN5Q', Buffer.from('attacker'), root)).toBe('exists')
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside')

    fs.unlinkSync(objectPath)
    expect(writeCdnObjectExclusive('3MN5Q', Buffer.from('stored'), root)).toBe('stored')
    expect(writeCdnObjectExclusive('3MN5Q', Buffer.from('overwrite'), root)).toBe('exists')
    expect(fs.readFileSync(objectPath, 'utf8')).toBe('stored')
  })
})

describe('PUT /put object identifier validation', () => {
  test.each([
    '../escape',
    '%2fescape',
    '/tmp/escape',
    '..\\escape',
    'nested/object'
  ])('rejects %p before wallet or filesystem work', async (objectID) => {
    const req = {
      query: {
        uploader: 'uploader',
        uhrpUrl: 'https://example.test',
        objectID,
        fileSize: '0',
        expiry: '2030-01-01T00:00:00.000Z',
        hmac: ''
      },
      headers: {},
      body: new Uint8Array()
    }
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    }

    await putRoute.func(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_INVALID_OBJECT_ID',
      description: 'Invalid object identifier'
    })
  })
})
