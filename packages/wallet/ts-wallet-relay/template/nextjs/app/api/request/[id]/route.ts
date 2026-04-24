import { NextRequest, NextResponse } from 'next/server'
import { getRelay } from '../../../../lib/relay'

// Next.js 15+: params is a Promise — change to `await params` if you see a type error.
// Next.js 14:  params is a plain object — the signature below is correct.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const body = await req.json() as { method?: string; params?: unknown }
  const { method, params: rpcParams } = body

  if (!method) {
    return NextResponse.json({ error: 'method is required' }, { status: 400 })
  }

  try {
    const response = await getRelay().sendRequest(params.id, method, rpcParams)
    return NextResponse.json(response)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Request failed'
    // Session-not-connected is a client error (4xx); timeout is a gateway error (5xx)
    const status = msg.startsWith('Session is') ? 400 : 504
    return NextResponse.json({ error: msg }, { status })
  }
}
