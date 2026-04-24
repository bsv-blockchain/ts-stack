// Global setup - runs ONCE before all test files

export default async () => {
    // Set environment variables for test environment
    process.env.NODE_ENV = 'test';
    process.env.SERVER_PRIVATE_KEY = "0".repeat(64);
    process.env.STORAGE_URL = "https://storage.example.com";
    process.env.BSV_NETWORK = "testnet";
    process.env.COMMISSION_FEE = "1000";
};
