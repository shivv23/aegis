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
    </div>
  );
}
