const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const {
  CDN_ROOT,
  MAX_OBJECT_ID_LENGTH,
  resolveCdnObjectPath,
  writeCdnObjectExclusive,
  writeCdnObjectStreamExclusive
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

  test('streams, hashes, and exclusively commits an object', async () => {
    const chunks = [Buffer.from('streamed '), Buffer.from('object')]
    const data = Buffer.concat(chunks)
    const result = await writeCdnObjectStreamExclusive(
      '3MN5Q',
      Readable.from(chunks),
      data.length,
      1024,
      root
    )

    expect(result).toEqual({
      status: 'stored',
      byteLength: data.length,
      hash: Array.from(crypto.createHash('sha256').update(data).digest())
    })
    expect(fs.readFileSync(path.join(root, '3MN5Q'))).toEqual(data)

    await expect(writeCdnObjectStreamExclusive(
      '3MN5Q',
      Readable.from([Buffer.from('overwrite')]),
      9,
      1024,
      root
    )).resolves.toEqual({ status: 'exists' })
  })

  test('rejects oversized and truncated streams without leaving files', async () => {
    await expect(writeCdnObjectStreamExclusive(
      '3MN5Q',
      Readable.from([Buffer.from('four')]),
      3,
      1024,
      root
    )).resolves.toEqual({ status: 'too_large' })
    expect(fs.existsSync(path.join(root, '3MN5Q'))).toBe(false)

    await expect(writeCdnObjectStreamExclusive(
      '4MN5Q',
      Readable.from([Buffer.from('short')]),
      10,
      1024,
      root
    )).resolves.toEqual({ status: 'size_mismatch' })
    expect(fs.existsSync(path.join(root, '4MN5Q'))).toBe(false)
    expect(fs.readdirSync(root)).toEqual([])
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
