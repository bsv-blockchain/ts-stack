module github.com/bsv-blockchain/ts-stack/conformance/runner/go

go 1.25.0

require github.com/bsv-blockchain/go-sdk v0.0.0

require (
	github.com/davecgh/go-spew v1.1.1 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/pmezard/go-difflib v1.0.0 // indirect
	github.com/stretchr/testify v1.11.1 // indirect
	golang.org/x/crypto v0.48.0 // indirect
	golang.org/x/net v0.51.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

replace github.com/bsv-blockchain/go-sdk => ../../../go-sdk
