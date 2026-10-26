import { readFileSync } from 'node:fs'
import path from 'node:path'

const templateRoot = path.resolve(__dirname, '../template')

function template(relativePath: string): string {
  return readFileSync(path.join(templateRoot, relativePath), 'utf8')
}

describe('Next.js scaffold security contracts', () => {
  it('forwards the desktop bearer token on wallet requests and bounds JSON bodies', () => {
    const route = template('nextjs/app/api/request/[id]/route.ts')
    expect(route).toContain("req.headers.get('x-desktop-token')")
    expect(route).toContain('sendRequest(params.id, method, rpcParams, token)')
    expect(route).toContain("!== 'application/json'")
    expect(route).toContain('64 * 1024')
    expect(route).toContain('code === 400')
    expect(route).toContain('code === 429')
    expect(route).toContain("'Cache-Control': 'no-store, max-age=0'")
  })

  it('implements authenticated session retirement', () => {
    const route = template('nextjs/app/api/session/[id]/route.ts')
    expect(route).toContain('export function DELETE')
    expect(route).toContain("req.headers.get('x-desktop-token')")
    expect(route).toContain('deleteSession(params.id, token)')
    expect(route).toContain("'Cache-Control': 'no-store, max-age=0'")
  })

  it('binds created pairing sessions to the caller origin and preserves limit status codes', () => {
    const route = template('nextjs/app/api/session/route.ts')
    expect(route).toContain("req.headers.get('origin')")
    expect(route).toContain('{ origin: claimedOrigin }')
    expect(route).toContain('code === 429 ? 429')
    expect(route).toContain("msg.includes('allowedOrigins') ? 403")
    expect(route).toContain("'Cache-Control': 'no-store, max-age=0'")
  })

  it('bounds and strictly parses Express scaffold JSON bodies', () => {
    const server = template('backend/server.ts')
    expect(server).toContain("express.json({ limit: '64kb', strict: true })")
  })
})
