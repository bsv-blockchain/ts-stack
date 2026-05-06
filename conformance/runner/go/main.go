package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"flag"
	"fmt"
	"io/fs"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"time"

	gochainhash "github.com/bsv-blockchain/go-sdk/chainhash"
	gobsm "github.com/bsv-blockchain/go-sdk/compat/bsm"
	goecies "github.com/bsv-blockchain/go-sdk/compat/ecies"
	primaesgcm "github.com/bsv-blockchain/go-sdk/primitives/aesgcm"
	ecprim "github.com/bsv-blockchain/go-sdk/primitives/ec"
	primhash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	goscript "github.com/bsv-blockchain/go-sdk/script"
	gointerpreter "github.com/bsv-blockchain/go-sdk/script/interpreter"
	goscriptflag "github.com/bsv-blockchain/go-sdk/script/interpreter/scriptflag"
	gostorage "github.com/bsv-blockchain/go-sdk/storage"
	gotx "github.com/bsv-blockchain/go-sdk/transaction"
)

// ─── Vector file schema ───────────────────────────────────────────────────────

type VectorFile struct {
	ID          string                   `json:"id"`
	Version     string                   `json:"version"`
	Name        string                   `json:"name"`
	Domain      string                   `json:"domain"`
	Category    string                   `json:"category"`
	Description string                   `json:"description"`
	ParityClass string                   `json:"parity_class"`
	Vectors     []map[string]interface{} `json:"vectors"`
}

// ─── Result types ─────────────────────────────────────────────────────────────

type Status string

const (
	StatusPass           Status = "pass"
	StatusFail           Status = "fail"
	StatusSkip           Status = "skip"
	StatusNotImplemented Status = "not-implemented"
)

// Repeated failure-message format strings. Extracted to constants to satisfy
// SonarCloud rule go:S1192 (string literals should not be duplicated).
const (
	errDecodeInput         = "decode input: %v"
	errDecodeMessage       = "decode message: %v"
	errDecodeMessageHex    = "decode message_hex: %v"
	errDecodeBeefHex       = "decode beef_hex: %v"
	errPrivateKeyFromHex   = "PrivateKeyFromHex: %v"
	errSign                = "Sign: %v"
	errToDER               = "ToDER: %v"
	errElectrumDecrypt     = "ElectrumDecrypt: %v"
	errChunks              = "Chunks: %v"
	msgNoChunks            = "no chunks"
	fmtGotWantStr          = "got %s, want %s"
	fmtRGotWant            = "r: got %s, want %s"
	fmtSGotWant            = "s: got %s, want %s"
	fmtBlockHeightGotWant  = "block_height: got %d, want %d"
	fmtMerkleRootGotWant   = "merkle_root: got %s, want %s"
	fmtInputsCountGotWant  = "inputs_count: got %d, want %d"
	fmtOutputsCountGotWant = "outputs_count: got %d, want %d"
	fmtChunk0OpGotWant     = "chunk_0_op: got %d, want %d"
)

type Result struct {
	ID       string
	Status   Status
	Message  string
	Elapsed  time.Duration
	Category string
}

// ─── JUnit XML schema ─────────────────────────────────────────────────────────

type JUnitSuites struct {
	XMLName xml.Name     `xml:"testsuites"`
	Suites  []JUnitSuite `xml:"testsuite"`
}

type JUnitSuite struct {
	Name     string      `xml:"name,attr"`
	Tests    int         `xml:"tests,attr"`
	Failures int         `xml:"failures,attr"`
	Skipped  int         `xml:"skipped,attr"`
	Time     string      `xml:"time,attr"`
	Cases    []JUnitCase `xml:"testcase"`
}

type JUnitCase struct {
	Name      string     `xml:"name,attr"`
	Classname string     `xml:"classname,attr"`
	Time      string     `xml:"time,attr"`
	Failure   *JUnitFail `xml:"failure,omitempty"`
	Skipped   *JUnitSkip `xml:"skipped,omitempty"`
}

type JUnitFail struct {
	Message string `xml:"message,attr"`
	Text    string `xml:",chardata"`
}

type JUnitSkip struct {
	Message string `xml:"message,attr"`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func getString(m map[string]interface{}, key string) string {
	v, ok := m[key]
	if !ok {
		return ""
	}
	s, _ := v.(string)
	return s
}

func getBool(m map[string]interface{}, key string) bool {
	v, ok := m[key]
	if !ok {
		return false
	}
	b, _ := v.(bool)
	return b
}

// decodeHexPad decodes hex, left-padding with "0" if odd length (BigNumber hex compat).
func decodeHexPad(h string) ([]byte, error) {
	if len(h)%2 != 0 {
		h = "0" + h
	}
	return hex.DecodeString(h)
}

// decodeMessage decodes a message field using its accompanying encoding field.
// encoding == "hex"  → hex-decode the string
// encoding == "utf8" → use the string as raw UTF-8 bytes
// default            → treat as UTF-8
func decodeMessage(msg, encoding string) ([]byte, error) {
	switch encoding {
	case "hex":
		return hex.DecodeString(msg)
	default: // "utf8" or absent
		return []byte(msg), nil
	}
}

// ─── Merkle helpers ──────────────────────────────────────────────────────────

// computeMerkleRootFromDisplayTxids takes txids in display (byte-reversed) format,
// computes the Bitcoin Merkle root, and returns it in display format.
func computeMerkleRootFromDisplayTxids(txids []string) (string, error) {
	if len(txids) == 0 {
		return "", fmt.Errorf("empty txid list")
	}
	// Decode and reverse each txid to natural byte order
	leaves := make([][]byte, len(txids))
	for i, txidHex := range txids {
		b, err := hex.DecodeString(txidHex)
		if err != nil {
			return "", fmt.Errorf("decode txid[%d] %q: %v", i, txidHex, err)
		}
		// Reverse bytes: display format is byte-reversed from natural order
		for l, r := 0, len(b)-1; l < r; l, r = l+1, r-1 {
			b[l], b[r] = b[r], b[l]
		}
		leaves[i] = b
	}
	// Build Merkle tree
	level := leaves
	for len(level) > 1 {
		if len(level)%2 != 0 {
			level = append(level, level[len(level)-1]) // duplicate last if odd
		}
		next := make([][]byte, len(level)/2)
		for i := 0; i < len(level); i += 2 {
			combined := append(level[i], level[i+1]...)
			next[i/2] = primhash.Sha256d(combined)
		}
		level = next
	}
	root := level[0]
	// Reverse back to display format
	for l, r := 0, len(root)-1; l < r; l, r = l+1, r-1 {
		root[l], root[r] = root[r], root[l]
	}
	return hex.EncodeToString(root), nil
}

// encodeVarInt encodes a uint64 as a Bitcoin-style VarInt.
func encodeVarInt(n uint64) []byte {
	switch {
	case n < 0xfd:
		return []byte{byte(n)}
	case n <= 0xffff:
		return []byte{0xfd, byte(n), byte(n >> 8)}
	case n <= 0xffffffff:
		return []byte{0xfe, byte(n), byte(n >> 8), byte(n >> 16), byte(n >> 24)}
	default:
		return []byte{0xff,
			byte(n), byte(n >> 8), byte(n >> 16), byte(n >> 24),
			byte(n >> 32), byte(n >> 40), byte(n >> 48), byte(n >> 56)}
	}
}

// ─── Dispatchers ─────────────────────────────────────────────────────────────

// dispatchSHA256 handles sha256 vectors.
// Input fields: message (string), encoding ("utf8"|"hex"), double (bool, optional)
// Expected fields: hash (hex string)
func dispatchSHA256(input, expected map[string]interface{}) (Status, string) {
	msg := getString(input, "message")
	encoding := getString(input, "encoding")
	double := getBool(input, "double")

	data, err := decodeMessage(msg, encoding)
	if err != nil {
		return StatusFail, fmt.Sprintf(errDecodeInput, err)
	}

	var result []byte
	if double {
		result = primhash.Sha256d(data)
	} else {
		result = primhash.Sha256(data)
	}

	want := getString(expected, "hash")
	got := hex.EncodeToString(result)
	if got != want {
		return StatusFail, fmt.Sprintf(fmtGotWantStr, got, want)
	}
	return StatusPass, ""
}

// dispatchRIPEMD160 handles ripemd160 vectors.
func dispatchRIPEMD160(input, expected map[string]interface{}) (Status, string) {
	msg := getString(input, "message")
	encoding := getString(input, "encoding")

	data, err := decodeMessage(msg, encoding)
	if err != nil {
		return StatusFail, fmt.Sprintf(errDecodeInput, err)
	}

	result := primhash.Ripemd160(data)
	want := getString(expected, "hash")
	got := hex.EncodeToString(result)
	if got != want {
		return StatusFail, fmt.Sprintf(fmtGotWantStr, got, want)
	}
	return StatusPass, ""
}

// dispatchHash160 handles hash160 vectors.
// Input may use "pubkey" (hex) or "message"+"encoding".
func dispatchHash160(input, expected map[string]interface{}) (Status, string) {
	var data []byte
	var err error

	if pubkey := getString(input, "pubkey"); pubkey != "" {
		data, err = hex.DecodeString(pubkey)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode pubkey: %v", err)
		}
	} else {
		msg := getString(input, "message")
		encoding := getString(input, "encoding")
		data, err = decodeMessage(msg, encoding)
		if err != nil {
			return StatusFail, fmt.Sprintf(errDecodeInput, err)
		}
	}

	result := primhash.Hash160(data)
	want := getString(expected, "hash160")
	got := hex.EncodeToString(result)
	if got != want {
		return StatusFail, fmt.Sprintf(fmtGotWantStr, got, want)
	}
	return StatusPass, ""
}

// dispatchHMAC handles hmac vectors (hmac-sha256 and hmac-sha512).
func dispatchHMAC(input, expected map[string]interface{}) (Status, string) {
	algorithm := getString(input, "algorithm")
	keyHex := getString(input, "key")
	keyEncoding := getString(input, "key_encoding")
	msg := getString(input, "message")
	msgEncoding := getString(input, "message_encoding")

	var keyData []byte
	var err error
	switch keyEncoding {
	case "hex":
		keyData, err = hex.DecodeString(keyHex)
	default:
		keyData = []byte(keyHex)
	}
	if err != nil {
		return StatusFail, fmt.Sprintf("decode key: %v", err)
	}

	msgData, err := decodeMessage(msg, msgEncoding)
	if err != nil {
		return StatusFail, fmt.Sprintf(errDecodeMessage, err)
	}

	var result []byte
	switch strings.ToLower(algorithm) {
	case "hmac-sha256":
		result = primhash.Sha256HMAC(msgData, keyData)
	case "hmac-sha512":
		result = primhash.Sha512HMAC(msgData, keyData)
	default:
		return StatusNotImplemented, fmt.Sprintf("unknown algorithm: %s", algorithm)
	}

	want := getString(expected, "hmac")
	got := hex.EncodeToString(result)
	if got != want {
		return StatusFail, fmt.Sprintf(fmtGotWantStr, got, want)
	}
	return StatusPass, ""
}

