import { NextRequest, NextResponse } from 'next/server'
import { getRelay } from '../../../../lib/relay'

const noStore = { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' }

// Next.js 15+: params is a Promise — change to `await params` if you see a type error.
// Next.js 14:  params is a plain object — the signature below is correct.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (
    req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    return NextResponse.json(
      { error: 'Content-Type must be application/json' },
      { status: 415, headers: noStore }
    )
  }
  const declaredLength = req.headers.get('content-length')
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > 64 * 1024)
  ) {
    return NextResponse.json(
      { error: 'request body is too large' },
      { status: 413, headers: noStore }
    )
  }
  let body: { method?: unknown; params?: unknown }
  try {
    const text = await req.text()
    if (new TextEncoder().encode(text).length > 64 * 1024) {
      return NextResponse.json(
        { error: 'request body is too large' },
        { status: 413, headers: noStore }
      )
    }
    const parsed: unknown = JSON.parse(text)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    body = parsed as { method?: unknown; params?: unknown }
  } catch {
    return NextResponse.json(
      { error: 'request body must be a JSON object' },
      { status: 400, headers: noStore }
    )
  }
  const { method, params: rpcParams } = body

  if (
    typeof method !== 'string' ||
    new TextEncoder().encode(method).length < 1 ||
    new TextEncoder().encode(method).length > 100
  ) {
    return NextResponse.json({ error: 'method is required' }, { status: 400, headers: noStore })
  }

  const token = req.headers.get('x-desktop-token') ?? undefined
  if (!token)
    return NextResponse.json({ error: 'Missing desktop token' }, { status: 401, headers: noStore })

  try {
    const response = await getRelay().sendRequest(params.id, method, rpcParams, token)
    return NextResponse.json(response, { headers: noStore })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Request failed'
    // Session-not-connected is a client error (4xx); timeout is a gateway error (5xx)
    const code = (err as { code?: number }).code
    const status =
      msg === 'Invalid desktop token'
        ? 401
        : msg.startsWith('Session is') || code === 400
          ? 400
          : code === 429
            ? 429
            : 504
    return NextResponse.json({ error: msg }, { status, headers: noStore })
  }
}
