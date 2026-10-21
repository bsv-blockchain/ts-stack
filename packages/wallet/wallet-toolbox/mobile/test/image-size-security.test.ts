import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const requireFromMobile = createRequire(path.join(process.cwd(), 'mobile/package.json'))
const metroManifest = requireFromMobile.resolve('metro/package.json')
const requireFromMetro = createRequire(metroManifest)
const metroImageSize = path.join(path.dirname(metroManifest), 'src/lib/imageSize.js')

describe('Metro image-size security boundary', () => {
  it('no longer reaches the vulnerable image-size parser', () => {
    const manifest = JSON.parse(readFileSync(metroManifest, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['image-size']).toBeUndefined()
    expect(() => requireFromMetro.resolve('image-size')).toThrow()
  })

  it('terminates on zero-sized boxes and non-progressing ICNS entries', () => {
    const source = `
      const { getImageDimensions } = require(${JSON.stringify(metroImageSize)})
      const zeroBox = Buffer.alloc(8)
      zeroBox.write('meta', 4)
      const icns = Buffer.alloc(16)
      icns.write('icns', 0)
      icns.writeUInt32BE(16, 4)
      icns.write('ic07', 8)
      icns.writeUInt32BE(0, 12)
      for (const [type, input] of [['heic', zeroBox], ['icns', icns], ['png', icns]]) {
        try {
          getImageDimensions(type, input, 'malformed.' + type)
        } catch {
          // Rejection is acceptable; termination is the contract.
        }
      }
      process.exit(0)
    `
    const result = spawnSync(process.execPath, ['-e', source], {
      encoding: 'utf8',
      timeout: 2_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })
})
