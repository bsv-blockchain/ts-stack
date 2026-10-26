declare module 'next/server' {
  export class NextRequest extends Request {}

  export class NextResponse {
    readonly body: unknown
    readonly status: number
    readonly headers: Headers

    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> })

    static json(
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> }
    ): NextResponse
  }
}

declare module 'cors' {
  import type { RequestHandler } from 'express'

  interface CorsOptions {
    origin?: boolean | readonly string[]
    allowedHeaders?: readonly string[]
  }

  export default function cors(options?: CorsOptions): RequestHandler
}
