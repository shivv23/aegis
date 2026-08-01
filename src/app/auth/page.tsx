"use client";

import { useState } from "react";
import { Button, Field } from "@/components/ui";
import { ShieldCheck } from "lucide-react";

export default function AuthPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const [devLink, setDevLink] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");

  async function request() {
    setStatus("idle");
    try {
      const res = await fetch("/api/auth/magic-link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "request failed");
      setStatus("sent");
      setDevLink(data.devLink ?? null);
      setMessage(
        data.sent
          ? `Sign-in link sent to ${data.email}.`
          : "No email provider configured — use the dev link below.",
      );
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "request failed");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-sm rounded-xl border border-border bg-panel/70 p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 border border-accent/40">
            <ShieldCheck className="h-5 w-5 text-accent" />
          </div>
          <div>
            <div className="font-mono font-bold tracking-tight text-foreground">AEGIS</div>
            <div className="text-[11px] text-muted leading-none">sign in</div>
          </div>
        </div>

        <p className="text-sm text-muted">
          Magic link sign-in for real orgs. The demo console continues to use
          owner keys via <code className="text-info">/api/bootstrap</code>.
        </p>

        <div className="space-y-3">
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="owner@acme.dev"
            required
          />
          <Button
            variant="primary"
            className="w-full"
            disabled={!email.trim() || status === "sent"}
            onClick={request}
          >
            Send sign-in link
          </Button>
        </div>

        {status === "sent" ? (
          <div className="rounded-lg border border-info/30 bg-info/10 p-3 font-mono text-xs text-info space-y-2">
            <p>{message}</p>
            {devLink ? (
              <a href={devLink} className="block break-all text-info underline">
                {devLink}
              </a>
            ) : null}
          </div>
        ) : null}

        {status === "error" ? (
          <p className="font-mono text-xs text-red-400">{message}</p>
        ) : null}
      </div>
    </div>
  );
}
