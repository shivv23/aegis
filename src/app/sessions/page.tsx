"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { clearOwnerKey, getOwnerKey } from "@/lib/api-client";
import { clock } from "@/lib/utils";
import { LogOut, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";

interface Session {
  id: string;
  email: string;
  createdAt: number;
  lastUsedAt: number;
  ip?: string;
  userAgent?: string;
  revokedAt?: number;
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/auth/session");
    const data = await res.json();
    if (!res.ok || !data.session) {
      setSessions([]);
      setError("No active session — sign in with a magic link first.");
      return;
    }
    setCurrent(data.session.id);
    const list = await fetch("/api/auth/sessions");
    const listData = await list.json();
    setSessions(listData.sessions ?? []);
    setError(null);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function revoke(id: string) {
    await fetch("/api/auth/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    refresh();
  }

  async function signOut() {
    await fetch("/api/auth/signout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: getOwnerKey() }),
    });
    clearOwnerKey();
    refresh();
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-xl font-bold tracking-tight">Sessions</h1>
        <p className="text-sm text-muted">
          Magic-link sessions for real orgs. Every session is revocable — kill
          a lost laptop without touching the keys.
        </p>
      </header>

      {error ? (
        <div className="rounded-xl border border-border bg-panel/70 px-4 py-8 text-center space-y-3">
          <p className="font-mono text-sm text-muted">{error}</p>
          <Link href="/auth">
            <Button variant="primary" size="sm">Sign in</Button>
          </Link>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={signOut}>
              <LogOut className="h-3.5 w-3.5" /> Sign out this session
            </Button>
          </div>
          <div className="rounded-xl border border-border bg-panel/70 overflow-hidden">
            <div className="grid grid-cols-12 gap-2 px-4 py-2.5 border-b border-border font-mono text-[10px] uppercase tracking-widest text-muted">
              <span className="col-span-3">Last used</span>
              <span className="col-span-2">Email</span>
              <span className="col-span-3">IP</span>
              <span className="col-span-2">Created</span>
              <span className="col-span-2 text-right">Action</span>
            </div>
            {(sessions ?? []).length === 0 ? (
              <div className="px-4 py-10 text-center font-mono text-sm text-muted">
                no sessions
              </div>
            ) : (
              sessions!.map((s) => (
                <div
                  key={s.id}
                  className="grid grid-cols-12 gap-2 items-center px-4 py-2.5 border-b border-border/60 last:border-0 font-mono text-xs"
                >
                  <span className="col-span-3 text-muted">
                    {clock(s.lastUsedAt)}
                    {s.id === current ? (
                      <span className="ml-2 text-emerald-400">● current</span>
                    ) : s.revokedAt ? (
                      <span className="ml-2 text-red-400">revoked</span>
                    ) : null}
                  </span>
                  <span className="col-span-2 truncate">{s.email}</span>
                  <span className="col-span-3 text-muted truncate">{s.ip ?? "—"}</span>
                  <span className="col-span-2 text-muted">{clock(s.createdAt)}</span>
                  <span className="col-span-2 text-right">
                    {!s.revokedAt && s.id !== current ? (
                      <Button variant="danger" size="sm" onClick={() => revoke(s.id)}>
                        <Trash2 className="h-3 w-3" /> Revoke
                      </Button>
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 ml-auto" />
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
