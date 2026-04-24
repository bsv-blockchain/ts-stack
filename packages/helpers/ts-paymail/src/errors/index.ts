class PaymailError extends Error {
  status: any
  constructor (message, status) {
    super(message)
    this.status = status
  }
}

class PaymailBadRequestError extends PaymailError {
  constructor (message) {
    super(message, 400)
  }
}

class PaymailServerResponseError extends PaymailError {
  constructor (message) {
    super(message, 503)
  }
};

export { PaymailError, PaymailBadRequestError, PaymailServerResponseError }
