class PaymailError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

class PaymailBadRequestError extends PaymailError {
  constructor(message: string) {
    super(message, 400)
  }
}

class PaymailServerResponseError extends PaymailError {
  /** The HTTP status the remote host answered with, when the error is a non-2xx response. */
  responseStatus?: number

  constructor(message: string, responseStatus?: number) {
    super(message, 503)
    if (responseStatus !== undefined) this.responseStatus = responseStatus
  }
}

export { PaymailError, PaymailBadRequestError, PaymailServerResponseError }
