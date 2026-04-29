// Jest setup file - runs for each test file
import { db, migrateLatest } from './src/db/knex';

// This is a singleton to track if DB is initialized across test files
let dbInitialized = false;

// Setup that runs once for each test file
beforeAll(async () => {
    if (!dbInitialized) {
        await migrateLatest();
        dbInitialized = true;
    }
}, 30000);