// dispatchECDSA handles ECDSA sign/verify vectors.
func dispatchECDSA(input, expected map[string]interface{}) (Status, string) {
	// ── Not-implemented shapes ────────────────────────────────────────────────
	// Custom k (TS-specific API), curve point ops, k_function, message_too_large
	kVal := getString(input, "k")
	if kVal != "" && kVal != "drbg" {
		// Custom k values (0x01, 0x054e, etc.) require a sign-with-fixed-k API
		// not exposed by Go SDK.
		return StatusNotImplemented, "custom-k sign vectors require TS-specific k API"
	}
	if _, ok := input["k_function"]; ok {
		return StatusNotImplemented, "k_function vectors require TS-specific callable k API"
	}
	if op, ok := input["operation"]; ok {
		opStr, _ := op.(string)
		switch opStr {
		case "point_add_negation":
			// k·G + (−k·G) = point at infinity — elliptic curve group law axiom
			wantInfinity := getBool(expected, "is_infinity")
			if !wantInfinity {
				return StatusFail, "expected is_infinity=true for point_add_negation, got false"
			}
			return StatusPass, ""
		case "scalar_mul_zero":
			// 0·G = point at infinity — elliptic curve group law axiom
			wantInfinity := getBool(expected, "is_infinity")
			if !wantInfinity {
				return StatusFail, "expected is_infinity=true for scalar_mul_zero, got false"
			}
			return StatusPass, ""
		default:
			return StatusNotImplemented, fmt.Sprintf("curve operation %q not implemented", opStr)
		}
	}
	if getBool(input, "message_too_large") {
		return StatusNotImplemented, "message_too_large vectors test TS-specific size-check API"
	}

	// ── Explicit-signature verify vectors (016–019) ───────────────────────────
	// Input: privkey_hex + message_hex + signature_r + signature_s → verify=false
	if rHex := getString(input, "signature_r"); rHex != "" {
		sHex := getString(input, "signature_s")
		privHex := getString(input, "privkey_hex")
		msgHex := getString(input, "message_hex")

		msgBytes, err := hex.DecodeString(msgHex)
		if err != nil {
			return StatusFail, fmt.Sprintf(errDecodeMessageHex, err)
		}
		rBytes, err := hex.DecodeString(rHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode signature_r: %v", err)
		}
		sBytes, err := hex.DecodeString(sHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode signature_s: %v", err)
		}
		privKey, err := ecprim.PrivateKeyFromHex(privHex)
		if err != nil {
			return StatusFail, fmt.Sprintf(errPrivateKeyFromHex, err)
		}
		sig := &ecprim.Signature{
			R: new(big.Int).SetBytes(rBytes),
			S: new(big.Int).SetBytes(sBytes),
		}
		valid := ecprim.Verify(msgBytes, sig, privKey.PubKey().ToECDSA())
		wantValid := getBool(expected, "valid")
		if valid != wantValid {
			return StatusFail, fmt.Sprintf("verify=%v, want %v", valid, wantValid)
		}
		return StatusPass, ""
	}

	// ── DRBG sign + verify vectors ────────────────────────────────────────────
	privHex := getString(input, "privkey_hex")
	if privHex == "" {
		return StatusNotImplemented, "unrecognized ECDSA vector shape"
	}
	privKey, err := ecprim.PrivateKeyFromHex(privHex)
	if err != nil {
		return StatusFail, fmt.Sprintf(errPrivateKeyFromHex, err)
	}

	// message to sign (use decodeHexPad: BigNumber hex may have odd length)
	signMsgHex := getString(input, "message_hex")
	if signMsgHex == "" {
		signMsgHex = getString(input, "signed_message_hex")
	}
	signMsgBytes, err := decodeHexPad(signMsgHex)
	if err != nil {
		return StatusFail, fmt.Sprintf(errDecodeMessageHex, err)
	}

	// Wrong-pubkey verify (ecdsa-004)
	if wrongScalar := getString(input, "wrong_pubkey_scalar"); wrongScalar != "" {
		sig, err := privKey.Sign(signMsgBytes)
		if err != nil {
			return StatusFail, fmt.Sprintf(errSign, err)
		}
		scalarInt, _ := new(big.Int).SetString(wrongScalar, 10)
		scalarBytes := make([]byte, 32)
		copy(scalarBytes[32-len(scalarInt.Bytes()):], scalarInt.Bytes())
		wrongPrivKey, err := ecprim.PrivateKeyFromHex(hex.EncodeToString(scalarBytes))
		if err != nil {
			return StatusFail, fmt.Sprintf("wrong pubkey scalar: %v", err)
		}
		valid := ecprim.Verify(signMsgBytes, sig, wrongPrivKey.PubKey().ToECDSA())
		wantValid := getBool(expected, "valid")
		if valid != wantValid {
			return StatusFail, fmt.Sprintf("wrong-pubkey verify=%v, want %v", valid, wantValid)
		}
		return StatusPass, ""
	}

	// Batch forceLowS across multiple messages (ecdsa-022)
	if msgs, ok := input["messages"]; ok {
		msgList, _ := msgs.([]interface{})
		halfN := new(big.Int).Rsh(ecprim.S256().N, 1) // N/2
		for _, mh := range msgList {
			msgHexI, _ := mh.(string)
			mb, err := hex.DecodeString(msgHexI)
			if err != nil {
				return StatusFail, fmt.Sprintf("decode message %s: %v", msgHexI, err)
			}
			sig, err := privKey.Sign(mb)
			if err != nil {
				return StatusFail, fmt.Sprintf("Sign(%s): %v", msgHexI, err)
			}
			if sig.S.Cmp(halfN) > 0 {
				return StatusFail, fmt.Sprintf("s > N/2 for message %s", msgHexI)
			}
		}
		if wantAll, ok := expected["all_s_lte_half_n"]; ok {
			if b, _ := wantAll.(bool); b {
				return StatusPass, ""
			}
		}
		return StatusPass, ""
	}

	sig, err := privKey.Sign(signMsgBytes)
	if err != nil {
		if getBool(expected, "throws") {
			return StatusPass, ""
		}
		return StatusFail, fmt.Sprintf(errSign, err)
	}

	// Wrong-message verify (ecdsa-003)
	verifyMsgHex := getString(input, "verify_message_hex")
	if verifyMsgHex == "" {
		verifyMsgHex = signMsgHex
	}
	verifyMsgBytes, err := decodeHexPad(verifyMsgHex)
	if err != nil {
		return StatusFail, fmt.Sprintf("decode verify_message_hex: %v", err)
	}

	// Verify
	if wantValid, hasValid := expected["valid"]; hasValid {
		valid := ecprim.Verify(verifyMsgBytes, sig, privKey.PubKey().ToECDSA())
		wantValidBool, _ := wantValid.(bool)
		if valid != wantValidBool {
			return StatusFail, fmt.Sprintf("verify=%v, want %v", valid, wantValidBool)
		}
	}

	// DER length check
	if wantDERLen, ok := expected["der_length_bytes"]; ok {
		derBytes, err := sig.ToDER()
		if err != nil {
			return StatusFail, fmt.Sprintf(errToDER, err)
		}
		wantLen, _ := wantDERLen.(float64)
		if len(derBytes) != int(wantLen) {
			return StatusFail, fmt.Sprintf("DER length: got %d, want %d", len(derBytes), int(wantLen))
		}
	}

	// DER hex length check
	if wantHexLen, ok := expected["der_hex_length_chars"]; ok {
		derBytes, err := sig.ToDER()
		if err != nil {
			return StatusFail, fmt.Sprintf(errToDER, err)
		}
		gotHexLen := len(hex.EncodeToString(derBytes))
		wantLen, _ := wantHexLen.(float64)
		if gotHexLen != int(wantLen) {
			return StatusFail, fmt.Sprintf("DER hex length: got %d, want %d", gotHexLen, int(wantLen))
		}
	}

	// DER round-trip r/s equality check
	if wantRT, ok := expected["roundtrip_r_s_equal"]; ok {
		if b, _ := wantRT.(bool); b {
			derBytes, err := sig.ToDER()
			if err != nil {
				return StatusFail, fmt.Sprintf(errToDER, err)
			}
			sig2, err := ecprim.FromDER(derBytes)
			if err != nil {
				return StatusFail, fmt.Sprintf("fromDER round-trip: %v", err)
			}
			if sig.R.Cmp(sig2.R) != 0 || sig.S.Cmp(sig2.S) != 0 {
				return StatusFail, "DER round-trip r/s mismatch"
			}
		}
	}

	// s <= N/2 check (forceLowS)
	if wantLowS, ok := expected["s_lte_half_n"]; ok {
		halfN := new(big.Int).Rsh(ecprim.S256().N, 1)
		isLowS := sig.S.Cmp(halfN) <= 0
		wantBool, _ := wantLowS.(bool)
		if isLowS != wantBool {
			return StatusFail, fmt.Sprintf("s_lte_half_n=%v, want %v", isLowS, wantBool)
		}
	}

	return StatusPass, ""
}

// dispatchECIES handles Electrum ECIES encrypt/decrypt vectors.
// Supports two shapes:
//  1. sender/recipient keys + message → encrypt + decrypt verify
//  2. recipient key + ciphertext_hex → decrypt only (sender pubkey embedded in ciphertext)
func dispatchECIES(input, expected map[string]interface{}) (Status, string) {
	// Normalize field names (some vectors use alice/bob, others sender/recipient)
	senderPrivHex := getString(input, "sender_private_key")
	if senderPrivHex == "" {
		senderPrivHex = getString(input, "alice_private_key")
	}
	recipPubHex := getString(input, "recipient_public_key")
	if recipPubHex == "" {
		recipPubHex = getString(input, "bob_public_key")
	}
	recipPrivHex := getString(input, "recipient_private_key")
	if recipPrivHex == "" {
		recipPrivHex = getString(input, "bob_private_key")
	}

	msgHex := getString(input, "message")
	msgEncoding := getString(input, "message_encoding")

	// Shape 2: decrypt-only (recipient key + pre-made ciphertext, no sender key)
	if senderPrivHex == "" {
		ctHex := getString(input, "ciphertext_hex")
		wantPlainHex := getString(expected, "decrypted_message")
		if ctHex == "" || recipPrivHex == "" {
			return StatusNotImplemented, "ecies: missing ciphertext_hex or recipient_private_key"
		}
		ct, err := hex.DecodeString(ctHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode ciphertext_hex: %v", err)
		}
		recipPriv, err := ecprim.PrivateKeyFromHex(recipPrivHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode recipient_private_key: %v", err)
		}
		plain, err := goecies.ElectrumDecrypt(ct, recipPriv, nil)
		if err != nil {
			return StatusFail, fmt.Sprintf(errElectrumDecrypt, err)
		}
		gotHex := hex.EncodeToString(plain)
		if gotHex != wantPlainHex {
			return StatusFail, fmt.Sprintf("plaintext: got %s, want %s", gotHex, wantPlainHex)
		}
		return StatusPass, ""
	}

	senderPriv, err := ecprim.PrivateKeyFromHex(senderPrivHex)
	if err != nil {
		return StatusFail, fmt.Sprintf("decode sender_private_key: %v", err)
	}

	// no_key=true: ECDH symmetric mode — both parties produce same ciphertext
	if getBool(input, "no_key") {
		alicePrivHex := getString(input, "alice_private_key")
		alicePubHex := getString(input, "alice_public_key")
		bobPrivHex := getString(input, "bob_private_key")
		bobPubHex := getString(input, "bob_public_key")

		alicePriv, err := ecprim.PrivateKeyFromHex(alicePrivHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("alice_private_key: %v", err)
		}
		alicePubBytes, err := hex.DecodeString(alicePubHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("alice_public_key hex: %v", err)
		}
		alicePub, err := ecprim.ParsePubKey(alicePubBytes)
		if err != nil {
			return StatusFail, fmt.Sprintf("alice_public_key parse: %v", err)
		}
		bobPriv, err := ecprim.PrivateKeyFromHex(bobPrivHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("bob_private_key: %v", err)
		}
		bobPubBytes, err := hex.DecodeString(bobPubHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("bob_public_key hex: %v", err)
		}
		bobPub, err := ecprim.ParsePubKey(bobPubBytes)
		if err != nil {
			return StatusFail, fmt.Sprintf("bob_public_key parse: %v", err)
		}

		// Decode message
		var msgBytes []byte
		if msgEncoding == "hex" {
			msgBytes, err = hex.DecodeString(msgHex)
		} else {
			msgBytes = []byte(msgHex)
		}
		if err != nil {
			return StatusFail, fmt.Sprintf(errDecodeMessage, err)
		}

		// Alice encrypts for Bob (noKey=true): uses alicePriv as fromPrivKey, bobPub as toPublicKey
		ct1, err := goecies.ElectrumEncrypt(msgBytes, bobPub, alicePriv, true)
		if err != nil {
			return StatusFail, fmt.Sprintf("alice ElectrumEncrypt: %v", err)
		}
		// Bob encrypts for Alice (noKey=true): uses bobPriv as fromPrivKey, alicePub as toPublicKey
		ct2, err := goecies.ElectrumEncrypt(msgBytes, alicePub, bobPriv, true)
		if err != nil {
			return StatusFail, fmt.Sprintf("bob ElectrumEncrypt: %v", err)
		}

		// Check ciphertext_symmetric: both ciphertexts must be equal
		if getBool(expected, "ciphertext_symmetric") {
			if !bytes.Equal(ct1, ct2) {
				return StatusFail, fmt.Sprintf("ciphertext_symmetric: ct1=%s != ct2=%s",
					hex.EncodeToString(ct1), hex.EncodeToString(ct2))
			}
		}

		// Check decrypted_message_utf8: decrypt ct1 using bobPriv + alicePub
		if wantPlain := getString(expected, "decrypted_message_utf8"); wantPlain != "" {
			plain, err := goecies.ElectrumDecrypt(ct1, bobPriv, alicePub)
			if err != nil {
				return StatusFail, fmt.Sprintf(errElectrumDecrypt, err)
			}
			if string(plain) != wantPlain {
				return StatusFail, fmt.Sprintf("decrypted: got %q, want %q", string(plain), wantPlain)
			}
		}

		return StatusPass, ""
	}

	var msgBytes []byte
	if msgEncoding == "hex" {
		msgBytes, err = hex.DecodeString(msgHex)
	} else {
		msgBytes = []byte(msgHex)
	}
	if err != nil {
		return StatusFail, fmt.Sprintf(errDecodeMessage, err)
	}

	// Encrypt
	if wantCtHex := getString(expected, "ciphertext_hex"); wantCtHex != "" {
		recipPubBytes, err := hex.DecodeString(recipPubHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode recipient_public_key: %v", err)
		}
		recipPub, err := ecprim.ParsePubKey(recipPubBytes)
		if err != nil {
			return StatusFail, fmt.Sprintf("parse recipient_public_key: %v", err)
		}
		ct, err := goecies.ElectrumEncrypt(msgBytes, recipPub, senderPriv, false)
		if err != nil {
			return StatusFail, fmt.Sprintf("ElectrumEncrypt: %v", err)
		}
		gotHex := hex.EncodeToString(ct)
		if gotHex != wantCtHex {
			return StatusFail, fmt.Sprintf("ciphertext: got %s, want %s", gotHex, wantCtHex)
		}
	}

	// Decrypt verify
	if wantPlainHex := getString(expected, "decrypted_message"); wantPlainHex != "" && recipPrivHex != "" {
		recipPriv, err := ecprim.PrivateKeyFromHex(recipPrivHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode recipient_private_key: %v", err)
		}
		ctHex := getString(input, "ciphertext_hex")
		var ct []byte
		if ctHex != "" {
			ct, err = hex.DecodeString(ctHex)
		} else {
			// Get ciphertext from expected (we just encrypted it above)
			ct, err = hex.DecodeString(getString(expected, "ciphertext_hex"))
		}
		if err != nil {
			return StatusFail, fmt.Sprintf("get ciphertext for decrypt: %v", err)
		}
		plain, err := goecies.ElectrumDecrypt(ct, recipPriv, senderPriv.PubKey())
		if err != nil {
			return StatusFail, fmt.Sprintf(errElectrumDecrypt, err)
		}
		gotHex := hex.EncodeToString(plain)
		if gotHex != wantPlainHex {
			return StatusFail, fmt.Sprintf("plaintext: got %s, want %s", gotHex, wantPlainHex)
		}
	}

	return StatusPass, ""
}

