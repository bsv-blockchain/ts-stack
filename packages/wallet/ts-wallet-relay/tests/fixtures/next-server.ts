interface ResponseInitLike {
  status?: number
  headers?: Record<string, string>
}

export class NextRequest extends Request {}

export class NextResponse {
  readonly body: unknown
  readonly status: number
  readonly headers: Headers

  constructor(body: unknown, init: ResponseInitLike = {}) {
    this.body = body
    this.status = init.status ?? 200
    this.headers = new Headers(init.headers)
  }

  static json(body: unknown, init: ResponseInitLike = {}): NextResponse {
    return new NextResponse(body, init)
  }
}
