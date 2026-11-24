# Published validation reference

`output-validation-cases.cjs` authors the public boundary cases.
`output-validation-4.0.1.json.gz` freezes observations from the independently
published `@bsv/sdk@4.0.1`, not the SDK source under test. The fixture records the
registry tarball URL, SHA-512 integrity and SHA-256. Tests require the exact case
inventory and bound decompression to16MiB. All fixture material is excluded from
the package build and published artifacts.

Cases include exact byte/depth/item limits, Unicode, error name/code/message,
negative zero, null/plain/cross-realm prototypes, own property descriptors,
aliasing and caller observation order. They complement independent BRC digest
vectors and properties; a published implementation is not a normative protocol
specification. Regeneration must never use current or mutated source.

The30 work budgets count native lexical/decoding calls for eligible24-field flat
records. All wrappers call through to the native method and restore synchronously
before assertions. Upper bounds allow15 percent plus eight extra operations over
the published reference; fewer operations pass. They detect loss of the explicit
fast path without requiring an exact algorithm trace or load-sensitive CPU timing.
They are not a CPU speedup claim or permission to bypass any validation boundary.

To regenerate deliberately, obtain the public `sdk-4.0.1.tgz` with `npm pack
@bsv/sdk@4.0.1 --pack-destination <reference-directory>` and run from the repo root:

```sh
node packages/sdk/src/overlay-tools/__tests/fixtures/regenerate-output-validation-oracle.cjs /absolute/path/sdk-4.0.1.tgz
```

Use the pinned Node/pnpm and a frozen SDK workspace installation. The generator
verifies both archive digests before extraction, loads only that archive's SDK
with the frozen dependency graph, writes the two oracle files deterministically
and removes its scratch directory. Review case-inventory changes, then run the
three complete output-protocol suites and all eleven mutation execution parts.
Local diagnostics do not replace exact-source hosted qualification.
