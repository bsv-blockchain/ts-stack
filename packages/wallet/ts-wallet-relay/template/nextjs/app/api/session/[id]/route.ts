import { NextResponse } from 'next/server'
import { getRelay } from '../../../../lib/relay'

// Next.js 15+: params is a Promise — change to `await params` if you see a type error.
// Next.js 14:  params is a plain object — the signature below is correct.
export function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const session = getRelay().getSession(params.id)
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  return NextResponse.json(session)
}
