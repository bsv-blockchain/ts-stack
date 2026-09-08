# Independent BRC-136 fixture

brc136-independent.json is copied byte-for-byte from the Go BASM
foundation fixture:

/Users/personal/git/go/worktrees/go-overlay-services-basm/pkg/core/basm/testdata/vectors.json

Source commit: d99216814a4b9dca5f9f4d04a602ef2d48bdc4a7
Go worktree revision used for inventory: faaf69d372fd5e9974eaadbae9b8e26d761f0c86
BRC-136 revision: 2733cd2950a739b3c977b95d652ff63e3773c40b
Fixture SHA-256: 51983432bb561e3031fb7c983947dc8bfdcfd0ef828ef9f24093666ff4665c8a

The vectors cover ordered admitted subsets, multi-level Merkle roots,
Bitcoin odd-node duplication, original display/internal byte order, and
contiguous TAC chains through empty heights. The
repeated-last-four-illustrative-invalid vector intentionally shares a root
with the three-leaf illustrative vector. Primitive root calculation accepts
that input, while admitted-list validation must reject duplicate transaction
IDs. This fixture does not define multiproof wire bytes.

TypeScript tests recompute every root and TAC with Node crypto SHA-256d and,
when present, OpenSSL `dgst -sha256`; they do not treat the Go expected
values as authoritative without that independent check.
`basm-go-read-server.go` is a local B01 interop host compiled into a temporary
module. It replaces onto the Go overlay-services worktree and must not modify
that tree's uncommitted S04 files.