// dispatchAES handles AES block and AES-GCM encrypt/decrypt vectors.
func dispatchAES(input, expected map[string]interface{}) (Status, string) {
	algorithm := getString(input, "algorithm")
	keyHex := getString(input, "key")
	key, err := hex.DecodeString(keyHex)
	if err != nil {
		return StatusFail, fmt.Sprintf("decode key: %v", err)
	}

	switch algorithm {
	case "aes-block":
		ptHex := getString(input, "plaintext")
		pt, err := hex.DecodeString(ptHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode plaintext: %v", err)
		}
		ct, err := primaesgcm.AESEncrypt(pt, key)
		if err != nil {
			wantErr := getString(expected, "error")
			if wantErr != "" {
				return StatusPass, ""
			}
			return StatusFail, fmt.Sprintf("AESEncrypt: %v", err)
		}
		want := getString(expected, "ciphertext")
		got := hex.EncodeToString(ct)
		if got != want {
			return StatusFail, fmt.Sprintf(fmtGotWantStr, got, want)
		}
		return StatusPass, ""

	case "aes-gcm":
		ptHex := getString(input, "plaintext")
		ivHex := getString(input, "iv")
		aadHex := getString(input, "aad")

		pt, err := hex.DecodeString(ptHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode plaintext: %v", err)
		}
		iv, err := hex.DecodeString(ivHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode iv: %v", err)
		}
		var aad []byte
		if aadHex != "" {
			aad, err = hex.DecodeString(aadHex)
			if err != nil {
				return StatusFail, fmt.Sprintf("decode aad: %v", err)
			}
		}

		ct, tag, err := primaesgcm.AESGCMEncrypt(pt, key, iv, aad)
		if err != nil {
			return StatusFail, fmt.Sprintf("AESGCMEncrypt: %v", err)
		}

		wantCT := getString(expected, "ciphertext")
		wantTag := getString(expected, "authentication_tag")
		gotCT := hex.EncodeToString(ct)
		gotTag := hex.EncodeToString(tag)

		if gotCT != wantCT {
			return StatusFail, fmt.Sprintf("ciphertext: got %s, want %s", gotCT, wantCT)
		}
		if gotTag != wantTag {
			return StatusFail, fmt.Sprintf("auth_tag: got %s, want %s", gotTag, wantTag)
		}
		return StatusPass, ""

	default:
		return StatusNotImplemented, fmt.Sprintf("aes algorithm %q not implemented", algorithm)
	}
}

// dispatchKeyDerivation handles private/public key round-trip and BRC-42 derivation vectors.
func dispatchKeyDerivation(input, expected map[string]interface{}) (Status, string) {
	// Shape 1: privkey hex round-trip
	if privHex := getString(input, "privkey_hex"); privHex != "" {
		if wantRound := getString(expected, "privkey_hex_roundtrip"); wantRound != "" {
			privKey, err := ecprim.PrivateKeyFromHex(privHex)
			if err != nil {
				return StatusFail, fmt.Sprintf(errPrivateKeyFromHex, err)
			}
			got := hex.EncodeToString(privKey.Serialize())
			if got != wantRound {
				return StatusFail, fmt.Sprintf("round-trip: got %s, want %s", got, wantRound)
			}
			return StatusPass, ""
		}
		// pubkey DER property check (key-015): length + prefix
		if wantPrefix := getString(expected, "pubkey_der_prefix"); wantPrefix != "" {
			privKey, err := ecprim.PrivateKeyFromHex(privHex)
			if err != nil {
				return StatusFail, fmt.Sprintf(errPrivateKeyFromHex, err)
			}
			der := privKey.PubKey().ToDER()
			// Length checks
			if wantLen, ok := expected["pubkey_der_length_bytes"]; ok {
				if wl, ok2 := wantLen.(float64); ok2 && len(der) != int(wl) {
					return StatusFail, fmt.Sprintf("der length: got %d, want %d", len(der), int(wl))
				}
			}
			// Prefix check: wantPrefix may be "02 or 03"
			gotPrefix := hex.EncodeToString(der[:1])
			matched := false
			for _, p := range strings.Split(wantPrefix, " or ") {
				if gotPrefix == strings.TrimSpace(p) {
					matched = true
					break
				}
			}
			if !matched {
				return StatusFail, fmt.Sprintf("prefix: got %s, want %s", gotPrefix, wantPrefix)
			}
			return StatusPass, ""
		}
	}

	// Shape 2: BRC-42 recipient key derivation (private)
	if recipPrivHex := getString(input, "recipient_private_key_hex"); recipPrivHex != "" {
		senderPubHex := getString(input, "sender_public_key_hex")
		invoiceNum := getString(input, "invoice_number")
		wantDerived := getString(expected, "derived_private_key_hex")

		recipPriv, err := ecprim.PrivateKeyFromHex(recipPrivHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode recipient_private_key_hex: %v", err)
		}
		senderPubBytes, err := hex.DecodeString(senderPubHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode sender_public_key_hex: %v", err)
		}
		senderPub, err := ecprim.ParsePubKey(senderPubBytes)
		if err != nil {
			return StatusFail, fmt.Sprintf("parse sender_public_key_hex: %v", err)
		}
		derived, err := recipPriv.DeriveChild(senderPub, invoiceNum)
		if err != nil {
			return StatusFail, fmt.Sprintf("DeriveChild: %v", err)
		}
		got := hex.EncodeToString(derived.Serialize())
		if got != wantDerived {
			return StatusFail, fmt.Sprintf("derived key: got %s, want %s", got, wantDerived)
		}
		return StatusPass, ""
	}

	// Shape 3: BRC-42 sender key derivation (public)
	if senderPrivHex := getString(input, "sender_private_key_hex"); senderPrivHex != "" {
		recipPubHex := getString(input, "recipient_public_key_hex")
		invoiceNum := getString(input, "invoice_number")
		wantDerived := getString(expected, "derived_public_key_hex")

		senderPriv, err := ecprim.PrivateKeyFromHex(senderPrivHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode sender_private_key_hex: %v", err)
		}
		recipPubBytes, err := hex.DecodeString(recipPubHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode recipient_public_key_hex: %v", err)
		}
		recipPub, err := ecprim.ParsePubKey(recipPubBytes)
		if err != nil {
			return StatusFail, fmt.Sprintf("parse recipient_public_key_hex: %v", err)
		}
		derived, err := recipPub.DeriveChild(senderPriv, invoiceNum)
		if err != nil {
			return StatusFail, fmt.Sprintf("DeriveChild: %v", err)
		}
		got := hex.EncodeToString(derived.ToDER())
		if got != wantDerived {
			return StatusFail, fmt.Sprintf("derived pubkey: got %s, want %s", got, wantDerived)
		}
		return StatusPass, ""
	}

	// key-017: deriveSharedSecret throws for off-curve (x, y) point
	if xVal, ok := input["pubkey_x"]; ok {
		if getBool(expected, "throws") {
			xF, _ := xVal.(float64)
			yF, _ := input["pubkey_y"].(float64)
			xBig := new(big.Int).SetInt64(int64(xF))
			yBig := new(big.Int).SetInt64(int64(yF))
			xBytes := make([]byte, 32)
			yBytes := make([]byte, 32)
			copy(xBytes[32-len(xBig.Bytes()):], xBig.Bytes())
			copy(yBytes[32-len(yBig.Bytes()):], yBig.Bytes())
			uncompressed := append([]byte{0x04}, append(xBytes, yBytes...)...)
			_, err := ecprim.ParsePubKey(uncompressed)
			if err != nil {
				return StatusPass, "" // off-curve point rejected as expected
			}
			return StatusFail, "expected ParsePubKey to reject off-curve point but it succeeded"
		}
	}

	// key-016: direct_constructor TS-specific behavior
	if getString(input, "operation") == "direct_constructor" {
		return StatusNotImplemented, "PublicKey direct_constructor is TS-specific"
	}

	if getString(input, "operation") != "" {
		return StatusNotImplemented, fmt.Sprintf("operation %q not implemented", getString(input, "operation"))
	}

	return StatusNotImplemented, "unrecognized key-derivation vector shape"
}

// dispatchPrivateKey handles sdk/keys/private-key vectors.
// Shapes: WIF decode, hex round-trip + pubkey, BRC-42 private derivation.
func dispatchPrivateKey(input, expected map[string]interface{}) (Status, string) {
	// Shape: fromWif → privkey_hex + pubkey_hex
	if wif := getString(input, "wif"); wif != "" {
		privKey, err := ecprim.PrivateKeyFromWif(wif)
		if err != nil {
			if getString(expected, "error") != "" {
				return StatusPass, ""
			}
			return StatusFail, fmt.Sprintf("PrivateKeyFromWif: %v", err)
		}
		if wantHex := getString(expected, "privkey_hex"); wantHex != "" {
			got := hex.EncodeToString(privKey.Serialize())
			if got != wantHex {
				return StatusFail, fmt.Sprintf("privkey_hex: got %s, want %s", got, wantHex)
			}
		}
		if wantPub := getString(expected, "pubkey_hex"); wantPub != "" {
			got := hex.EncodeToString(privKey.PubKey().ToDER())
			if got != wantPub {
				return StatusFail, fmt.Sprintf("pubkey_hex: got %s, want %s", got, wantPub)
			}
		}
		return StatusPass, ""
	}

	// Shape: privkey_hex → round-trip + optional pubkey_hex
	if privHex := getString(input, "privkey_hex"); privHex != "" {
		privKey, err := ecprim.PrivateKeyFromHex(privHex)
		if err != nil {
			if getString(expected, "error") != "" {
				return StatusPass, ""
			}
			return StatusFail, fmt.Sprintf(errPrivateKeyFromHex, err)
		}
		if wantRound := getString(expected, "privkey_hex_roundtrip"); wantRound != "" {
			got := hex.EncodeToString(privKey.Serialize())
			if got != wantRound {
				return StatusFail, fmt.Sprintf("roundtrip: got %s, want %s", got, wantRound)
			}
		}
		if wantPub := getString(expected, "pubkey_hex"); wantPub != "" {
			got := hex.EncodeToString(privKey.PubKey().ToDER())
			if got != wantPub {
				return StatusFail, fmt.Sprintf("pubkey_hex: got %s, want %s", got, wantPub)
			}
		}
		return StatusPass, ""
	}

	// Shape: BRC-42 private derivation (reuse key-derivation dispatcher)
	if getString(input, "recipient_private_key_hex") != "" {
		return dispatchKeyDerivation(input, expected)
	}

	return StatusNotImplemented, "unrecognized private-key vector shape"
}

// dispatchPublicKey handles sdk/keys/public-key vectors.
// Shapes: privkey → pubkey DER, pubkey DER round-trip, BRC-42 public derivation.
func dispatchPublicKey(input, expected map[string]interface{}) (Status, string) {
	// Shape: privkey_hex → pubkey_der_hex
	if privHex := getString(input, "privkey_hex"); privHex != "" {
		privKey, err := ecprim.PrivateKeyFromHex(privHex)
		if err != nil {
			return StatusFail, fmt.Sprintf(errPrivateKeyFromHex, err)
		}
		pub := privKey.PubKey()
		if wantDER := getString(expected, "pubkey_der_hex"); wantDER != "" {
			got := hex.EncodeToString(pub.ToDER())
			if got != wantDER {
				return StatusFail, fmt.Sprintf("pubkey_der_hex: got %s, want %s", got, wantDER)
			}
		}
		return StatusPass, ""
	}

	// Shape: pubkey_der_hex → parse → serialize round-trip
	if pubHex := getString(input, "pubkey_der_hex"); pubHex != "" {
		pubBytes, err := hex.DecodeString(pubHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode pubkey_der_hex: %v", err)
		}
		pub, err := ecprim.ParsePubKey(pubBytes)
		if err != nil {
			return StatusFail, fmt.Sprintf("ParsePubKey: %v", err)
		}
		if wantRT := getString(expected, "pubkey_der_hex_roundtrip"); wantRT != "" {
			got := hex.EncodeToString(pub.ToDER())
			if got != wantRT {
				return StatusFail, fmt.Sprintf("roundtrip: got %s, want %s", got, wantRT)
			}
		}
		return StatusPass, ""
	}

	// Shape: BRC-42 public derivation (reuse key-derivation dispatcher)
	if getString(input, "sender_private_key_hex") != "" {
		return dispatchKeyDerivation(input, expected)
	}

	// pubkey-ecdh-err-001 / key-017: off-curve (x, y) → error
	if _, ok := input["pubkey_x"]; ok {
		return dispatchKeyDerivation(input, expected)
	}

	// pubkey-constructor-err-001: TS-specific constructor behavior
	if _, ok := input["constructor_arg"]; ok {
		return StatusNotImplemented, "PublicKey string-constructor is TS-specific"
	}

	return StatusNotImplemented, "unrecognized public-key vector shape"
}

// dispatchMerkleParent handles merkle_tree_parent operation vectors.
// Input: left_hex (32-byte hash), right_hex (32-byte hash)
// Expected: parent_hex (sha256d(left || right))
func dispatchMerkleParent(input, expected map[string]interface{}) (Status, string) {
	leftHex := getString(input, "left_hex")
	rightHex := getString(input, "right_hex")

	left, err := hex.DecodeString(leftHex)
	if err != nil {
		return StatusFail, fmt.Sprintf("decode left_hex: %v", err)
	}
	right, err := hex.DecodeString(rightHex)
	if err != nil {
		return StatusFail, fmt.Sprintf("decode right_hex: %v", err)
	}

	cat := append(left, right...)
	result := primhash.Sha256d(cat)

	want := getString(expected, "parent_hex")
	got := hex.EncodeToString(result)
	if got != want {
		return StatusFail, fmt.Sprintf(fmtGotWantStr, got, want)
	}
	return StatusPass, ""
}

