import { NextResponse } from 'next/server'
import { getRelay } from '../../../../lib/relay'

const noStore = { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' }

// Next.js 15+: params is a Promise — change to `await params` if you see a type error.
// Next.js 14:  params is a plain object — the signature below is correct.
export function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = getRelay().getSession(params.id)
  if (!session)
    return NextResponse.json({ error: 'Session not found' }, { status: 404, headers: noStore })
  return NextResponse.json(session, { headers: noStore })
}

export function DELETE(req: Request, { params }: { params: { id: string } }) {
  const token = req.headers.get('x-desktop-token')
  if (!token)
    return NextResponse.json({ error: 'Missing desktop token' }, { status: 401, headers: noStore })
  try {
    getRelay().deleteSession(params.id, token)
    return new NextResponse(null, { status: 204, headers: noStore })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed'
    const status = msg === 'Invalid desktop token' ? 401 : msg === 'Session not found' ? 404 : 500
    return NextResponse.json({ error: msg }, { status, headers: noStore })
  }
}
