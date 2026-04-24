export class SimpleError extends Error {
  constructor (message: string, public code?: string) {
    super(message)
    this.name = 'SimpleError'
  }
}

export class WalletError extends SimpleError {
  constructor (message: string) {
    super(message, 'WALLET_ERROR')
    this.name = 'WalletError'
  }
}

export class TransactionError extends SimpleError {
  constructor (message: string) {
    super(message, 'TRANSACTION_ERROR')
    this.name = 'TransactionError'
  }
}

export class MessageBoxError extends SimpleError {
  constructor (message: string) {
    super(message, 'MESSAGEBOX_ERROR')
    this.name = 'MessageBoxError'
  }
}

export class CertificationError extends SimpleError {
  constructor (message: string) {
    super(message, 'CERTIFICATION_ERROR')
    this.name = 'CertificationError'
  }
}

export class DIDError extends SimpleError {
  constructor (message: string) {
    super(message, 'DID_ERROR')
    this.name = 'DIDError'
  }
}

export class CredentialError extends SimpleError {
  constructor (message: string) {
    super(message, 'CREDENTIAL_ERROR')
    this.name = 'CredentialError'
  }
}