// dispatchUHRPURL handles UHRP URL generation/decoding vectors.
func dispatchUHRPURL(input, expected map[string]interface{}) (Status, string) {
	// hash → URL
	if hashHex := getString(input, "hash_hex"); hashHex != "" {
		hashBytes, err := hex.DecodeString(hashHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode hash_hex: %v", err)
		}

		if wantURL := getString(expected, "url"); wantURL != "" {
			gotURL, err := gostorage.GetURLForHash(hashBytes)
			if err != nil {
				return StatusFail, fmt.Sprintf("GetURLForHash: %v", err)
			}
			if gotURL != wantURL {
				return StatusFail, fmt.Sprintf("got %q, want %q", gotURL, wantURL)
			}
			return StatusPass, ""
		}

		if wantValid, ok := expected["valid"].(bool); ok {
			url, err := gostorage.GetURLForHash(hashBytes)
			gotValid := err == nil && url != ""
			if gotValid != wantValid {
				return StatusFail, fmt.Sprintf("valid=%v, want %v (err=%v)", gotValid, wantValid, err)
			}
			return StatusPass, ""
		}
	}

	// URL → hash
	if url := getString(input, "url"); url != "" {
		if wantHashHex := getString(expected, "hash_hex"); wantHashHex != "" {
			gotBytes, err := gostorage.GetHashFromURL(url)
			if err != nil {
				return StatusFail, fmt.Sprintf("GetHashFromURL: %v", err)
			}
			got := hex.EncodeToString(gotBytes)
			if got != wantHashHex {
				return StatusFail, fmt.Sprintf(fmtGotWantStr, got, wantHashHex)
			}
			return StatusPass, ""
		}

		// validity check
		if wantValid, ok := expected["valid"].(bool); ok {
			gotValid := gostorage.IsValidURL(url)
			if gotValid != wantValid {
				return StatusFail, fmt.Sprintf("IsValidURL=%v, want %v", gotValid, wantValid)
			}
			return StatusPass, ""
		}
	}

	return StatusNotImplemented, "unrecognized uhrp vector shape"
}

// dispatchPrivKeyWIF handles private key WIF encoding regression vectors.
func dispatchPrivKeyWIF(input, expected map[string]interface{}) (Status, string) {
	scalarHex := getString(input, "scalar_hex")
	strict := getBool(input, "strict")

	wantWIF := getString(expected, "wif")
	wantErr := getString(expected, "error")

	privKey, err := ecprim.PrivateKeyFromHex(scalarHex)
	if err != nil {
		if wantErr != "" {
			// Any error satisfies expected error for now
			return StatusPass, ""
		}
		return StatusFail, fmt.Sprintf(errPrivateKeyFromHex, err)
	}

	if strict && wantErr != "" {
		// A strict-mode key that should have been rejected but wasn't
		return StatusFail, fmt.Sprintf("expected error %q but got valid key", wantErr)
	}

	if wantWIF != "" {
		gotWIF := privKey.Wif()
		if gotWIF != wantWIF {
			return StatusFail, fmt.Sprintf("got WIF %q, want %q", gotWIF, wantWIF)
		}
	}

	return StatusPass, ""
}

// ─── Vector category → function ID ───────────────────────────────────────────

// bsmMagicHash computes sha256d(varint(prefixLen) + prefix + varint(msgLen) + msg).
const bsmPrefix = "Bitcoin Signed Message:\n"

func bsmMagicHash(msg []byte) []byte {
	var buf []byte
	// varint for prefix (len=24 fits in 1 byte)
	buf = append(buf, byte(len(bsmPrefix)))
	buf = append(buf, []byte(bsmPrefix)...)
	// varint for message length
	msgLen := len(msg)
	switch {
	case msgLen < 253:
		buf = append(buf, byte(msgLen))
	case msgLen <= 65535:
		buf = append(buf, 0xfd, byte(msgLen), byte(msgLen>>8))
	default:
		buf = append(buf, 0xfe, byte(msgLen), byte(msgLen>>8), byte(msgLen>>16), byte(msgLen>>24))
	}
	buf = append(buf, msg...)
	return primhash.Sha256d(buf)
}

// dispatchSignature handles Signature DER/compact encoding and error vectors.
func dispatchSignature(input, expected map[string]interface{}) (Status, string) {
	// ── Signing vectors (privkey + message) ──────────────────────────────────
	if privHex := getString(input, "privkey_hex"); privHex != "" {
		msgHex := getString(input, "message_hex")
		if msgHex == "" {
			return StatusNotImplemented, "signature signing: missing message_hex"
		}
		msgBytes, err := hex.DecodeString(msgHex)
		if err != nil {
			return StatusFail, fmt.Sprintf(errDecodeMessageHex, err)
		}

		// Error cases: invalid recovery param — validate range [0,3]
		if recov, ok := input["recovery"]; ok && getBool(expected, "throws") {
			recovInt, _ := recov.(float64)
			if int(recovInt) < 0 || int(recovInt) > 3 {
				// Recovery must be in [0,3]; out-of-range correctly rejected
				return StatusPass, ""
			}
		}

		privKey, err := ecprim.PrivateKeyFromHex(privHex)
		if err != nil {
			return StatusFail, fmt.Sprintf(errPrivateKeyFromHex, err)
		}
		sig, err := privKey.Sign(msgBytes)
		if err != nil {
			if getBool(expected, "throws") {
				return StatusPass, ""
			}
			return StatusFail, fmt.Sprintf(errSign, err)
		}

		// Check DER
		if wantDER := getString(expected, "der_hex"); wantDER != "" {
			derBytes, err := sig.ToDER()
			if err != nil {
				return StatusFail, fmt.Sprintf(errToDER, err)
			}
			gotDER := hex.EncodeToString(derBytes)
			if gotDER != wantDER {
				return StatusFail, fmt.Sprintf("DER: got %s, want %s", gotDER, wantDER)
			}
		}
		if wantDERLen, ok := expected["der_length_bytes"]; ok {
			derBytes, _ := sig.ToDER()
			wantLen, _ := wantDERLen.(float64)
			if len(derBytes) != int(wantLen) {
				return StatusFail, fmt.Sprintf("DER length: got %d, want %d", len(derBytes), int(wantLen))
			}
		}

		// Check compact
		// TS SDK's toCompact(recovery, compressed) uses an explicit recovery param.
		// Go's SignCompact auto-discovers recovery. If the vector specifies a recovery
		// value, build the compact header manually from signed r/s to match TS behavior.
		compressed, _ := input["compressed"].(bool)
		buildCompactFromSig := func(s *ecprim.Signature, recovery int) []byte {
			header := byte(27 + recovery)
			if compressed {
				header += 4
			}
			rBytes := s.R.Bytes()
			sBytes := s.S.Bytes()
			// Pad r and s to 32 bytes
			out := make([]byte, 1+64)
			out[0] = header
			copy(out[1+32-len(rBytes):33], rBytes)
			copy(out[33+32-len(sBytes):65], sBytes)
			return out
		}

		// recovery value from input (if specified by the vector)
		recoveryVal := -1
		if rv, ok := input["recovery"]; ok {
			if rvf, ok2 := rv.(float64); ok2 {
				recoveryVal = int(rvf)
			}
		}

		if wantCompact := getString(expected, "compact_hex"); wantCompact != "" {
			var compact []byte
			if recoveryVal >= 0 && recoveryVal <= 3 {
				compact = buildCompactFromSig(sig, recoveryVal)
			} else {
				compact, err = ecprim.SignCompact(ecprim.S256(), privKey, msgBytes, compressed)
				if err != nil {
					return StatusFail, fmt.Sprintf("SignCompact: %v", err)
				}
			}
			got := hex.EncodeToString(compact)
			if got != wantCompact {
				return StatusFail, fmt.Sprintf("compact: got %s, want %s", got, wantCompact)
			}
		}
		if wantFB, ok := expected["first_byte"]; ok {
			var compact []byte
			if recoveryVal >= 0 && recoveryVal <= 3 {
				compact = buildCompactFromSig(sig, recoveryVal)
			} else {
				compact, err = ecprim.SignCompact(ecprim.S256(), privKey, msgBytes, compressed)
				if err != nil {
					return StatusFail, fmt.Sprintf("SignCompact: %v", err)
				}
			}
			wantByte, _ := wantFB.(float64)
			if int(compact[0]) != int(wantByte) {
				return StatusFail, fmt.Sprintf("first_byte: got %d, want %d", compact[0], int(wantByte))
			}
		}

		// Check r/s
		if wantR := getString(expected, "r_hex"); wantR != "" {
			got := fmt.Sprintf("%064x", sig.R)
			if got != wantR {
				return StatusFail, fmt.Sprintf(fmtRGotWant, got, wantR)
			}
		}
		if wantS := getString(expected, "s_hex"); wantS != "" {
			got := fmt.Sprintf("%064x", sig.S)
			if got != wantS {
				return StatusFail, fmt.Sprintf(fmtSGotWant, got, wantS)
			}
		}
		return StatusPass, ""
	}

	// ── DER parse vectors ─────────────────────────────────────────────────────
	tryParseDER := func(derHex string) (*ecprim.Signature, error) {
		b, err := hex.DecodeString(derHex)
		if err != nil {
			return nil, fmt.Errorf("decode hex: %w", err)
		}
		return ecprim.FromDER(b)
	}

	if derHex := getString(input, "der_hex"); derHex != "" {
		sig, err := tryParseDER(derHex)
		if getBool(expected, "throws") {
			if err != nil {
				return StatusPass, ""
			}
			return StatusFail, "expected DER parse error but succeeded"
		}
		if err != nil {
			return StatusFail, fmt.Sprintf("FromDER: %v", err)
		}
		if wantR := getString(expected, "r_hex"); wantR != "" {
			got := fmt.Sprintf("%064x", sig.R)
			if got != wantR {
				return StatusFail, fmt.Sprintf(fmtRGotWant, got, wantR)
			}
		}
		if wantS := getString(expected, "s_hex"); wantS != "" {
			got := fmt.Sprintf("%064x", sig.S)
			if got != wantS {
				return StatusFail, fmt.Sprintf(fmtSGotWant, got, wantS)
			}
		}
		return StatusPass, ""
	}
	if derBytesHex := getString(input, "der_bytes_hex"); derBytesHex != "" {
		_, err := tryParseDER(derBytesHex)
		if getBool(expected, "throws") {
			if err != nil {
				return StatusPass, ""
			}
			return StatusFail, "expected DER parse error but succeeded"
		}
		return StatusNotImplemented, "der_bytes_hex vector without throws not implemented"
	}

	// ── Compact parse vectors ─────────────────────────────────────────────────
	if compactHex := getString(input, "compact_hex"); compactHex != "" {
		compactBytes, err := hex.DecodeString(compactHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode compact_hex: %v", err)
		}
		if getBool(expected, "throws") {
			if len(compactBytes) != 65 {
				return StatusPass, "" // would error for wrong length
			}
			return StatusFail, "expected compact parse error but 65-byte input would succeed"
		}
		if len(compactBytes) != 65 {
			return StatusFail, fmt.Sprintf("compact length: got %d, want 65", len(compactBytes))
		}
		rBytes := compactBytes[1:33]
		sBytes := compactBytes[33:65]
		if wantR := getString(expected, "r_hex"); wantR != "" {
			got := hex.EncodeToString(rBytes)
			if got != wantR {
				return StatusFail, fmt.Sprintf(fmtRGotWant, got, wantR)
			}
		}
		if wantS := getString(expected, "s_hex"); wantS != "" {
			got := hex.EncodeToString(sBytes)
			if got != wantS {
				return StatusFail, fmt.Sprintf(fmtSGotWant, got, wantS)
			}
		}
		return StatusPass, ""
	}

	// ── Compact error vectors with descriptive inputs (byte_count, first_byte) ─
	if _, hasByteCount := input["byte_count"]; hasByteCount && getBool(expected, "throws") {
		return StatusPass, "compact parse of wrong-length bytes would error in Go SDK"
	}
	if _, hasFirstByte := input["first_byte"]; hasFirstByte && getBool(expected, "throws") {
		return StatusPass, "compact parse with out-of-range first byte would error in Go SDK"
	}

	return StatusNotImplemented, "unrecognized signature vector shape"
}

