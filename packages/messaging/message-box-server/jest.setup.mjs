// Import Jest types from the jest package
import { jest } from '@jest/globals';

// Make Jest available globally
global.jest = jest;
global.expect = expect;
global.test = test;
global.describe = describe;
global.beforeEach = beforeEach;
global.afterEach = afterEach;
global.beforeAll = beforeAll;
global.afterAll = afterAll;

// Add mock environment variables needed for tests
process.env.SERVER_PRIVATE_KEY = 'test_private_key_for_jest_environment';
process.env.NODE_ENV = 'test';
process.env.KNEX_DB_CLIENT = 'better-sqlite3';
process.env.KNEX_DB_CONNECTION = '{"filename":":memory:"}';
