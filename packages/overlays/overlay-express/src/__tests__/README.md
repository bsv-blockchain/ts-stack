# Unit Tests for @bsv/overlay-express

This directory contains comprehensive unit tests for the overlay-express library.

## Test Structure

- **InMemoryMigrationSource.test.ts** - Tests for the internal migration source (tested through integration)
- **makeUserInterface.test.ts** - Tests for the web UI generation function
- **JanitorService.test.ts** - Tests for the janitor health check service
- **OverlayExpress.test.ts** - Tests for the main OverlayExpress class

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Test Coverage

The test suite covers:

### makeUserInterface
- Default configuration generation
- Custom UI configuration
- Color customization
- Font customization
- Responsive design
- JavaScript function inclusion
- External links

### JanitorService
- Constructor and initialization
- Health check execution
- Domain validation (valid domains, localhost, IP addresses)
- URL extraction from various field types
- Output health status management
- Down counter increment/decrement
- Output deletion on threshold
- Timeout handling
- Error handling

### OverlayExpress
- Constructor with various parameter combinations
- Admin token generation and retrieval
- Port configuration
- Web UI configuration
- Janitor configuration
- Logger configuration
- Network configuration (main/test)
- ChainTracker configuration
- ARC API key configuration
- GASP sync configuration
- Verbose logging configuration
- Knex (SQL) database configuration
- MongoDB configuration
- Topic Manager configuration
- Lookup Service configuration
- Engine configuration
- Error handling for missing dependencies
- Full integration scenarios

## Mocking Strategy

The tests use Jest mocks for external dependencies:
- `knex` - Database client
- `mongodb` - MongoDB client
- `@bsv/overlay` - Overlay services
- `@bsv/sdk` - BSV SDK
- `@bsv/overlay-discovery-services` - Discovery services
- `chalk` - Console coloring (suppressed in tests)
- `fetch` - HTTP requests (for JanitorService)

## Test Environment

- **Test Framework**: Jest 29+
- **TypeScript**: ts-jest preset
- **Environment**: Node.js
- **Coverage Tool**: Jest built-in coverage

## Writing New Tests

When adding new features:

1. Create test file in `__tests__` directory
2. Follow the naming convention: `FeatureName.test.ts`
3. Use descriptive test names with `describe` and `it` blocks
4. Mock external dependencies
5. Test both success and error paths
6. Include edge cases
7. Update this README with new test coverage

## CI/CD Integration

These tests are designed to run in CI/CD pipelines:
- Fast execution
- No external dependencies required
- Comprehensive coverage
- Clear error messages