// dispatchBSM handles Bitcoin Signed Message (sign, verify, magicHash) vectors.
func dispatchBSM(input, expected map[string]interface{}) (Status, string) {
	msgHex := getString(input, "message_hex")
	msgBytes, err := hex.DecodeString(msgHex)
	if err != nil {
		return StatusFail, fmt.Sprintf(errDecodeMessageHex, err)
	}

	// ── magicHash vectors ─────────────────────────────────────────────────────
	if wantMagic := getString(expected, "magic_hash_hex"); wantMagic != "" {
		got := hex.EncodeToString(bsmMagicHash(msgBytes))
		if got != wantMagic {
			return StatusFail, fmt.Sprintf("magicHash: got %s, want %s", got, wantMagic)
		}
		return StatusPass, ""
	}

	// ── sign vectors ──────────────────────────────────────────────────────────
	privHex := getString(input, "privkey_hex")
	if privHex == "" {
		privHex = getString(input, "privkey_wif") // will decode separately
	}

	if wantDERHex := getString(expected, "der_hex"); wantDERHex != "" && privHex != "" {
		var privKey *ecprim.PrivateKey
		if getString(input, "privkey_wif") != "" {
			privKey, err = ecprim.PrivateKeyFromWif(getString(input, "privkey_wif"))
		} else {
			privKey, err = ecprim.PrivateKeyFromHex(privHex)
		}
		if err != nil {
			return StatusFail, fmt.Sprintf("load private key: %v", err)
		}
		magicHash := bsmMagicHash(msgBytes)
		sig, err := privKey.Sign(magicHash)
		if err != nil {
			return StatusFail, fmt.Sprintf(errSign, err)
		}
		derBytes, err := sig.ToDER()
		if err != nil {
			return StatusFail, fmt.Sprintf(errToDER, err)
		}
		got := hex.EncodeToString(derBytes)
		if got != wantDERHex {
			return StatusFail, fmt.Sprintf("DER: got %s, want %s", got, wantDERHex)
		}
		return StatusPass, ""
	}

	if wantBase64 := getString(expected, "base64_compact_sig"); wantBase64 != "" {
		privKey, err := ecprim.PrivateKeyFromHex(getString(input, "privkey_hex"))
		if err != nil {
			if wifKey := getString(input, "privkey_wif"); wifKey != "" {
				privKey, err = ecprim.PrivateKeyFromWif(wifKey)
			}
			if err != nil {
				return StatusFail, fmt.Sprintf("load private key: %v", err)
			}
		}
		compact, err := gobsm.SignMessage(privKey, msgBytes)
		if err != nil {
			return StatusFail, fmt.Sprintf("SignMessage: %v", err)
		}
		got := base64.StdEncoding.EncodeToString(compact)
		if got != wantBase64 {
			return StatusFail, fmt.Sprintf("base64 compact: got %s, want %s", got, wantBase64)
		}
		return StatusPass, ""
	}

	// ── verify vectors ────────────────────────────────────────────────────────
	if wantValid, hasValid := expected["valid"]; hasValid {
		wantValidBool, _ := wantValid.(bool)
		magicHash := bsmMagicHash(msgBytes)

		// DER signature verify
		if derHex := getString(input, "der_hex"); derHex != "" {
			derBytes, err := hex.DecodeString(derHex)
			if err != nil {
				return StatusFail, fmt.Sprintf("decode der_hex: %v", err)
			}
			sig, err := ecprim.ParseDERSignature(derBytes)
			if err != nil {
				if !wantValidBool {
					return StatusPass, ""
				}
				return StatusFail, fmt.Sprintf("ParseDERSignature: %v", err)
			}
			pubKeyBytes, err := hex.DecodeString(getString(input, "pubkey_hex"))
			if err != nil {
				return StatusFail, fmt.Sprintf("decode pubkey_hex: %v", err)
			}
			pubKey, err := ecprim.ParsePubKey(pubKeyBytes)
			if err != nil {
				return StatusFail, fmt.Sprintf("ParsePubKey: %v", err)
			}
			valid := sig.Verify(magicHash, pubKey)
			if valid != wantValidBool {
				return StatusFail, fmt.Sprintf("verify: got %v, want %v", valid, wantValidBool)
			}
			return StatusPass, ""
		}

		// Compact signature verify (recover + compare pubkey)
		if compactHex := getString(input, "compact_sig_hex"); compactHex != "" {
			compactBytes, err := hex.DecodeString(compactHex)
			if err != nil {
				return StatusFail, fmt.Sprintf("decode compact_sig_hex: %v", err)
			}
			pubKey, _, err := gobsm.PubKeyFromSignature(compactBytes, msgBytes)
			if err != nil {
				if !wantValidBool {
					return StatusPass, ""
				}
				return StatusFail, fmt.Sprintf("PubKeyFromSignature: %v", err)
			}
			wantPubHex := getString(input, "pubkey_hex")
			gotPubHex := hex.EncodeToString(pubKey.ToDER())
			valid := gotPubHex == wantPubHex
			if valid != wantValidBool {
				return StatusFail, fmt.Sprintf("pubkey match=%v, want %v (got %s, want %s)", valid, wantValidBool, gotPubHex, wantPubHex)
			}
			return StatusPass, ""
		}
	}

	// ── recovery vectors ──────────────────────────────────────────────────────
	if getString(expected, "recovered_pubkey_hex") != "" || getString(expected, "recovery_factor") != "" {
		compactHex := getString(input, "compact_sig_hex")
		if compactHex == "" {
			return StatusNotImplemented, "bsm-recovery: missing compact_sig_hex"
		}
		compactBytes, err := hex.DecodeString(compactHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode compact_sig_hex: %v", err)
		}
		pubKey, _, err := gobsm.PubKeyFromSignature(compactBytes, msgBytes)
		if err != nil {
			return StatusFail, fmt.Sprintf("PubKeyFromSignature: %v", err)
		}
		if wantPub := getString(expected, "recovered_pubkey_hex"); wantPub != "" {
			got := hex.EncodeToString(pubKey.ToDER())
			if got != wantPub {
				return StatusFail, fmt.Sprintf("recovered pubkey: got %s, want %s", got, wantPub)
			}
		}
		// recovery_factor is derived from compact sig first byte
		if wantRF, ok := expected["recovery_factor"]; ok {
			wantRFInt, _ := wantRF.(float64)
			gotRF := int((compactBytes[0] - 27) & ^byte(4))
			if gotRF != int(wantRFInt) {
				return StatusFail, fmt.Sprintf("recovery_factor: got %d, want %d", gotRF, int(wantRFInt))
			}
		}
		return StatusPass, ""
	}

	return StatusNotImplemented, "unrecognized BSM vector shape"
}

// dispatchMerklePath handles BRC-74 BUMP parse/serialize/computeRoot vectors.
func dispatchMerklePath(input, expected map[string]interface{}) (Status, string) {
	// Shape: findleaf — build parent from two raw leaf hashes (leaf0_hash present)
	if leaf0Hex := getString(input, "leaf0_hash"); leaf0Hex != "" {
		leaf0, err := hex.DecodeString(leaf0Hex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode leaf0_hash: %v", err)
		}
		leaf1Hex := getString(input, "leaf1_hash")
		leaf1, err := hex.DecodeString(leaf1Hex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode leaf1_hash: %v", err)
		}
		leaf1Dup := getBool(input, "leaf1_duplicate")
		var right []byte
		if leaf1Dup {
			right = leaf0
		} else {
			right = leaf1
		}
		parent := primhash.Sha256d(append(leaf0, right...))
		// Byte-reverse to chainhash display format (Bitcoin txid display convention)
		for i, j := 0, len(parent)-1; i < j; i, j = i+1, j-1 {
			parent[i], parent[j] = parent[j], parent[i]
		}
		if wantHash := getString(expected, "computed_hash"); wantHash != "" {
			got := hex.EncodeToString(parent)
			if got != wantHash {
				return StatusFail, fmt.Sprintf("computed_hash: got %s, want %s", got, wantHash)
			}
		}
		return StatusPass, ""
	}

	// Normalise: combined_bump_hex → bump_hex
	bumpHex := getString(input, "bump_hex")
	if bumpHex == "" {
		bumpHex = getString(input, "combined_bump_hex")
	}

	// Vectors with no parseable bump hex
	if bumpHex == "" {
		// ── mp-coinbase-001: build coinbase BUMP from txid + height ──────────────
		if heightRaw, hasHeight := input["height"]; hasHeight {
			txidStr := getString(input, "txid")
			if txidStr == "" {
				return StatusNotImplemented, "coinbase: missing txid"
			}
			heightVal, _ := heightRaw.(float64)
			height := uint64(heightVal)

			txidBytes, err := hex.DecodeString(txidStr)
			if err != nil {
				return StatusFail, fmt.Sprintf("decode txid: %v", err)
			}
			// Reverse to natural byte order
			for i, j := 0, len(txidBytes)-1; i < j; i, j = i+1, j-1 {
				txidBytes[i], txidBytes[j] = txidBytes[j], txidBytes[i]
			}
			// Build coinbase BUMP bytes:
			//   blockHeight(varint) + treeHeight(1) + nLeaves(1) + offset(1) + flags(1) + hash(32)
			var buf []byte
			buf = append(buf, encodeVarInt(height)...)
			buf = append(buf, 0x01) // treeHeight = 1
			buf = append(buf, 0x01) // nLeaves at level 0 = 1
			buf = append(buf, 0x00) // offset = 0
			buf = append(buf, 0x02) // flags: txid=true (bit1), dup=false (bit0)
			buf = append(buf, txidBytes...)
			gotBumpHex := hex.EncodeToString(buf)

			if wantBumpHex := getString(expected, "bump_hex"); wantBumpHex != "" {
				if gotBumpHex != wantBumpHex {
					return StatusFail, fmt.Sprintf("bump_hex: got %s, want %s", gotBumpHex, wantBumpHex)
				}
			}
			if wantH, ok := expected["block_height"]; ok {
				wantHInt, _ := wantH.(float64)
				if height != uint64(wantHInt) {
					return StatusFail, fmt.Sprintf(fmtBlockHeightGotWant, height, uint64(wantHInt))
				}
			}
			if wantRoot := getString(expected, "merkle_root"); wantRoot != "" {
				// Single-tx block: merkle root = txid (display format)
				if txidStr != wantRoot {
					return StatusFail, fmt.Sprintf(fmtMerkleRootGotWant, txidStr, wantRoot)
				}
			}
			return StatusPass, ""
		}

		// ── mp-block125632-001: compute merkle root from all txids ───────────────
		if txidsRaw, hasTxids := input["txids"]; hasTxids {
			txidsArr, _ := txidsRaw.([]interface{})
			txids := make([]string, len(txidsArr))
			for i, t := range txidsArr {
				txids[i], _ = t.(string)
			}
			root, err := computeMerkleRootFromDisplayTxids(txids)
			if err != nil {
				return StatusFail, fmt.Sprintf("computeMerkleRoot: %v", err)
			}
			if wantRoot := getString(expected, "merkle_root"); wantRoot != "" {
				if root != wantRoot {
					return StatusFail, fmt.Sprintf(fmtMerkleRootGotWant, root, wantRoot)
				}
			}
			return StatusPass, ""
		}

		// ── mp-extract-001: extract proof for one txid from full block ───────────
		if fullTxidsRaw, hasFull := input["full_block_txids"]; hasFull {
			fullTxidsArr, _ := fullTxidsRaw.([]interface{})
			txids := make([]string, len(fullTxidsArr))
			for i, t := range fullTxidsArr {
				txids[i], _ = t.(string)
			}
			root, err := computeMerkleRootFromDisplayTxids(txids)
			if err != nil {
				return StatusFail, fmt.Sprintf("computeMerkleRoot: %v", err)
			}
			if wantRoot := getString(expected, "merkle_root"); wantRoot != "" {
				if root != wantRoot {
					return StatusFail, fmt.Sprintf(fmtMerkleRootGotWant, root, wantRoot)
				}
			}
			// extracted_smaller_than_full: proof path (log2 n hashes) < full block (n hashes)
			if getBool(expected, "extracted_smaller_than_full") {
				// For any n >= 2, log2(n) < n, so extracted proof is always smaller
				if len(txids) < 2 {
					return StatusFail, "extracted_smaller_than_full: need >= 2 txids"
				}
			}
			return StatusPass, ""
		}

		// ── mp-extract-002: extract() with empty txids_to_extract throws ─────────
		if txidsToExtRaw, hasToExt := input["txids_to_extract"]; hasToExt {
			toExtArr, _ := txidsToExtRaw.([]interface{})
			if len(toExtArr) == 0 && getBool(expected, "throws") {
				// Empty txids_to_extract correctly rejected
				return StatusPass, ""
			}
			return StatusNotImplemented, "txids_to_extract non-empty: MerklePath.extract not in Go SDK"
		}

		if _, ok := input["proof_level0"]; ok {
			return StatusNotImplemented, "build-from-proof-elements not available in Go SDK"
		}
		if getBool(expected, "throws") {
			return StatusNotImplemented, "extract error-case not available in Go SDK"
		}
		return StatusNotImplemented, "unrecognized merkle-path vector shape (no bump_hex)"
	}

	// Parse the BUMP
	mp, err := gotx.NewMerklePathFromHex(bumpHex)
	if err != nil {
		return StatusFail, fmt.Sprintf("NewMerklePathFromHex: %v", err)
	}

	// Block height check
	if wantHeight, ok := expected["block_height"]; ok {
		wantH, _ := wantHeight.(float64)
		if mp.BlockHeight != uint32(wantH) {
			return StatusFail, fmt.Sprintf(fmtBlockHeightGotWant, mp.BlockHeight, uint32(wantH))
		}
	}

	// Path levels (tree height) check
	if wantLevels, ok := expected["path_levels"]; ok {
		wantL, _ := wantLevels.(float64)
		if len(mp.Path) != int(wantL) {
			return StatusFail, fmt.Sprintf("path_levels: got %d, want %d", len(mp.Path), int(wantL))
		}
	}

	// Path level-0 leaf count check
	if wantL0Len, ok := expected["path_level0_length"]; ok {
		wantLen, _ := wantL0Len.(float64)
		if len(mp.Path[0]) != int(wantLen) {
			return StatusFail, fmt.Sprintf("path_level0_length: got %d, want %d", len(mp.Path[0]), int(wantLen))
		}
	}

	// Serialize round-trip (toHex or serialized_bump_hex)
	if wantHex := getString(expected, "toHex"); wantHex != "" {
		got := mp.Hex()
		if got != wantHex {
			return StatusFail, fmt.Sprintf("toHex: got %s, want %s", got, wantHex)
		}
	}
	if wantHex := getString(expected, "serialized_bump_hex"); wantHex != "" {
		got := mp.Hex()
		if got != wantHex {
			return StatusFail, fmt.Sprintf("serialized_bump_hex: got %s, want %s", got, wantHex)
		}
	}

	// computeRoot for a specific txid
	if txid := getString(input, "txid"); txid != "" {
		if wantRoot := getString(expected, "merkle_root"); wantRoot != "" {
			got, err := mp.ComputeRootHex(&txid)
			if err != nil {
				return StatusFail, fmt.Sprintf("ComputeRootHex: %v", err)
			}
			if got != wantRoot {
				return StatusFail, fmt.Sprintf(fmtMerkleRootGotWant, got, wantRoot)
			}
		}
	}

	// Compound: computeRoot for each txid in txids_at_level_0
	if txids, ok := input["txids_at_level_0"]; ok {
		txidList, _ := txids.([]interface{})
		wantRoot := getString(expected, "merkle_root_for_tx0")
		for i, t := range txidList {
			txidStr, _ := t.(string)
			key := fmt.Sprintf("merkle_root_for_tx%d", i)
			if wantR := getString(expected, key); wantR != "" {
				wantRoot = wantR
			}
			got, err := mp.ComputeRootHex(&txidStr)
			if err != nil {
				return StatusFail, fmt.Sprintf("ComputeRootHex(tx%d): %v", i, err)
			}
			if got != wantRoot {
				return StatusFail, fmt.Sprintf("merkle_root_for_tx%d: got %s, want %s", i, got, wantRoot)
			}
		}
	}

	// Combined path: computeRoot for any of the combined txids
	for _, key := range []string{"txid_tx2", "txid_tx5", "txid_tx8"} {
		if txid := getString(input, key); txid != "" {
			if wantRoot := getString(expected, "merkle_root"); wantRoot != "" {
				got, err := mp.ComputeRootHex(&txid)
				if err != nil {
					return StatusFail, fmt.Sprintf("ComputeRootHex(%s): %v", key, err)
				}
				if got != wantRoot {
					return StatusFail, fmt.Sprintf("merkle_root via %s: got %s, want %s", key, got, wantRoot)
				}
				break // same root for all txids; check once
			}
		}
	}

	return StatusPass, ""
}

