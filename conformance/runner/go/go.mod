module github.com/bsv-blockchain/ts-stack/conformance/runner/go

go 1.25.0

require github.com/bsv-blockchain/go-sdk v0.0.0

require (
	github.com/pkg/errors v0.9.1 // indirect
	golang.org/x/crypto v0.48.0 // indirect
)

replace github.com/bsv-blockchain/go-sdk => ../../../go-sdk
