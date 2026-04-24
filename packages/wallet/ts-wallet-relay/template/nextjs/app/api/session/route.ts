import { NextResponse } from 'next/server'
import { getRelay } from '../../../lib/relay'

export async function GET() {
  try {
    const session = await getRelay().createSession()
    return NextResponse.json(session)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create session'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