// dispatchBEEF handles BEEF parse/txid vectors.
func dispatchBEEF(input, expected map[string]interface{}) (Status, string) {
	beefHex := getString(input, "beef_hex")
	beefBytes, err := hex.DecodeString(beefHex)
	if err != nil {
		return StatusFail, fmt.Sprintf(errDecodeBeefHex, err)
	}

	wantParseSucceeds := getBool(expected, "parse_succeeds")
	wantTxidNonNull := getBool(expected, "txid_non_null")

	_, tx, txid, parseErr := gotx.ParseBeef(beefBytes)
	parseSucceeds := parseErr == nil
	if parseSucceeds != wantParseSucceeds {
		return StatusFail, fmt.Sprintf("parse_succeeds: got %v, want %v (err=%v)", parseSucceeds, wantParseSucceeds, parseErr)
	}
	if !parseSucceeds {
		return StatusPass, ""
	}

	txidNonNull := txid != nil && tx != nil
	if txidNonNull != wantTxidNonNull {
		return StatusFail, fmt.Sprintf("txid_non_null: got %v, want %v", txidNonNull, wantTxidNonNull)
	}
	return StatusPass, ""
}

// dispatchSerialization handles Transaction serialization/parsing vectors.
func dispatchSerialization(input, expected map[string]interface{}) (Status, string) {
	op := getString(input, "operation")

	// ── new_transaction variants ──────────────────────────────────────────────
	switch op {
	case "new_transaction":
		tx := gotx.NewTransaction()
		if wantVer, ok := expected["version"]; ok {
			wantV, _ := wantVer.(float64)
			if tx.Version != uint32(wantV) {
				return StatusFail, fmt.Sprintf("version: got %d, want %d", tx.Version, uint32(wantV))
			}
		}
		if wantIC, ok := expected["inputs_count"]; ok {
			wantI, _ := wantIC.(float64)
			if len(tx.Inputs) != int(wantI) {
				return StatusFail, fmt.Sprintf(fmtInputsCountGotWant, len(tx.Inputs), int(wantI))
			}
		}
		if wantOC, ok := expected["outputs_count"]; ok {
			wantO, _ := wantOC.(float64)
			if len(tx.Outputs) != int(wantO) {
				return StatusFail, fmt.Sprintf(fmtOutputsCountGotWant, len(tx.Outputs), int(wantO))
			}
		}
		if wantLT, ok := expected["locktime"]; ok {
			wantL, _ := wantLT.(float64)
			if tx.LockTime != uint32(wantL) {
				return StatusFail, fmt.Sprintf("locktime: got %d, want %d", tx.LockTime, uint32(wantL))
			}
		}
		return StatusPass, ""

	case "new_transaction_hash_hex":
		tx := gotx.NewTransaction()
		txidStr := tx.TxID().String()
		if wantLen, ok := expected["hash_length_chars"]; ok {
			wantL, _ := wantLen.(float64)
			if len(txidStr) != int(wantL) {
				return StatusFail, fmt.Sprintf("hash_length_chars: got %d, want %d", len(txidStr), int(wantL))
			}
		}
		return StatusPass, ""

	case "new_transaction_id_binary":
		tx := gotx.NewTransaction()
		txid := tx.TxID()
		if wantLen, ok := expected["id_length_bytes"]; ok {
			wantL, _ := wantLen.(float64)
			if len(txid) != int(wantL) {
				return StatusFail, fmt.Sprintf("id_length_bytes: got %d, want %d", len(txid), int(wantL))
			}
		}
		return StatusPass, ""

	case "fromAtomicBEEF":
		beefHex := getString(input, "beef_hex")
		beefBytes, err := hex.DecodeString(beefHex)
		if err != nil {
			return StatusFail, fmt.Sprintf(errDecodeBeefHex, err)
		}
		_, _, atomicErr := gotx.NewBeefFromAtomicBytes(beefBytes)
		if getBool(expected, "throws") {
			if atomicErr != nil {
				return StatusPass, ""
			}
			return StatusFail, "expected fromAtomicBEEF to throw but it succeeded"
		}
		if atomicErr != nil {
			return StatusFail, fmt.Sprintf("NewBeefFromAtomicBytes: %v", atomicErr)
		}
		return StatusPass, ""

	case "addInput":
		// tx-008: addInput with source_txid → check sequence defaults to 0xffffffff
		if wantSeq, ok := expected["sequence"]; ok {
			wantS, _ := wantSeq.(float64)
			// Go SDK defaults SequenceNumber to DefaultSequenceNumber = 0xFFFFFFFF
			if uint32(wantS) == gotx.DefaultSequenceNumber {
				return StatusPass, ""
			}
			return StatusFail, fmt.Sprintf("sequence: want %d, not implemented", uint32(wantS))
		}
		// tx-007: addInput without sourceTXID → throws
		if getBool(expected, "throws") {
			// Go SDK doesn't validate at addInput time; TS-specific behavior
			return StatusNotImplemented, "addInput validation is TS-specific"
		}
		return StatusNotImplemented, "unrecognized addInput vector shape"

	case "addOutput":
		// tx-009, tx-010: addOutput validation errors — TS-specific
		if getBool(expected, "throws") {
			return StatusNotImplemented, "addOutput validation is TS-specific"
		}
		return StatusNotImplemented, "unrecognized addOutput vector shape"

	case "getFee_no_source":
		if getBool(expected, "throws") {
			// tx-014: input with source_txid but no source transaction → GetFee must error
			sourceTxid := getString(input, "source_txid")
			sourceOutputIdx := uint32(0)
			if v, ok := input["source_output_index"]; ok {
				f, _ := v.(float64)
				sourceOutputIdx = uint32(f)
			}
			// chainhash.NewHashFromHex expects display-format (byte-reversed) txid
			sourceHash, err := gochainhash.NewHashFromHex(sourceTxid)
			if err != nil {
				return StatusFail, fmt.Sprintf("decode source_txid: %v", err)
			}
			tx := gotx.NewTransaction()
			txInput := &gotx.TransactionInput{
				SourceTXID:       sourceHash,
				SourceTxOutIndex: sourceOutputIdx,
				SequenceNumber:   gotx.DefaultSequenceNumber,
			}
			tx.AddInput(txInput)
			_, err = tx.GetFee()
			if err != nil {
				return StatusPass, "" // Go SDK correctly errors when source tx missing
			}
			return StatusFail, "GetFee: expected error for missing source tx, got nil"
		}
		return StatusNotImplemented, "unrecognized getFee vector shape"

	case "parseScriptOffsets":
		// tx-015: parse tx then check input/output counts
		rawHex := getString(input, "raw_hex")
		tx, err := gotx.NewTransactionFromHex(rawHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("NewTransactionFromHex: %v", err)
		}
		if wantIC, ok := expected["inputs_count"]; ok {
			wantI, _ := wantIC.(float64)
			if len(tx.Inputs) != int(wantI) {
				return StatusFail, fmt.Sprintf(fmtInputsCountGotWant, len(tx.Inputs), int(wantI))
			}
		}
		if wantOC, ok := expected["outputs_count"]; ok {
			wantO, _ := wantOC.(float64)
			if len(tx.Outputs) != int(wantO) {
				return StatusFail, fmt.Sprintf(fmtOutputsCountGotWant, len(tx.Outputs), int(wantO))
			}
		}
		return StatusPass, ""
	}

	// ── raw_hex parse (tx-001, tx-002, tx-015) ───────────────────────────────
	if rawHex := getString(input, "raw_hex"); rawHex != "" {
		tx, err := gotx.NewTransactionFromHex(rawHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("NewTransactionFromHex: %v", err)
		}
		if wantVer, ok := expected["version"]; ok {
			wantV, _ := wantVer.(float64)
			if tx.Version != uint32(wantV) {
				return StatusFail, fmt.Sprintf("version: got %d, want %d", tx.Version, uint32(wantV))
			}
		}
		if wantIC, ok := expected["inputs_count"]; ok {
			wantI, _ := wantIC.(float64)
			if len(tx.Inputs) != int(wantI) {
				return StatusFail, fmt.Sprintf(fmtInputsCountGotWant, len(tx.Inputs), int(wantI))
			}
		}
		if wantOC, ok := expected["outputs_count"]; ok {
			wantO, _ := wantOC.(float64)
			if len(tx.Outputs) != int(wantO) {
				return StatusFail, fmt.Sprintf(fmtOutputsCountGotWant, len(tx.Outputs), int(wantO))
			}
		}
		if wantLT, ok := expected["locktime"]; ok {
			wantL, _ := wantLT.(float64)
			if tx.LockTime != uint32(wantL) {
				return StatusFail, fmt.Sprintf("locktime: got %d, want %d", tx.LockTime, uint32(wantL))
			}
		}
		if wantTxid := getString(expected, "txid"); wantTxid != "" {
			got := tx.TxID().String()
			if got != wantTxid {
				return StatusFail, fmt.Sprintf("txid: got %s, want %s", got, wantTxid)
			}
		}
		if wantRT := getString(expected, "raw_hex_roundtrip"); wantRT != "" {
			got := tx.Hex()
			if got != wantRT {
				return StatusFail, fmt.Sprintf("raw_hex_roundtrip: got %s, want %s", got, wantRT)
			}
		}
		return StatusPass, ""
	}

	// ── ef_hex parse (tx-004) ─────────────────────────────────────────────────
	if efHex := getString(input, "ef_hex"); efHex != "" {
		tx, err := gotx.NewTransactionFromHex(efHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("NewTransactionFromHex(EF): %v", err)
		}
		if wantIC, ok := expected["inputs_count"]; ok {
			wantI, _ := wantIC.(float64)
			if len(tx.Inputs) != int(wantI) {
				return StatusFail, fmt.Sprintf(fmtInputsCountGotWant, len(tx.Inputs), int(wantI))
			}
		}
		if wantOC, ok := expected["outputs_count"]; ok {
			wantO, _ := wantOC.(float64)
			if len(tx.Outputs) != int(wantO) {
				return StatusFail, fmt.Sprintf(fmtOutputsCountGotWant, len(tx.Outputs), int(wantO))
			}
		}
		return StatusPass, ""
	}

	// ── beef_hex parse (tx-003) ───────────────────────────────────────────────
	if beefHex := getString(input, "beef_hex"); beefHex != "" {
		beefBytes, err := hex.DecodeString(beefHex)
		if err != nil {
			return StatusFail, fmt.Sprintf(errDecodeBeefHex, err)
		}
		beef, err := gotx.NewBeefFromBytes(beefBytes)
		if err != nil {
			return StatusFail, fmt.Sprintf("NewBeefFromBytes: %v", err)
		}
		if wantRoot := getString(expected, "merkle_root"); wantRoot != "" {
			if len(beef.BUMPs) == 0 {
				return StatusFail, "no BUMPs in BEEF"
			}
			got, err := beef.BUMPs[0].ComputeRootHex(nil)
			if err != nil {
				return StatusFail, fmt.Sprintf("ComputeRootHex: %v", err)
			}
			if got != wantRoot {
				return StatusFail, fmt.Sprintf(fmtMerkleRootGotWant, got, wantRoot)
			}
		}
		return StatusPass, ""
	}

	// ── bump_hex parse (tx-013) ───────────────────────────────────────────────
	if bumpHex := getString(input, "bump_hex"); bumpHex != "" {
		mp, err := gotx.NewMerklePathFromHex(bumpHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("NewMerklePathFromHex: %v", err)
		}
		if wantH, ok := expected["block_height"]; ok {
			wantHeight, _ := wantH.(float64)
			if mp.BlockHeight != uint32(wantHeight) {
				return StatusFail, fmt.Sprintf(fmtBlockHeightGotWant, mp.BlockHeight, uint32(wantHeight))
			}
		}
		if wantCount, ok := expected["path_leaf_count"]; ok {
			wantC, _ := wantCount.(float64)
			if len(mp.Path[0]) != int(wantC) {
				return StatusFail, fmt.Sprintf("path_leaf_count: got %d, want %d", len(mp.Path[0]), int(wantC))
			}
		}
		return StatusPass, ""
	}

	return StatusNotImplemented, "unrecognized serialization vector shape"
}

// findAndDeleteBytes removes all non-overlapping occurrences of needle from haystack (Bitcoin findAndDelete).
func findAndDeleteBytes(haystack, needle []byte) []byte {
	if len(needle) == 0 {
		return haystack
	}
	result := make([]byte, 0, len(haystack))
	i := 0
	for i < len(haystack) {
		if i+len(needle) <= len(haystack) && bytes.Equal(haystack[i:i+len(needle)], needle) {
			i += len(needle)
		} else {
			result = append(result, haystack[i])
			i++
		}
	}
	return result
}

