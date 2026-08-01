"use client";

import { useEffect, useRef, useState } from "react";
import { ensureOwnerKey } from "@/lib/api-client";
import type { AuditLogEntry, Transaction, Wallet } from "@/core/types";

export interface StreamState {
  transactions: Transaction[];
  wallets: Wallet[];
  audit: AuditLogEntry[];
  connected: boolean;
}

const initialState: StreamState = {
  transactions: [],
  wallets: [],
  audit: [],
  connected: false,
};

export function useStream() {
  const [state, setState] = useState<StreamState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const stateRef = useRef(state);

  const bump = () => setRevision((r) => r + 1);

  useEffect(() => {
    let active = true;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let buffer = "";

    const decoder = new TextDecoder();

    function upsertTx(tx: Transaction) {
      stateRef.current = {
        ...stateRef.current,
        transactions: [
          tx,
          ...stateRef.current.transactions.filter((t) => t.id !== tx.id),
        ].slice(0, 200),
      };
      setState(stateRef.current);
      bump();
    }

    function upsertWallet(wallet: Wallet) {
      stateRef.current = {
        ...stateRef.current,
        wallets: [
          ...stateRef.current.wallets.filter((w) => w.id !== wallet.id),
          wallet,
        ],
      };
      setState(stateRef.current);
      bump();
    }

    function prependAudit(entry: AuditLogEntry) {
      stateRef.current = {
        ...stateRef.current,
        audit: [entry, ...stateRef.current.audit].slice(0, 300),
      };
      setState(stateRef.current);
      bump();
    }

    function handleEvent(event: string, data: string) {
      if (!active) return;
      if (event === "snapshot") {
        const s = JSON.parse(data) as {
          transactions: Transaction[];
          wallets: Wallet[];
          audit: AuditLogEntry[];
        };
        stateRef.current = {
          transactions: s.transactions ?? [],
          wallets: s.wallets ?? [],
          audit: s.audit ?? [],
          connected: true,
        };
        setState(stateRef.current);
        bump();
      } else if (event === "tx") {
        upsertTx(JSON.parse(data) as Transaction);
      } else if (event === "wallet") {
        upsertWallet(JSON.parse(data) as Wallet);
      } else if (event === "audit") {
        prependAudit(JSON.parse(data) as AuditLogEntry);
      }
    }

    async function connect() {
      try {
        const key = await ensureOwnerKey();
        const res = await fetch("/api/transactions/stream", {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!res.ok || !res.body) {
          throw new Error(`Stream failed: ${res.status}`);
        }
        reader = res.body.getReader();
        setError(null);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (!raw.trim() || raw.startsWith(":")) continue;
            let event = "message";
            const lines = raw.split("\n");
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            }
            handleEvent(event, dataLines.join("\n"));
          }
        }
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : "Stream disconnected");
          setState((s) => ({ ...s, connected: false }));
        }
      }
    }

    connect();

    const retry = setInterval(() => {
      if (active && !reader && !error) connect();
    }, 3000);

    return () => {
      active = false;
      clearInterval(retry);
      reader?.cancel().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  void revision;
  return { ...state, error };
}
