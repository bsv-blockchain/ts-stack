/**
 * Framework-agnostic request/response types for server handlers.
 * Avoids importing 'next/server' so the library has no Next.js build dependency.
 */

export interface HandlerRequest {
  url: string
  method: string
  json: () => Promise<any>
}

export interface HandlerResponse {
  status: number
  body: any
}

export interface RouteHandler {
  GET?: (req: HandlerRequest) => Promise<HandlerResponse>
  POST?: (req: HandlerRequest) => Promise<HandlerResponse>
}

/** Extract search params from a URL string. */
export function getSearchParams (url: string): URLSearchParams {
  try {
    return new URL(url).searchParams
  } catch {
    // Fallback for relative URLs
    const qIndex = url.indexOf('?')
    return new URLSearchParams(qIndex >= 0 ? url.substring(qIndex + 1) : '')
  }
}

/** Create a JSON response object. */
export function jsonResponse (data: any, status = 200): HandlerResponse {
  return { status, body: data }
}

/**
 * Wrap core handlers into Next.js App Router compatible { GET, POST }.
 * Uses the Web-standard Response API (available in Next.js, Deno, Bun, etc.)
 * — no 'next/server' import needed.
 */
export function toNextHandlers (handler: RouteHandler): { GET?: (req: any) => Promise<any>, POST?: (req: any) => Promise<any> } {
  const wrapHandler = (method: 'GET' | 'POST'): ((req: any) => Promise<any>) | undefined => {
    const coreFn = handler[method]
    if (coreFn == null) return undefined

    return async (req: any): Promise<any> => {
      const result = await coreFn({
        url: (req.url as string | undefined) ?? req.nextUrl?.toString() ?? '',
        method,
        json: () => req.json()
      })

      // Use Web-standard Response (works in Next.js, Deno, Bun, Workers)
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  return {
    ...((handler.GET != null) ? { GET: wrapHandler('GET') } : {}),
    ...((handler.POST != null) ? { POST: wrapHandler('POST') } : {})
  }
}