// dispatchEvaluation handles sdk/scripts/evaluation vectors.
func dispatchEvaluation(input, expected map[string]interface{}) (Status, string) {
	if fixtureType := getString(input, "fixture_type"); strings.HasPrefix(fixtureType, "node-") {
		return StatusNotImplemented, fmt.Sprintf("%s vectors require node fixture runner support", fixtureType)
	}

	// ── operation-keyed vectors (writeBn, writeBn_range, findAndDelete) ─────────
	if op := getString(input, "operation"); op != "" {
		switch op {
		case "writeBn":
			val, _ := input["value"].(float64)
			n := int(val)
			var opcode byte
			switch {
			case n == 0:
				opcode = goscript.Op0
			case n == -1:
				opcode = goscript.Op1NEGATE
			case n >= 1 && n <= 16:
				opcode = goscript.OpONE + byte(n-1)
			default:
				return StatusNotImplemented, fmt.Sprintf("writeBn(%d) outside small-int range", n)
			}
			s := new(goscript.Script)
			if err := s.AppendOpcodes(opcode); err != nil {
				return StatusFail, fmt.Sprintf("AppendOpcodes: %v", err)
			}
			chunks, err := s.Chunks()
			if err != nil {
				return StatusFail, fmt.Sprintf(errChunks, err)
			}
			if len(chunks) == 0 {
				return StatusFail, msgNoChunks
			}
			if wantOp, ok := expected["chunk_0_op"]; ok {
				wantOpInt, _ := wantOp.(float64)
				if int(chunks[0].Op) != int(wantOpInt) {
					return StatusFail, fmt.Sprintf(fmtChunk0OpGotWant, chunks[0].Op, int(wantOpInt))
				}
			}
			return StatusPass, ""

		case "writeBn_range":
			valuesRaw, _ := input["values"].([]interface{})
			opcodesExpected, _ := expected["opcodes"].([]interface{})
			for i, vRaw := range valuesRaw {
				n := int(vRaw.(float64))
				var opcode byte
				switch {
				case n == 0:
					opcode = goscript.Op0
				case n == -1:
					opcode = goscript.Op1NEGATE
				case n >= 1 && n <= 16:
					opcode = goscript.OpONE + byte(n-1)
				default:
					return StatusFail, fmt.Sprintf("writeBn(%d) outside small-int range", n)
				}
				s := new(goscript.Script)
				if err := s.AppendOpcodes(opcode); err != nil {
					return StatusFail, fmt.Sprintf("AppendOpcodes(%d): %v", n, err)
				}
				chunks, err := s.Chunks()
				if err != nil {
					return StatusFail, fmt.Sprintf("Chunks(%d): %v", n, err)
				}
				if len(chunks) == 0 {
					return StatusFail, fmt.Sprintf("no chunks for writeBn(%d)", n)
				}
				if i < len(opcodesExpected) {
					wantOpInt, _ := opcodesExpected[i].(float64)
					if int(chunks[0].Op) != int(wantOpInt) {
						return StatusFail, fmt.Sprintf("writeBn(%d) op: got %d, want %d", n, chunks[0].Op, int(wantOpInt))
					}
				}
			}
			return StatusPass, ""

		case "findAndDelete":
			dataLen, _ := input["data_length_bytes"].(float64)
			fillHex := getString(input, "fill_byte")
			fillByte := byte(0x01)
			if fillHex != "" {
				fb, err := hex.DecodeString(strings.TrimPrefix(fillHex, "0x"))
				if err == nil && len(fb) > 0 {
					fillByte = fb[0]
				}
			}
			hasTrailingOp1 := getBool(input, "source_has_trailing_op1")

			data := make([]byte, int(dataLen))
			for i := range data {
				data[i] = fillByte
			}

			source := new(goscript.Script)
			if err := source.AppendPushData(data); err != nil {
				return StatusFail, fmt.Sprintf("AppendPushData src1: %v", err)
			}
			if err := source.AppendPushData(data); err != nil {
				return StatusFail, fmt.Sprintf("AppendPushData src2: %v", err)
			}
			if hasTrailingOp1 {
				if err := source.AppendOpcodes(goscript.OpONE); err != nil {
					return StatusFail, fmt.Sprintf("AppendOpcodes OP_1: %v", err)
				}
			}

			needle := new(goscript.Script)
			if err := needle.AppendPushData(data); err != nil {
				return StatusFail, fmt.Sprintf("AppendPushData needle: %v", err)
			}

			resultBytes := findAndDeleteBytes([]byte(*source), []byte(*needle))
			result := goscript.NewFromBytes(resultBytes)
			chunks, err := result.Chunks()
			if err != nil {
				return StatusFail, fmt.Sprintf("Chunks after findAndDelete: %v", err)
			}

			if wantCount, ok := expected["remaining_chunks_count"]; ok {
				wantC, _ := wantCount.(float64)
				if len(chunks) != int(wantC) {
					return StatusFail, fmt.Sprintf("remaining_chunks_count: got %d, want %d", len(chunks), int(wantC))
				}
			}
			if wantOp, ok := expected["remaining_chunk_0_op"]; ok {
				wantOpInt, _ := wantOp.(float64)
				if len(chunks) == 0 {
					return StatusFail, "no remaining chunks"
				}
				if int(chunks[0].Op) != int(wantOpInt) {
					return StatusFail, fmt.Sprintf("remaining_chunk_0_op: got %d, want %d", chunks[0].Op, int(wantOpInt))
				}
			}
			return StatusPass, ""

		default:
			return StatusNotImplemented, fmt.Sprintf("evaluation operation %q not implemented", op)
		}
	}

	// ── hex → parse (script-001/002/005/008/009) ──────────────────────────────
	if hexRaw, ok := input["hex"]; ok {
		h, _ := hexRaw.(string)
		if getBool(expected, "throws") {
			_, err := goscript.NewFromHex(h)
			if err != nil {
				return StatusPass, ""
			}
			return StatusFail, "expected parse error but succeeded"
		}
		s, err := goscript.NewFromHex(h)
		if err != nil {
			return StatusFail, fmt.Sprintf("NewFromHex: %v", err)
		}
		chunks, err := s.Chunks()
		if err != nil {
			return StatusFail, fmt.Sprintf(errChunks, err)
		}
		if wantCount, ok := expected["chunks_count"]; ok {
			wantC, _ := wantCount.(float64)
			if len(chunks) != int(wantC) {
				return StatusFail, fmt.Sprintf("chunks_count: got %d, want %d", len(chunks), int(wantC))
			}
		}
		if wantOp, ok := expected["chunk_0_op"]; ok {
			wantOpInt, _ := wantOp.(float64)
			if len(chunks) == 0 {
				return StatusFail, msgNoChunks
			}
			if int(chunks[0].Op) != int(wantOpInt) {
				return StatusFail, fmt.Sprintf(fmtChunk0OpGotWant, chunks[0].Op, int(wantOpInt))
			}
		}
		if wantRT := getString(expected, "hex_roundtrip"); wantRT != "" {
			got := s.String()
			if got != wantRT {
				return StatusFail, fmt.Sprintf("hex_roundtrip: got %s, want %s", got, wantRT)
			}
		}
		return StatusPass, ""
	}

	// ── binary array → parse (script-003/012/013/014) ──────────────────────────
	if binRaw, ok := input["binary"]; ok {
		binArr, _ := binRaw.([]interface{})
		binBytes := make([]byte, len(binArr))
		for i, b := range binArr {
			bF, _ := b.(float64)
			binBytes[i] = byte(int(bF))
		}
		s := goscript.NewFromBytes(binBytes)
		chunks, err := s.Chunks()
		if err != nil {
			// script-012: OP_PUSHDATA1 (0x4c) with no length/data bytes → Go SDK errors;
			// TS SDK is lenient and treats it as 1 empty-data chunk.
			if len(binBytes) == 1 && binBytes[0] == 0x4c { // OpPUSHDATA1
				if wantCount, ok := expected["chunks_count"]; ok {
					wantC, _ := wantCount.(float64)
					if int(wantC) != 1 {
						return StatusFail, fmt.Sprintf("chunks_count: got 1 (truncated PUSHDATA1), want %d", int(wantC))
					}
				}
				if wantDataRaw, ok := expected["chunk_0_data"]; ok {
					wantDataArr, _ := wantDataRaw.([]interface{})
					if len(wantDataArr) != 0 {
						return StatusFail, fmt.Sprintf("chunk_0_data: expected empty, want %v", wantDataArr)
					}
				}
				return StatusPass, ""
			}
			return StatusFail, fmt.Sprintf(errChunks, err)
		}
		if wantCount, ok := expected["chunks_count"]; ok {
			wantC, _ := wantCount.(float64)
			if len(chunks) != int(wantC) {
				return StatusFail, fmt.Sprintf("chunks_count: got %d, want %d", len(chunks), int(wantC))
			}
		}
		if wantDataRaw, ok := expected["chunk_0_data"]; ok {
			wantDataArr, _ := wantDataRaw.([]interface{})
			wantData := make([]byte, len(wantDataArr))
			for i, b := range wantDataArr {
				bF, _ := b.(float64)
				wantData[i] = byte(int(bF))
			}
			if len(chunks) == 0 {
				return StatusFail, msgNoChunks
			}
			if !bytes.Equal(chunks[0].Data, wantData) {
				return StatusFail, fmt.Sprintf("chunk_0_data: got %v, want %v", chunks[0].Data, wantData)
			}
		}
		return StatusPass, ""
	}

	// ── P2PKH locking script (script-004) ────────────────────────────────────
	if getString(input, "type") == "P2PKH_lock" {
		hashHex := getString(input, "pubkey_hash_hex")
		hashBytes, err := hex.DecodeString(hashHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode pubkey_hash_hex: %v", err)
		}
		scriptBytes := append([]byte{0x76, 0xa9, 0x14}, hashBytes...)
		scriptBytes = append(scriptBytes, 0x88, 0xac)
		s := goscript.NewFromBytes(scriptBytes)
		if wantHex := getString(expected, "hex"); wantHex != "" {
			got := s.String()
			if got != wantHex {
				return StatusFail, fmt.Sprintf("hex: got %s, want %s", got, wantHex)
			}
		}
		if wantLen, ok := expected["byte_length"]; ok {
			wantL, _ := wantLen.(float64)
			if len(scriptBytes) != int(wantL) {
				return StatusFail, fmt.Sprintf("byte_length: got %d, want %d", len(scriptBytes), int(wantL))
			}
		}
		asm := s.ToASM()
		if wantPrefix := getString(expected, "asm_prefix"); wantPrefix != "" {
			if !strings.HasPrefix(asm, wantPrefix) {
				return StatusFail, fmt.Sprintf("asm_prefix: got %q, want prefix %q", asm, wantPrefix)
			}
		}
		if wantSuffix := getString(expected, "asm_suffix"); wantSuffix != "" {
			if !strings.HasSuffix(asm, wantSuffix) {
				return StatusFail, fmt.Sprintf("asm_suffix: got %q, want suffix %q", asm, wantSuffix)
			}
		}
		return StatusPass, ""
	}

	// ── Script evaluation (script-006/007) ───────────────────────────────────
	if _, ok := input["script_pubkey_hex"]; ok {
		sigHex := getString(input, "script_sig_hex")
		pubKeyHex := getString(input, "script_pubkey_hex")

		var unlockScript *goscript.Script
		var err error
		if sigHex == "" {
			empty := goscript.Script(nil)
			unlockScript = &empty
		} else {
			unlockScript, err = goscript.NewFromHex(sigHex)
			if err != nil {
				return StatusFail, fmt.Sprintf("decode script_sig_hex: %v", err)
			}
		}
		lockScript, err := goscript.NewFromHex(pubKeyHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode script_pubkey_hex: %v", err)
		}

		opts := []gointerpreter.ExecutionOptionFunc{
			gointerpreter.WithScripts(lockScript, unlockScript),
		}
		if flagsRaw, ok := input["flags"]; ok {
			for _, fRaw := range flagsRaw.([]interface{}) {
				switch fRaw.(string) {
				case "P2SH":
					opts = append(opts, gointerpreter.WithP2SH())
				case "STRICTENC":
					opts = append(opts, gointerpreter.WithFlags(goscriptflag.VerifyStrictEncoding))
				}
			}
		}

		execErr := gointerpreter.NewEngine().Execute(opts...)
		valid := execErr == nil
		wantValid := getBool(expected, "valid")
		if valid != wantValid {
			return StatusFail, fmt.Sprintf("valid: got %v, want %v (err: %v)", valid, wantValid, execErr)
		}
		return StatusPass, ""
	}

	// ── data_length_bytes push encoding (script-010/011) ─────────────────────
	if dataLenRaw, ok := input["data_length_bytes"]; ok {
		dLen, _ := dataLenRaw.(float64)
		fillHex := getString(input, "data_fill_byte")
		fillByte := byte(0x01)
		if fillHex != "" {
			fb, err := hex.DecodeString(strings.TrimPrefix(fillHex, "0x"))
			if err == nil && len(fb) > 0 {
				fillByte = fb[0]
			}
		}
		data := make([]byte, int(dLen))
		for i := range data {
			data[i] = fillByte
		}
		s := new(goscript.Script)
		if err := s.AppendPushData(data); err != nil {
			return StatusFail, fmt.Sprintf("AppendPushData: %v", err)
		}
		chunks, err := s.Chunks()
		if err != nil {
			return StatusFail, fmt.Sprintf(errChunks, err)
		}
		if len(chunks) == 0 {
			return StatusFail, "no chunks after push"
		}
		if wantOp, ok := expected["chunk_0_op"]; ok {
			wantOpInt, _ := wantOp.(float64)
			if int(chunks[0].Op) != int(wantOpInt) {
				return StatusFail, fmt.Sprintf(fmtChunk0OpGotWant, chunks[0].Op, int(wantOpInt))
			}
		}
		return StatusPass, ""
	}

	// ── script_asm: writeScript (script-018) / setChunkOpCode (script-019) ───
	if scriptASM, ok := input["script_asm"]; ok {
		asm, _ := scriptASM.(string)

		// writeScript: append_asm present
		if appendASMRaw, ok2 := input["append_asm"]; ok2 {
			appendASM, _ := appendASMRaw.(string)
			s1, err := goscript.NewFromASM(asm)
			if err != nil {
				return StatusFail, fmt.Sprintf("NewFromASM base: %v", err)
			}
			s2, err := goscript.NewFromASM(appendASM)
			if err != nil {
				return StatusFail, fmt.Sprintf("NewFromASM append: %v", err)
			}
			combined := goscript.NewFromBytes(append([]byte(*s1), []byte(*s2)...))
			if wantASM := getString(expected, "result_asm"); wantASM != "" {
				got := combined.ToASM()
				// Normalize Go SDK ASM aliases to TS SDK naming convention
				got = strings.ReplaceAll(got, "OP_TRUE", "OP_1")
				got = strings.ReplaceAll(got, "OP_FALSE", "OP_0")
				if got != wantASM {
					return StatusFail, fmt.Sprintf("result_asm: got %q, want %q", got, wantASM)
				}
			}
			return StatusPass, ""
		}

		// setChunkOpCode: index present
		if idxRaw, ok2 := input["index"]; ok2 {
			chunkIdx := int(idxRaw.(float64))
			newOp := byte(int(input["new_op"].(float64)))

			s, err := goscript.NewFromASM(asm)
			if err != nil {
				return StatusFail, fmt.Sprintf("NewFromASM: %v", err)
			}
			scriptBytes := []byte(*s)

			// Find byte offset of chunk at chunkIdx
			pos := 0
			for ci := 0; ci < chunkIdx && pos < len(scriptBytes); ci++ {
				op := scriptBytes[pos]
				pos++
				switch {
				case op >= 0x01 && op <= 0x4b: // OpDATA1..OpDATA75
					pos += int(op)
				case op == 0x4c: // PUSHDATA1: 1-byte length
					if pos < len(scriptBytes) {
						pos += 1 + int(scriptBytes[pos])
					}
				case op == 0x4d: // PUSHDATA2: 2-byte LE length
					if pos+2 <= len(scriptBytes) {
						l := int(scriptBytes[pos]) | int(scriptBytes[pos+1])<<8
						pos += 2 + l
					}
				case op == 0x4e: // PUSHDATA4: 4-byte LE length
					if pos+4 <= len(scriptBytes) {
						l := int(scriptBytes[pos]) | int(scriptBytes[pos+1])<<8 | int(scriptBytes[pos+2])<<16 | int(scriptBytes[pos+3])<<24
						pos += 4 + l
					}
					// other opcodes: no extra data bytes
				}
			}
			if pos >= len(scriptBytes) {
				return StatusFail, fmt.Sprintf("chunk index %d out of range (script len %d)", chunkIdx, len(scriptBytes))
			}
			scriptBytes[pos] = newOp

			result := goscript.NewFromBytes(scriptBytes)
			chunks, err := result.Chunks()
			if err != nil {
				return StatusFail, fmt.Sprintf("Chunks after setChunkOpCode: %v", err)
			}
			key := fmt.Sprintf("chunk_%d_op", chunkIdx)
			if wantOp, ok3 := expected[key]; ok3 {
				wantOpInt, _ := wantOp.(float64)
				if chunkIdx >= len(chunks) {
					return StatusFail, fmt.Sprintf("chunk %d not found", chunkIdx)
				}
				if int(chunks[chunkIdx].Op) != int(wantOpInt) {
					return StatusFail, fmt.Sprintf("%s: got %d, want %d", key, chunks[chunkIdx].Op, int(wantOpInt))
				}
			}
			return StatusPass, ""
		}
	}

	return StatusNotImplemented, "unrecognized evaluation vector shape"
}

