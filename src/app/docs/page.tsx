"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { BookOpen, Terminal } from "lucide-react";

interface Endpoint {
  method: string;
  summary: string;
  description?: string;
}

export default function DocsPage() {
  const [groups, setGroups] = useState<Record<string, Endpoint[]>>({});

  useEffect(() => {
    fetch("/api/openapi")
      .then((r) => r.json())
      .then((spec) => {
        const g: Record<string, Endpoint[]> = {};
        for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
          for (const [method, op] of Object.entries(ops)) {
            if (method === "parameters") continue;
            const key = path.startsWith("/api/rail")
              ? "Agent rail (the only thing an agent can do)"
              : path.startsWith("/api/wallet") || path.startsWith("/api/transactions") || path.startsWith("/api/keys")
                ? "Owner control plane"
                : path.startsWith("/api/signers") || path.startsWith("/api/approvals")
                  ? "Multi-sig"
                  : path.startsWith("/api/bootstrap") || path.startsWith("/api/admin")
                    ? "Demo"
                    : "Systems & ledger";
            g[key] ??= [];
            g[key].push({ method: method.toUpperCase(), summary: (op as Endpoint).summary ?? "", description: (op as Endpoint).description });
          }
        }
        setGroups(g);
      })
      .catch(() => setGroups({}));
  }, []);

  const [masterKey, setMasterKey] = useState("");
  useEffect(() => {
    fetch("/api/bootstrap")
      .then((r) => r.json())
      .then((b) => setMasterKey((b as { ownerKey?: string }).ownerKey ?? ""))
      .catch(() => {});
  }, []);

  const playground = [
    { label: "Bootstrap (master key)", method: "GET", path: "/api/bootstrap", body: "" },
    { label: "Rail health", method: "GET", path: "/api/rail/health", body: "" },
    { label: "List wallets", method: "GET", path: "/api/wallet", body: "" },
    { label: "Ledger verify", method: "GET", path: "/api/ledger/verify", body: "" },
    { label: "List counterparties", method: "GET", path: "/api/counterparties", body: "" },
    { label: "Reset demo data", method: "POST", path: "/api/admin/reset", body: "{}" },
  ] as const;

  const [playIdx, setPlayIdx] = useState(0);
  const [playBody, setPlayBody] = useState("");
  const [playResp, setPlayResp] = useState("");
  const [playBusy, setPlayBusy] = useState(false);

  async function sendPlay() {
    const ep = playground[playIdx];
    setPlayBusy(true);
    try {
      const res = await fetch(ep.path, {
        method: ep.method,
        headers: {
          "Content-Type": "application/json",
          ...(masterKey ? { Authorization: `Bearer ${masterKey}` } : {}),
        },
        body: ep.method === "POST" ? playBody || "{}" : undefined,
      });
      const text = await res.text();
      setPlayResp(`${res.status} ${res.statusText}\n${text}`);
    } catch (e) {
      setPlayResp(`error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPlayBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-10">
      <div>
        <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-zinc-400">
          <BookOpen size={14} /> API Reference
        </p>
        <h1 className="font-mono text-2xl font-bold text-zinc-100">AEGIS API</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Every endpoint requires <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-emerald-300">Authorization: Bearer &lt;key&gt;</code>.
          Agents authenticate transfers with an Ed25519 signature instead — see{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-emerald-300">POST /api/rail/transfer</code>.
        </p>
      </div>

      {Object.entries(groups).map(([group, endpoints]) => (
        <section key={group}>
          <h2 className="mb-3 font-mono text-sm font-semibold text-zinc-200">{group}</h2>
          <Card className="divide-y divide-zinc-800 overflow-hidden p-0">
            {endpoints.map((e, i) => (
              <div key={i} className="flex items-start gap-4 px-5 py-3">
                <span
                  className={`mt-0.5 w-16 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[11px] font-bold ${
                    e.method === "GET"
                      ? "bg-sky-500/15 text-sky-300"
                      : e.method === "POST"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : e.method === "PATCH"
                          ? "bg-amber-500/15 text-amber-300"
                          : "bg-rose-500/15 text-rose-300"
                  }`}
                >
                  {e.method}
                </span>
                <div className="min-w-0">
                  <code className="font-mono text-sm text-zinc-100">{e.summary}</code>
                  {e.description && <p className="mt-1 text-xs text-zinc-500">{e.description}</p>}
                </div>
              </div>
            ))}
          </Card>
        </section>
      ))}

      <Card className="flex items-start gap-3 p-4">
        <Terminal size={16} className="mt-0.5 shrink-0 text-emerald-400" />
        <p className="text-xs text-zinc-400">
          Machine-readable spec:{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-emerald-300">GET /api/openapi</code> (OpenAPI 3.0).
          The SDK in <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-emerald-300">src/lib/sdk.ts</code> is generated from this contract.
        </p>
      </Card>

      <section>
        <h2 className="mb-3 font-mono text-sm font-semibold text-zinc-200">API Playground</h2>
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={playIdx}
              onChange={(e) => {
                const i = Number(e.target.value);
                setPlayIdx(i);
                setPlayBody(playground[i].body);
              }}
              className="rounded-md border border-zinc-800 bg-black/40 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-emerald-500/60"
            >
              {playground.map((ep, i) => (
                <option key={ep.path} value={i}>
                  {ep.method} {ep.path} — {ep.label}
                </option>
              ))}
            </select>
            {masterKey && (
              <span className="font-mono text-[11px] text-emerald-300">master key loaded (Bearer auth)</span>
            )}
          </div>
          {playground[playIdx].method === "POST" && (
            <textarea
              value={playBody}
              onChange={(e) => setPlayBody(e.target.value)}
              rows={4}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-zinc-800 bg-black/40 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-emerald-500/60"
            />
          )}
          <button
            onClick={sendPlay}
            disabled={playBusy}
            className="inline-flex items-center gap-2 rounded-md border border-emerald-500 bg-emerald-500/15 px-4 py-2 font-mono text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:opacity-40"
          >
            {playBusy ? "Sending…" : "Send"}
          </button>
          {playResp && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-black/50 px-3 py-2 font-mono text-xs text-emerald-200">
              {playResp}
            </pre>
          )}
        </Card>
      </section>

      <section>
        <h2 className="mb-3 font-mono text-sm font-semibold text-zinc-200">Sample apps</h2>
        <Card className="divide-y divide-zinc-800 overflow-hidden p-0">
          {[
            [
              "examples/node/agent.ts",
              "Node/TS agent — provisions a wallet, mints an Ed25519 key, signs transfers and shows the guard blocking an over-cap spend.",
            ],
            [
              "examples/python/agent.py",
              "Python (stdlib only) — owner-key wallet provisioning, counterparty list, and a bearer transfer via /api/rail/transfer.",
            ],
            [
              "examples/curl/",
              "Shell — bootstrap the master key, run read-only GETs, and see the signed-transfer envelope to POST.",
            ],
            [
              "examples/go/main.go",
              "Go (stdlib only) — bootstrap, list wallets, and prove ledger integrity with the owner key.",
            ],
          ].map(([path, desc]) => (
            <div key={path} className="flex items-start gap-4 px-5 py-3">
              <code className="mt-0.5 w-48 shrink-0 font-mono text-xs text-emerald-300">{path}</code>
              <p className="text-xs text-zinc-500">{desc}</p>
            </div>
          ))}
        </Card>
      </section>

      <section>
        <h2 className="mb-3 font-mono text-sm font-semibold text-zinc-200">CLI</h2>
        <Card className="flex items-start gap-3 p-4">
          <Terminal size={16} className="mt-0.5 shrink-0 text-emerald-400" />
          <div className="min-w-0 space-y-2">
            <p className="text-xs text-zinc-400">
              The{" "}
              <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-emerald-300">aegis</code> CLI is a thin
              scaffold over the SDK:
            </p>
            <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-black/50 px-3 py-2 font-mono text-xs text-emerald-200">
{`npx tsx scripts/aegis.ts bootstrap                       # master key + wallets
npx tsx scripts/aegis.ts status                          # rail health + ledger verify
npx tsx scripts/aegis.ts transfer \\
  --wallet <wallet-id> --to <allowlisted-counterparty> \\
  --amount 30 --purpose "GPU burst"                      # signed transfer + verdict
npx tsx scripts/aegis.ts help`}
            </pre>
          </div>
        </Card>
      </section>
    </div>
  );
}
