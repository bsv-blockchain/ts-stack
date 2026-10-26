import { NextRequest, NextResponse } from 'next/server'
import { getRelay } from '../../../lib/relay'

const noStore = { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' }

export async function GET(req: NextRequest) {
  try {
    const claimedOrigin = req.headers.get('origin') ?? undefined
    const session = await getRelay().createSession(
      claimedOrigin === undefined ? undefined : { origin: claimedOrigin }
    )
    return NextResponse.json(session, { headers: noStore })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create session'
    const code = (err as { code?: number }).code
    const status = code === 429 ? 429 : msg.includes('allowedOrigins') ? 403 : 500
    return NextResponse.json({ error: msg }, { status, headers: noStore })
  }
}
