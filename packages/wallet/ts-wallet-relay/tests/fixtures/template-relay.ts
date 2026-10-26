export const templateRelay = {
  createSession: jest.fn(),
  deleteSession: jest.fn(),
  getSession: jest.fn(),
  sendRequest: jest.fn()
}

export function getRelay(): typeof templateRelay {
  return templateRelay
}
