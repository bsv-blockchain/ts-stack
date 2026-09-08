// Temporary B01 interop host. Compiled from the TypeScript test into a temp
// module that replaces onto the local go-overlay-services worktree. It does not
// live in that worktree and must not be used to edit S04 files.
package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/gofiber/fiber/v2"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/basm"
	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-overlay-services/pkg/core/gasp"
	"github.com/bsv-blockchain/go-overlay-services/pkg/server"
)

const (
	interopTopic        = "tm_interop"
	interopGenesisID    = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b"
	interopGenesisHex   = "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000"
	interopGenesisBlock = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	ready, err := newReadyService()
	if err != nil {
		return err
	}
	readyURL, err := listen(ready)
	if err != nil {
		return err
	}
	unsupportedURL, err := listen(nil)
	if err != nil {
		return err
	}
	fmt.Printf("READY %s\n", readyURL)
	fmt.Printf("UNSUPPORTED %s\n", unsupportedURL)
	_ = os.Stdout.Sync()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
	return nil
}

func listen(provider engine.BASMProvider) (string, error) {
	app := server.RegisterRoutesWithErrorHandler(fiber.New(fiber.Config{DisableStartupMessage: true}), &server.RegisterRoutesConfig{
		AdminBearerToken: "interop-admin-token",
		Engine:           stubEngine{},
		BASMProvider:     provider,
		BASMLimits:       basm.DefaultReadLimits(),
	})
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	go func() {
		if serveErr := app.Listener(listener); serveErr != nil {
			fmt.Fprintln(os.Stderr, serveErr)
		}
	}()
	return "http://" + listener.Addr().String(), nil
}

func newReadyService() (*engine.BASMReadService, error) {
	txid, err := basm.ParseHash(interopGenesisID)
	if err != nil {
		return nil, err
	}
	blockHash, err := basm.ParseHash(interopGenesisBlock)
	if err != nil {
		return nil, err
	}
	txidFlag := true
	transactionHash := chainhash.Hash(txid)
	proof := transaction.NewMerklePath(0, [][]*transaction.PathElement{{{
		Offset: 0,
		Hash:   &transactionHash,
		Txid:   &txidFlag,
	}}}).Bytes()
	anchor := basm.Anchor{TopicBlockAnchor: basm.TopicBlockAnchor{
		Topic:         interopTopic,
		BlockHeight:   0,
		BlockHash:     blockHash,
		BASMRoot:      txid,
		AdmittedCount: 1,
	}}
	anchor.TAC = basm.HashTACStep(basm.Hash{}, anchor.BlockHash, anchor.BASMRoot)
	storage := interopStorage{view: interopView{anchor: anchor, txid: txid, proof: proof}}
	headers := interopHeaders{header: engine.BASMCanonicalHeader{
		Height:           0,
		BlockHash:        blockHash,
		MerkleRoot:       txid,
		TransactionCount: 1,
	}}
	return engine.NewBASMReadService(storage, headers, basm.DefaultReadLimits())
}

type interopStorage struct{ view interopView }

func (s interopStorage) OpenBASMRead(_ context.Context, topic string, _ basm.ReadLimits) (engine.BASMReadView, error) {
	if topic != "" && topic != interopTopic {
		return nil, engine.ErrBASMNotFound
	}
	return s.view, nil
}

type interopView struct {
	anchor basm.Anchor
	txid   basm.Hash
	proof  []byte
}

func (v interopView) Tip(context.Context) (*basm.Anchor, error) {
	anchor := v.anchor
	return &anchor, nil
}

func (v interopView) Anchors(_ context.Context, from, to, _ uint32) ([]basm.Anchor, error) {
	if from != 0 || to != 0 {
		return nil, engine.ErrBASMNotReady
	}
	return []basm.Anchor{v.anchor}, nil
}

func (v interopView) Admitted(_ context.Context, height, _ uint32) ([]basm.AdmittedTxRef, error) {
	if height != 0 {
		return nil, engine.ErrBASMNotReady
	}
	return []basm.AdmittedTxRef{{TxID: v.txid, BlockIndex: 0}}, nil
}

func (v interopView) MerklePath(_ context.Context, txid basm.Hash, _ uint32) ([]byte, error) {
	if txid != v.txid {
		return nil, engine.ErrBASMNotFound
	}
	return append([]byte(nil), v.proof...), nil
}

func (v interopView) RawTx(_ context.Context, txid basm.Hash, _ uint32) ([]byte, error) {
	if txid != v.txid {
		return nil, engine.ErrBASMNotFound
	}
	return hex.DecodeString(interopGenesisHex)
}

func (interopView) CheckCurrent(context.Context) error { return nil }
func (interopView) Close() error                       { return nil }

type interopHeaders struct{ header engine.BASMCanonicalHeader }

func (h interopHeaders) CanonicalBASMHeader(_ context.Context, height uint32) (engine.BASMCanonicalHeader, error) {
	if height != h.header.Height {
		return engine.BASMCanonicalHeader{}, engine.ErrBASMNotReady
	}
	return h.header, nil
}

type stubEngine struct{}

func (stubEngine) Submit(_ context.Context, _ overlay.TaggedBEEF, _ engine.SumbitMode, onSteakReady engine.OnSteakReady) (overlay.Steak, error) {
	if onSteakReady != nil {
		onSteakReady(&overlay.Steak{})
	}
	return overlay.Steak{}, nil
}
func (stubEngine) Lookup(_ context.Context, _ *lookup.LookupQuestion) (*lookup.LookupAnswer, error) {
	return &lookup.LookupAnswer{}, nil
}
func (stubEngine) GetUTXOHistory(_ context.Context, _ *engine.Output, _ func(beef *transaction.Beef, outputIndex, currentDepth uint32) bool, _ uint32) (*engine.Output, error) {
	return &engine.Output{}, nil
}
func (stubEngine) SyncAdvertisements(context.Context) error { return nil }
func (stubEngine) StartGASPSync(context.Context) error      { return nil }
func (stubEngine) ProvideForeignSyncResponse(_ context.Context, _ *gasp.InitialRequest, _ string) (*gasp.InitialResponse, error) {
	return &gasp.InitialResponse{}, nil
}
func (stubEngine) ProvideForeignGASPNode(_ context.Context, _, _ *transaction.Outpoint, _ string) (*gasp.Node, error) {
	return &gasp.Node{}, nil
}
func (stubEngine) ListTopicManagers() map[string]*overlay.MetaData {
	return map[string]*overlay.MetaData{}
}
func (stubEngine) ListLookupServiceProviders() map[string]*overlay.MetaData {
	return map[string]*overlay.MetaData{}
}
func (stubEngine) GetDocumentationForLookupServiceProvider(string) (string, error) {
	return "", nil
}
func (stubEngine) GetDocumentationForTopicManager(string) (string, error) { return "", nil }
func (stubEngine) HandleNewMerkleProof(context.Context, *chainhash.Hash, *transaction.MerklePath) error {
	return nil
}
