// AEGIS — runnable Go sample (stdlib only).
//
// Walks the read-only owner surface: fetch the demo master key from
// GET /api/bootstrap, list wallets, and prove the hash chain is intact via
// GET /api/ledger/verify. Signed transfers are done with the SDK
// (examples/node/agent.ts) — this file shows the owner control plane.
//
// Run:  AEGIS_BASE_URL=http://localhost:3000 AEGIS_OWNER_KEY=<key> go run .
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func call(path, token string) {
	req, err := http.NewRequest(
		http.MethodGet,
		strings.TrimRight(env("AEGIS_BASE_URL", "http://localhost:3000"), "/")+path,
		nil,
	)
	if err != nil {
		fmt.Fprintln(os.Stderr, "request error:", err)
		return
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "request failed:", err)
		return
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	var out any
	if json.Unmarshal(body, &out) == nil {
		body, _ = json.MarshalIndent(out, "", "  ")
	}
	fmt.Printf("%s -> HTTP %d\n%s\n\n", path, res.StatusCode, string(body))
}

func main() {
	key := os.Getenv("AEGIS_OWNER_KEY")
	call("/api/bootstrap", key)
	if key == "" {
		fmt.Println("(set AEGIS_OWNER_KEY from the bootstrap output to list wallets and verify the ledger)")
		return
	}
	call("/api/wallet", key)
	call("/api/ledger/verify", key)
}