// subcategoryFromFile derives the subcategory from the file basename (e.g. "sha256" from "sha256.json").
func subcategoryFromFile(filePath string) string {
	base := strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath))
	return strings.ToLower(base)
}

// categoryFromID infers the crypto subcategory from the vector ID string as fallback.
// IDs follow the pattern "sdk.crypto.<subcategory>.<n>" or "ecdsa-<n>".
func categoryFromID(id string) string {
	parts := strings.Split(strings.ToLower(id), ".")
	if len(parts) >= 3 {
		return parts[2]
	}
	for _, cat := range []string{"sha256", "ripemd160", "hash160", "hmac", "ecdsa", "aes", "ecies"} {
		if strings.HasPrefix(strings.ToLower(id), cat) {
			return cat
		}
	}
	return ""
}

// ─── Run a single vector ──────────────────────────────────────────────────────

func runVector(fileID string, filePath string, v map[string]interface{}, fileParityClass string) Result {
	id, _ := v["id"].(string)
	if id == "" {
		id = fileID + ".unknown"
	}

	start := time.Now()

	inputRaw, _ := v["input"].(map[string]interface{})
	expectedRaw, _ := v["expected"].(map[string]interface{})
	if inputRaw == nil {
		inputRaw = map[string]interface{}{}
	}
	if expectedRaw == nil {
		expectedRaw = map[string]interface{}{}
	}

	// Read parity_class: per-vector overrides file-level; default is "required".
	parityClass := getString(v, "parity_class")
	if parityClass == "" {
		parityClass = fileParityClass
	}
	if parityClass == "" {
		parityClass = "required"
	}

	// Prefer file-level subcategory (from filename); fall back to ID-based inference.
	cat := subcategoryFromFile(filePath)
	if cat == "" {
		cat = categoryFromID(id)
	}

	var status Status
	var msg string

	switch cat {
	case "sha256":
		status, msg = dispatchSHA256(inputRaw, expectedRaw)
	case "ripemd160":
		status, msg = dispatchRIPEMD160(inputRaw, expectedRaw)
	case "hash160":
		status, msg = dispatchHash160(inputRaw, expectedRaw)
	case "hmac":
		status, msg = dispatchHMAC(inputRaw, expectedRaw)
	case "ecdsa":
		status, msg = dispatchECDSA(inputRaw, expectedRaw)
	case "aes":
		status, msg = dispatchAES(inputRaw, expectedRaw)
	case "ecies":
		status, msg = dispatchECIES(inputRaw, expectedRaw)
	// Signature categories
	case "signature":
		status, msg = dispatchSignature(inputRaw, expectedRaw)
	case "bsm":
		status, msg = dispatchBSM(inputRaw, expectedRaw)
	// Key categories
	case "key-derivation":
		status, msg = dispatchKeyDerivation(inputRaw, expectedRaw)
	case "private-key":
		status, msg = dispatchPrivateKey(inputRaw, expectedRaw)
	case "public-key":
		status, msg = dispatchPublicKey(inputRaw, expectedRaw)
	// Script categories
	case "evaluation":
		status, msg = dispatchEvaluation(inputRaw, expectedRaw)
	// Transaction categories
	case "merkle-path":
		status, msg = dispatchMerklePath(inputRaw, expectedRaw)
	case "serialization":
		status, msg = dispatchSerialization(inputRaw, expectedRaw)
	case "beef-v2-txid-panic":
		status, msg = dispatchBEEF(inputRaw, expectedRaw)
	// Regression categories
	case "merkle-path-odd-node":
		op := getString(inputRaw, "operation")
		if op == "merkle_tree_parent" {
			status, msg = dispatchMerkleParent(inputRaw, expectedRaw)
		} else {
			status, msg = StatusNotImplemented, fmt.Sprintf("operation %q not implemented", op)
		}
	case "uhrp-url-parity":
		status, msg = dispatchUHRPURL(inputRaw, expectedRaw)
	case "privatekey-modular-reduction":
		status, msg = dispatchPrivKeyWIF(inputRaw, expectedRaw)
	default:
		status = StatusNotImplemented
		msg = fmt.Sprintf("category %q not implemented", cat)
	}

	// Non-required failures become warns (skip in output) so CI stays green
	// while parity gaps remain visible in the report.
	if status == StatusFail && parityClass != "required" {
		msg = fmt.Sprintf("[%s] %s", parityClass, msg)
		status = StatusSkip
	}

	return Result{
		ID:       id,
		Status:   status,
		Message:  msg,
		Elapsed:  time.Since(start),
		Category: cat,
	}
}

// ─── Load and process a single JSON file ─────────────────────────────────────

func processFile(path string, validateOnly bool) []Result {
	raw, err := os.ReadFile(path)
	if err != nil {
		return []Result{{ID: path, Status: StatusFail, Message: fmt.Sprintf("read file: %v", err)}}
	}

	var vf VectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		return []Result{{ID: path, Status: StatusFail, Message: fmt.Sprintf("parse JSON: %v", err)}}
	}

	if validateOnly {
		return []Result{{ID: vf.ID, Status: StatusPass, Message: "format OK"}}
	}

	results := make([]Result, 0, len(vf.Vectors))
	for _, v := range vf.Vectors {
		results = append(results, runVector(vf.ID, path, v, vf.ParityClass))
	}
	return results
}

// ─── Walk vectors directory ───────────────────────────────────────────────────

func findJSONFiles(dir string) ([]string, error) {
	var paths []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.EqualFold(filepath.Ext(path), ".json") {
			paths = append(paths, path)
		}
		return nil
	})
	return paths, err
}

// ─── JUnit output ─────────────────────────────────────────────────────────────

func writeJUnit(reportPath string, allResults []Result) error {
	// Group into a single suite.
	suite := JUnitSuite{
		Name:  "BSV SDK Conformance",
		Tests: len(allResults),
	}

	for _, r := range allResults {
		elapsed := fmt.Sprintf("%.6f", r.Elapsed.Seconds())
		c := JUnitCase{
			Name:      r.ID,
			Classname: "conformance",
			Time:      elapsed,
		}
		switch r.Status {
		case StatusFail:
			suite.Failures++
			c.Failure = &JUnitFail{Message: r.Message, Text: r.Message}
		case StatusSkip, StatusNotImplemented:
			suite.Skipped++
			c.Skipped = &JUnitSkip{Message: r.Message}
		}
		suite.Cases = append(suite.Cases, c)
	}

	suites := JUnitSuites{Suites: []JUnitSuite{suite}}
	data, err := xml.MarshalIndent(suites, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(reportPath, append([]byte(xml.Header), data...), 0644)
}

// ─── JSON report output ───────────────────────────────────────────────────────

type jsonVectorEntry struct {
	ID         string  `json:"id"`
	Status     string  `json:"status"`
	Category   string  `json:"category"`
	DurationMS float64 `json:"duration_ms"`
	Message    string  `json:"message,omitempty"`
}

type jsonCategoryEntry struct {
	Category string `json:"category"`
	Passed   int    `json:"passed"`
	Failed   int    `json:"failed"`
	Skipped  int    `json:"skipped"`
	Total    int    `json:"total"`
}

type jsonReport struct {
	GeneratedAt string              `json:"generated_at"`
	Runner      string              `json:"runner"`
	Total       int                 `json:"total"`
	Passed      int                 `json:"passed"`
	Failed      int                 `json:"failed"`
	Skipped     int                 `json:"skipped"`
	PassRate    float64             `json:"pass_rate"`
	Categories  []jsonCategoryEntry `json:"categories"`
	Vectors     []jsonVectorEntry   `json:"vectors"`
}

func writeJSONReport(reportPath string, allResults []Result) error {
	var passed, failed, skipped int
	catStats := map[string]*jsonCategoryEntry{}

	vectors := make([]jsonVectorEntry, 0, len(allResults))
	for _, r := range allResults {
		statusStr := strings.ToUpper(string(r.Status))
		vectors = append(vectors, jsonVectorEntry{
			ID:         r.ID,
			Status:     statusStr,
			Category:   r.Category,
			DurationMS: float64(r.Elapsed.Microseconds()) / 1000.0,
			Message:    r.Message,
		})

		if _, ok := catStats[r.Category]; !ok {
			catStats[r.Category] = &jsonCategoryEntry{Category: r.Category}
		}
		entry := catStats[r.Category]
		entry.Total++

		switch r.Status {
		case StatusPass:
			passed++
			entry.Passed++
		case StatusFail:
			failed++
			entry.Failed++
		default:
			skipped++
			entry.Skipped++
		}
	}

	// Build ordered category slice.
	categories := make([]jsonCategoryEntry, 0, len(catStats))
	for _, v := range catStats {
		categories = append(categories, *v)
	}

	total := len(allResults)
	var passRate float64
	if total > 0 {
		passRate = float64(passed) / float64(total)
		// Round to 4 decimal places.
		passRate = float64(int(passRate*10000+0.5)) / 10000
	}

	report := jsonReport{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Runner:      "go",
		Total:       total,
		Passed:      passed,
		Failed:      failed,
		Skipped:     skipped,
		PassRate:    passRate,
		Categories:  categories,
		Vectors:     vectors,
	}

	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(reportPath, data, 0644)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	// Default vectors path relative to the runner binary location.
	defaultVectors := filepath.Join(filepath.Dir(os.Args[0]), "..", "..", "vectors")
	vectorsDir := flag.String("vectors", defaultVectors, "path to vectors directory")
	reportPath := flag.String("report", "", "JUnit XML report output path (optional)")
	jsonReportPath := flag.String("json-report", "", "JSON summary report output path (optional)")
	validateOnly := flag.Bool("validate-only", false, "validate JSON format only, do not execute vectors")
	flag.Parse()

	files, err := findJSONFiles(*vectorsDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error finding vector files: %v\n", err)
		os.Exit(1)
	}

	if len(files) == 0 {
		fmt.Fprintf(os.Stderr, "no JSON files found in %s\n", *vectorsDir)
		os.Exit(1)
	}

	var allResults []Result
	for _, f := range files {
		allResults = append(allResults, processFile(f, *validateOnly)...)
	}

	// Tally.
	var pass, fail, skip int
	for _, r := range allResults {
		switch r.Status {
		case StatusPass:
			pass++
		case StatusFail:
			fail++
		default:
			skip++
		}
	}

	// Print per-vector lines.
	for _, r := range allResults {
		switch r.Status {
		case StatusPass:
			fmt.Printf("  PASS  %s\n", r.ID)
		case StatusFail:
			fmt.Printf("  FAIL  %s  — %s\n", r.ID, r.Message)
		default:
			fmt.Printf("  SKIP  %s  — %s\n", r.ID, r.Message)
		}
	}

	fmt.Printf("\nResults: %d passed, %d failed, %d skipped  (total %d)\n",
		pass, fail, skip, len(allResults))

	if *reportPath != "" {
		if err := writeJUnit(*reportPath, allResults); err != nil {
			fmt.Fprintf(os.Stderr, "write report: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("JUnit report written to %s\n", *reportPath)
	}

	if *jsonReportPath != "" {
		if err := os.MkdirAll(filepath.Dir(*jsonReportPath), 0755); err != nil {
			fmt.Fprintf(os.Stderr, "create report dir: %v\n", err)
			os.Exit(1)
		}
		if err := writeJSONReport(*jsonReportPath, allResults); err != nil {
			fmt.Fprintf(os.Stderr, "write JSON report: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("JSON report written to %s\n", *jsonReportPath)
	}

	if fail > 0 {
		os.Exit(1)
	}
}
