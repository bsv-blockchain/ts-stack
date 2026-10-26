// Global setup - runs ONCE before all test files

export default async function globalSetup() {
  // Set environment variables for test environment
  process.env.NODE_ENV = 'test'
  process.env.SERVER_PRIVATE_KEY = '1'.padStart(64, '0')
  process.env.STORAGE_URL = 'https://storage.example.com'
  process.env.BSV_NETWORK = 'testnet'
  process.env.COMMISSION_FEE = '1000'
  process.env.WAB_PRESENTATION_KEY_ENCRYPTION_KEY = '1'.repeat(64)
  process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE = 'encrypted'
  process.env.TWILIO_ACCOUNT_SID = `AC${'1'.repeat(32)}`
  process.env.TWILIO_AUTH_TOKEN = 'synthetic-test-token'
  process.env.TWILIO_VERIFY_SERVICE_SID = `VA${'2'.repeat(32)}`
}
