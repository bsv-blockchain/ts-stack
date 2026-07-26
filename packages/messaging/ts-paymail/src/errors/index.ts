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
  constructor(message: string) {
    super(message, 503)
  }
}

export { PaymailError, PaymailBadRequestError, PaymailServerResponseError }
