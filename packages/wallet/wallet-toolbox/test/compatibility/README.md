# Released wallet sync compatibility

`releasedWalletSync.cjs` exercises the actual packed Node, client and mobile
StorageClient entry points against released and candidate authenticated HTTP
servers. Its 48 combinations cover both server versions, both client versions,
three entry points, SDK 2/3, and numeric-array JSON/negotiated compact-base64
requests. Each combination checks an independent 130-label postimage and all
12 replica families, including multichunk transaction/script/history bytes,
actual synthetic transaction/Merkle/header checks, mapped parents, tombstones,
certificate fields, commission bytes, exclusion of another identity, and an
unchanged repeat. It also checks that an archived operational sync-state does
not become a replica cursor. The synthetic header is a local fixture oracle;
these results do not establish a connection to a production chain provider.
This Node-hosted matrix does not qualify a browser or a physical mobile device.

The controller's first source574 qualification attempts found an SDK2 peer
resolution refusal and a released-server structural-limit refusal for the
original large numeric-array request. The first complete SDK3 inventory also
exposed an incorrect notification oracle: mapped destination notifications must
remain queued until local delivery, while the source's completed notification
must remain unchanged. Both states are now checked independently. These initial
failures remain recorded; the full
48-combination programme is not qualified. Finish the implementation and source
wiring before running it. Build the final graph, freeze the actual pack
outputs and dependencies, and prepare four separate installations. Do not use
workspace symlinks or silently replace released artifacts with source aliases.
The selected versions are wallet packages 2.14.5 and candidate 2.15.0, SDK 2.8.11
and independently pinned published SDK 3.2.1 versus this branch's SDK 3.3.0
candidate. Each installation and report identifies its actual SDK version;
matching candidate version labels across branches do not identify equal bytes.

The input file has exactly these four keys, each containing an absolute path to
an isolated installation with its own `node_modules`:

```json
{
  "releasedSdk2": "/qualification/released-sdk2",
  "candidateSdk2": "/qualification/candidate-sdk2",
  "releasedSdk3": "/qualification/released-sdk3",
  "candidateSdk3": "/qualification/candidate-sdk3"
}
```

After the complete source graph is admitted for qualification, run:

```sh
pnpm qualify:released-sync --cohorts /absolute/cohorts.json
```

The exported `runReleasedWalletSync` also accepts an optional fourth argument,
`{ continueOnCaseFailure: true, onCaseResult }`, for complete failure inventory.
It retains the original case order, payloads, data assertions and bounds. The
encoding observer checks the parsed RPC method only after the response finishes.
It never subscribes to request data or starts the stream; the server retains its
existing body ceiling. `binaryRequests` selects ordinary RPC encoding;
negotiated version-one `writeSyncTransferPart` requests separately require binary
JSON. Compact capability probes and version-one snapshot/journal destination
RPCs also retain their required codec. Independent fixed method lists and each
actual signed server advertisement identify those protocols. The controller
rejects numeric versioned requests, unexpected binary ordinary RPCs when
disabled, unaccounted binary requests and unreadable observations.
Each result
callback runs after the original physical-owner cleanup. Any failed case still
rejects the run; cleanup failure stops execution immediately. Default and CLI
behavior still stop at the first failure. A partial SDK3 inventory does not
qualify the original SDK2/SDK3 matrix.

Before installation, verify the released npm tarballs against these independently
read registry integrity values. Freeze candidate tarballs from the actual final
build and record their hashes alongside the exact source, Node/pnpm versions,
lockfile, installation files and qualification-controller inputs. Integrity
identifies bytes; successful compatibility still requires the real test results.

| Released artifact                   | npm SHA-512 integrity                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@bsv/wallet-toolbox@2.14.5`        | `sha512-RcXun1AaddEeraW1kO9IFdjm8Pzx6GdPHRjipDEZGrbfm4sGb4Hlj3raaexN5jxIBWF48O0W2JpVFVPTM8duPQ==` |
| `@bsv/wallet-toolbox-client@2.14.5` | `sha512-KPW+a3OQoZ6fDPGsM/FJMjulICzuzCy+Ucb5jpaiegwjmLSyFVpe11CrLIL2dceIJdoVxKv5utE3If2A1bWvUA==` |
| `@bsv/wallet-toolbox-mobile@2.14.5` | `sha512-ZN8eqIPQMG9OrC5xMdiIevss/jk5OIACLCzR9/cCkXKvwGlXl+tRKj8VWK4Jr/FVYv1jOLLzEFjfPFuunRxi0g==` |
| `@bsv/sdk@2.8.11`                   | `sha512-Kt70E52bGTCayebmKQJCmEKCFwwS1MOUJ4Q4mKLCadsktVpZMv4NoWjvEbO7VDIw3g5zo8RMJsTuRy5zFI77og==` |
| `@bsv/sdk@3.2.1`                    | `sha512-Xml2szbKhjMaDthC/FiDg80EchD09UXgR+lcH6BFJWoYpsROzEzBJ+C2+1zE7c0kzh6DwrxKaq90e8Rm0z0UtQ==` |

Run the controller in the separately agreed finite qualification process and
resource envelope. It opens only synthetic local SQLite files and loopback HTTP
listeners, installs and publishes nothing, and joins original owners during
cleanup. A failed close retains the fixture directory and reports both the
operation and cleanup errors. A successful report grants no host process-tree,
native-runtime, physical-device, deployed-provider or release qualification.
