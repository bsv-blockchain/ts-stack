// Jest setup file for global test configuration

// Mock uuid to avoid ES module issues
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid-1234')
}))

// Mock chalk to avoid ANSI color codes in test output
jest.mock('chalk', () => {
  const mockChalk = (str: string): string => str

  return {
    default: Object.assign(mockChalk, {
      green: Object.assign((str: string) => str, { bold: (str: string) => str }),
      blue: (str: string) => str,
      yellow: (str: string) => str,
      red: (str: string) => str,
      magenta: Object.assign((str: string) => str, { bold: (str: string) => str }),
      cyan: (str: string) => str
    }),
    green: Object.assign((str: string) => str, { bold: (str: string) => str }),
    blue: (str: string) => str,
    yellow: (str: string) => str,
    red: (str: string) => str,
    magenta: Object.assign((str: string) => str, { bold: (str: string) => str }),
    cyan: (str: string) => str
  }
})

// Suppress console output during tests unless explicitly testing it
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}
