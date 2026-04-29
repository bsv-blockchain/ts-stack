---
id: conformance-runner-ts
title: "TypeScript Runner"
kind: conformance
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [conformance, runner, typescript, jest]
---

# TypeScript Runner

Run conformance vectors in TypeScript using Jest.

## Quick Start

Run all conformance tests:

```bash
cd /Users/personal/git/ts-stack
pnpm conformance
```

## Usage

### Run all vectors
```bash
pnpm conformance
```

### Run specific domain
```bash
pnpm conformance --domain wallet/brc100
pnpm conformance --domain sdk/crypto
```

### Run specific file
```bash
pnpm conformance conformance/vectors/wallet/brc100/getPublicKey-happy-path.json
```

### Filter by tag
```bash
pnpm conformance --tag happy-path
pnpm conformance --tag edge-case
pnpm conformance --tag regression
```

### Watch mode (development)
```bash
pnpm conformance --watch
```

### Generate coverage report
```bash
pnpm conformance --coverage
```

### Verbose output
```bash
pnpm conformance --verbose
```

### Compare with Go runner
```bash
pnpm conformance:compare ts-results-2026-04-28.json go-results-2026-04-28.json
```

## Output Format

Test runner produces JSON report:

```json
{
  "timestamp": "2026-04-28T10:30:00Z",
  "runId": "ts-run-1234567890",
  "runner": "typescript",
  "totalVectors": 260,
  "passed": 258,
  "failed": 2,
  "skipped": 0,
  "duration_ms": 45230,
  "vectorResults": [
    {
      "vector": "wallet/brc100/getPublicKey-happy-path",
      "status": "PASS",
      "duration_ms": 12,
      "assertions": 3
    },
    {
      "vector": "wallet/brc100/createAction-invalid-inputs",
      "status": "FAIL",
      "duration_ms": 5,
      "error": "Expected satoshis to be BigInt, got string"
    }
  ]
}
```

## Implementation

The runner uses Jest with custom reporter.

Configuration at `conformance/jest.config.js`:

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/conformance/vectors/**/*.test.ts'],
  reporters: [
    'default',
    ['<rootDir>/conformance/reporters/json-reporter.ts', {
      outputFile: 'conformance/results/ts-results-latest.json'
    }]
  ]
};
```

## Test Generation

Vectors are automatically converted to Jest tests.

A vector file like:

```json
{
  "name": "BRC-100 getPublicKey happy path",
  "domain": "wallet/brc100",
  "inputs": {
    "derivationKey": "m/44'/0'/0'/0/0"
  },
  "expectedOutput": {
    "publicKey": "02a1b2c3..."
  }
}
```

Becomes a test:

```typescript
describe('wallet/brc100', () => {
  test('getPublicKey happy path', async () => {
    const wallet = new Wallet();
    const result = await wallet.getPublicKey('m/44\'/0\'/0\'/0/0');
    expect(result).toEqual('02a1b2c3...');
  });
});
```

## Debugging

### Run single test
```bash
jest --testNamePattern="getPublicKey happy path"
```

### Debug in VSCode
Add to `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Conformance",
  "program": "${workspaceFolder}/node_modules/.bin/jest",
  "args": ["--runInBand", "--testPathPattern=conformance"],
  "console": "integratedTerminal"
}
```

Then press F5 to debug.

### Inspect actual vs expected
```bash
pnpm conformance --verbose --domain wallet/brc100 2>&1 | grep -A20 "FAIL"
```

## Performance Tuning

### Parallel execution
```bash
pnpm conformance --workers=8
```

### Sequential (slower, better for debugging)
```bash
pnpm conformance --runInBand
```

### Skip slow tests
```bash
pnpm conformance --testNamePattern="^((?!slow).)*$"
```

## Environment Setup

Ensure you have:

- Node.js 18+
- pnpm 8+
- Dependencies installed: `pnpm install`

```bash
node --version  # v18.0.0 or higher
pnpm --version  # 8.0.0 or higher
```

## Troubleshooting

### Tests timeout
Increase Jest timeout in test file:

```typescript
jest.setTimeout(10000);  // 10 seconds
```

### Import errors
Clear cache:

```bash
pnpm conformance --clearCache
```

### Out of memory
Reduce workers:

```bash
pnpm conformance --workers=2
```

## Continuous Integration

The runner is configured for CI in `.github/workflows/conformance.yml`:

```yaml
- name: Run TS Conformance
  run: pnpm conformance
  
- name: Upload Results
  uses: actions/upload-artifact@v3
  with:
    name: ts-conformance-results
    path: conformance/results/ts-results-*.json
```

## Next Steps

- [Vector Catalog](./vectors.md) — Browse available vectors
- [Go Runner](./runner-go.md) — Run vectors in Go
- [Contributing](./contributing-vectors.md) — Add new vectors
