import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const requireFromMobile = createRequire(path.join(process.cwd(), 'mobile/package.json'))
const metroManifest = requireFromMobile.resolve('metro/package.json')
const requireFromMetro = createRequire(metroManifest)
const imageSizeEntry = requireFromMetro.resolve('image-size')
const imageSizeManifest = requireFromMetro.resolve('image-size/package.json')
const imageSizeUtils = path.join(path.dirname(imageSizeManifest), 'dist/types/utils.js')

describe('patched image-size parser', () => {
  it('rejects zero-sized boxes and non-progressing ICNS entries', () => {
    const source = `
      const { imageSize } = require(${JSON.stringify(imageSizeEntry)})
      const { findBox } = require(${JSON.stringify(imageSizeUtils)})
      const zeroBox = Buffer.alloc(8)
      zeroBox.write('meta', 4)
      if (findBox(zeroBox, 'meta', 0) !== undefined) process.exit(4)
      const input = Buffer.alloc(16)
      input.write('icns', 0)
      input.writeUInt32BE(16, 4)
      input.write('ic07', 8)
      input.writeUInt32BE(0, 12)
      try {
        imageSize(input)
        process.exit(2)
      } catch (error) {
        if (!String(error).includes('Invalid ICNS image entry length')) process.exit(3)
      }
    `
    const result = spawnSync(process.execPath, ['-e', source], {
      encoding: 'utf8',
      timeout: 2_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })
})
