# Schemathesis Contract Tests — ARC (Broadcast)

Property-based contract tests for `specs/broadcast/arc.yaml`, powered by [Schemathesis](https://schemathesis.readthedocs.io/).

## Prerequisites

```bash
pip install schemathesis
```

## Usage

Set the `BASE_URL` environment variable to point at a running server, then run the script:

```bash
BASE_URL=https://your-server.example.com bash schemathesis.sh
```

If `BASE_URL` is not set it defaults to `http://localhost:3000`.

## What it does

- Reads `../../arc.yaml` (relative to this directory)
- Runs all built-in Schemathesis checks (`--checks all`)
- Follows OpenAPI response links for stateful testing (`--stateful=links`)
- Writes a JUnit-compatible XML report to `results.xml` in this directory
