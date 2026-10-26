const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const {
  CDN_ROOT,
  PUBLIC_ROOT,
  MAX_OBJECT_ID_LENGTH,
  resolveCdnObjectPath,
  writeCdnObjectExclusive,
  writeCdnObjectStreamExclusive
} = require('../out/src/utils/cdnObjectPath.js')
const { writeBytesFully } = require('../out/src/utils/writeBytesFully.js')
const walletSingleton = require('../out/src/utils/walletSingleton.js')
const putRoute = require('../out/src/routes/put.js').default
const { cdnMimeTypeMiddleware } = require('../out/src/utils/mimeTypeMiddleware.js')

describe('complete streaming writes', () => {
  test('retries successful partial writes until the full chunk is persisted', async () => {
    const written = []
    const handle = {
      write: jest.fn(async (bytes, offset, length) => {
        const count = Math.min(2, length)
        written.push(Buffer.from(bytes.subarray(offset, offset + count)))
        return { bytesWritten: count, buffer: bytes }
      })
    }

    await writeBytesFully(handle, Buffer.from('complete'))

    expect(Buffer.concat(written).toString('utf8')).toBe('complete')
    expect(handle.write).toHaveBeenCalledTimes(4)
  })

  test('fails closed when a filesystem write makes no progress', async () => {
    const handle = {
      write: jest.fn(async bytes => ({ bytesWritten: 0, buffer: bytes }))
    }

    await expect(writeBytesFully(handle, Buffer.from('blocked'))).rejects.toThrow(
      'Filesystem write made no progress.'
    )
  })
})

const GHSA_V356_TRAVERSAL_IDS = [
  '../../../../../../tmp/pwned.txt',
  '..%2F..%2F..%2F..%2F..%2F..%2Ftmp%2Fpwned.txt',
  '../escape',
  '%2fescape',
  '%252fescape',
  '/tmp/escape',
  '\\\\server\\share',
  '..\\escape',
  'nested/object',
  'nested\\object',
  '.',
  '..',
  '0OIl',
  'A'.repeat(MAX_OBJECT_ID_LENGTH + 1),
  'A\u0000B',
  '',
  ['3MN5Q'],
  { id: '3MN5Q' }
]

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
    expect(PUBLIC_ROOT).toBe(path.resolve(process.cwd(), 'public'))
    expect(path.dirname(CDN_ROOT)).toBe(PUBLIC_ROOT)
  })

  test('resolves a canonical Base58 identifier directly beneath the CDN root', () => {
    expect(resolveCdnObjectPath('3MN5Q', root)).toBe(path.join(root, '3MN5Q'))
  })

  test.each(GHSA_V356_TRAVERSAL_IDS)('rejects a non-canonical identifier: %p', (objectID) => {
    expect(resolveCdnObjectPath(objectID, root)).toBeNull()
  })

  test('GHSA-v356 traversal identifiers never write outside the CDN root', () => {
    const marker = path.join(os.tmpdir(), `uhrp-ghsa-v356-${crypto.randomBytes(8).toString('hex')}.txt`)
    const relativeEscape = path.relative(root, marker)

    expect(relativeEscape.startsWith('..')).toBe(true)
    expect(writeCdnObjectExclusive(relativeEscape, Buffer.from('PWNED123'), root)).toBe('invalid')
    expect(writeCdnObjectExclusive('../../../../../../tmp/pwned.txt', Buffer.from('PWNED123'), root)).toBe('invalid')
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.readdirSync(root)).toEqual([])
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

  test('rejects a traversal stream without creating a temporary file', async () => {
    await expect(writeCdnObjectStreamExclusive(
      '../../../../../../tmp/pwned.txt',
      Readable.from([Buffer.from('PWNED123')]),
      8,
      1024,
      root
    )).resolves.toEqual({ status: 'invalid' })
    expect(fs.readdirSync(root)).toEqual([])
  })
})

test('forces arbitrary CDN content into a sandboxed download response', async () => {
  const headers = new Map()
  const next = jest.fn()
  await cdnMimeTypeMiddleware(
    { path: '/cdn/not%2Fa%2Fcanonical%2Fobject' },
    { setHeader: (name, value) => headers.set(name.toLowerCase(), value) },
    next
  )

  expect(headers.get('content-disposition')).toBe('attachment')
  expect(headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
  expect(headers.get('x-content-type-options')).toBe('nosniff')
  expect(next).toHaveBeenCalledTimes(1)
})

describe('PUT /put upload authorization', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test.each(GHSA_V356_TRAVERSAL_IDS)('rejects %p before wallet or filesystem work', async (objectID) => {
    const resume = jest.fn()
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
      body: new Uint8Array(),
      resume
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
    expect(resume).toHaveBeenCalledTimes(1)
  })

  test('rejects an explicit valid:false HMAC result before consuming the body', async () => {
    const verifyHmac = jest.fn().mockResolvedValue({ valid: false })
    jest.spyOn(walletSingleton, 'getWallet').mockResolvedValue({ verifyHmac })
    const resume = jest.fn()
    const req = {
      query: {
        uploader: 'uploader',
        uhrpUrl: 'https://example.test',
        objectID: '3MN5Q',
        fileSize: '0',
        expiry: '2030-01-01T00:00:00.000Z',
        hmac: '00'.repeat(32)
      },
      headers: {},
      resume
    }
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    }

    await putRoute.func(req, res)

    expect(verifyHmac).toHaveBeenCalledTimes(1)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_INVALID_HMAC',
      description: 'Invalid upload authorization'
    })
    expect(resume).toHaveBeenCalledTimes(1)
  })
})
