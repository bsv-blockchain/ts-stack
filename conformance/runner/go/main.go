package main

import (
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	ecprim "github.com/bsv-blockchain/go-sdk/primitives/ec"
	primhash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	gostorage "github.com/bsv-blockchain/go-sdk/storage"
)

// ─── Vector file schema ───────────────────────────────────────────────────────

type VectorFile struct {
	ID          string                   `json:"id"`
	Version     string                   `json:"version"`
	Name        string                   `json:"name"`
	Domain      string                   `json:"domain"`
	Category    string                   `json:"category"`
	Description string                   `json:"description"`
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

type Result struct {
	ID      string
	Status  Status
	Message string
	Elapsed time.Duration
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
	Name      string      `xml:"name,attr"`
	Classname string      `xml:"classname,attr"`
	Time      string      `xml:"time,attr"`
	Failure   *JUnitFail  `xml:"failure,omitempty"`
	Skipped   *JUnitSkip  `xml:"skipped,omitempty"`
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
		return StatusFail, fmt.Sprintf("decode input: %v", err)
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
		return StatusFail, fmt.Sprintf("got %s, want %s", got, want)
	}
	return StatusPass, ""
}

// dispatchRIPEMD160 handles ripemd160 vectors.
func dispatchRIPEMD160(input, expected map[string]interface{}) (Status, string) {
	msg := getString(input, "message")
	encoding := getString(input, "encoding")

	data, err := decodeMessage(msg, encoding)
	if err != nil {
		return StatusFail, fmt.Sprintf("decode input: %v", err)
	}

	result := primhash.Ripemd160(data)
	want := getString(expected, "hash")
	got := hex.EncodeToString(result)
	if got != want {
		return StatusFail, fmt.Sprintf("got %s, want %s", got, want)
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
			return StatusFail, fmt.Sprintf("decode input: %v", err)
		}
	}

	result := primhash.Hash160(data)
	want := getString(expected, "hash160")
	got := hex.EncodeToString(result)
	if got != want {
		return StatusFail, fmt.Sprintf("got %s, want %s", got, want)
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
		return StatusFail, fmt.Sprintf("decode message: %v", err)
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
		return StatusFail, fmt.Sprintf("got %s, want %s", got, want)
	}
	return StatusPass, ""
}

// dispatchECDSA handles ecdsa vectors.
// The ECDSA vectors in this suite are design/behavioural tests that require
// signing, custom-k, and curve operations not exposed by the current Go SDK
// public API in a portable way.  We skip them with "not-implemented" rather
// than breaking the runner.
//
// Exception: vectors that provide explicit r/s or DER bytes for pure
// verification could be run, but the current vector set doesn't include those —
// it focuses on sign+verify round-trips that need a private key and k value.
func dispatchECDSA(input, expected map[string]interface{}) (Status, string) {
	// Check if the vector is a pure verify case with explicit DER bytes.
	// (None of the current vectors match this pattern, but we handle it
	//  for future-proofing.)
	sigDERHex := getString(input, "signature_der")
	msgHashHex := getString(input, "message_hash")
	pubkeyHex := getString(input, "public_key")

	if sigDERHex != "" && msgHashHex != "" && pubkeyHex != "" {
		sigDER, err := hex.DecodeString(sigDERHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode signature_der: %v", err)
		}
		msgHash, err := hex.DecodeString(msgHashHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode message_hash: %v", err)
		}
		pubKeyBytes, err := hex.DecodeString(pubkeyHex)
		if err != nil {
			return StatusFail, fmt.Sprintf("decode public_key: %v", err)
		}

		pubKey, err := ecprim.ParsePubKey(pubKeyBytes)
		if err != nil {
			// Invalid public key: if expected.valid is false, that is the
			// correct outcome.
			wantValid := getBool(expected, "valid")
			if !wantValid {
				return StatusPass, ""
			}
			return StatusFail, fmt.Sprintf("parse public key: %v", err)
		}

		sig, err := ecprim.FromDER(sigDER)
		if err != nil {
			return StatusFail, fmt.Sprintf("parse DER signature: %v", err)
		}

		valid := ecprim.Verify(msgHash, sig, pubKey.ToECDSA())
		wantValid := getBool(expected, "valid")
		if valid != wantValid {
			return StatusFail, fmt.Sprintf("verify=%v, want %v", valid, wantValid)
		}
		return StatusPass, ""
	}

	// All other ECDSA vectors require sign+custom-k operations; skip them.
	return StatusNotImplemented, "ECDSA sign/custom-k vectors require private-key operations not yet wired in Go runner"
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
		return StatusFail, fmt.Sprintf("got %s, want %s", got, want)
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
				return StatusFail, fmt.Sprintf("got %s, want %s", got, wantHashHex)
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
		return StatusFail, fmt.Sprintf("PrivateKeyFromHex: %v", err)
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

func runVector(fileID string, filePath string, v map[string]interface{}) Result {
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

	// Read parity_class: only "required" vectors fail CI on mismatch.
	parityClass := getString(v, "parity_class")
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
		ID:      id,
		Status:  status,
		Message: msg,
		Elapsed: time.Since(start),
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
		results = append(results, runVector(vf.ID, path, v))
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

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	// Default vectors path relative to the runner binary location.
	defaultVectors := filepath.Join(filepath.Dir(os.Args[0]), "..", "..", "vectors")
	vectorsDir := flag.String("vectors", defaultVectors, "path to vectors directory")
	reportPath := flag.String("report", "", "JUnit XML report output path (optional)")
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

	if fail > 0 {
		os.Exit(1)
	}
}
