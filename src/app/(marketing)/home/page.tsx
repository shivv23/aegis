import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  ShieldCheck,
  Snowflake,
  Clock,
  Globe,
  Scale,
  KeyRound,
  Bot,
  Layers,
  LineChart,
  Send,
} from "lucide-react";

export const metadata: Metadata = {
  title: "AEGIS — The Kill Switch for Autonomous Agents",
  description:
    "Wallet-layer enforcement that lets agents work without letting them run away with your money. Spend limits, allowlists, geo/time windows, escrows, and an owner-controlled kill switch no agent can bypass.",
};

const pricing = [
  {
    name: "Founder",
    monthly: "$0",
    blurb: "Try the kill switch with a real policy guard.",
    features: ["3 wallets", "Policy guard + kill switch", "Hash-chain ledger", "Sepolia testnet mirror"],
    cta: "Start free",
    highlight: false,
  },
  {
    name: "Scale",
    monthly: "$99/mo",
    blurb: "For teams running a fleet of agents in production.",
    features: [
      "Unlimited wallets",
      "Counterparty registry + budget groups",
      "SAR-lite + regulator export pack",
      "Multi-sig key issuance",
      "Push alert webhooks",
    ],
    cta: "Talk to us",
    highlight: true,
  },
  {
    name: "Enterprise",
    monthly: "Custom",
    blurb: "On-chain mirror, SLA, dedicated enforcement lane.",
    features: ["Private rail settlement", "ERC-4337 account framing", "DPKI/DID identity (Q4)", "SSO + audit retention"],
    cta: "Contact sales",
    highlight: false,
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 border border-accent/40">
            <ShieldCheck className="h-5 w-5 text-accent" />
          </div>
          <span className="font-mono font-bold tracking-tight">AEGIS</span>
        </div>
        <nav className="hidden items-center gap-6 text-sm text-muted md:flex">
          <a href="#problem" className="hover:text-foreground">Problem</a>
          <a href="#product" className="hover:text-foreground">Product</a>
          <a href="#pricing" className="hover:text-foreground">Pricing</a>
          <a href="#proof" className="hover:text-foreground">Proof</a>
        </nav>
        <Link
          href="/"
          className="rounded-md border border-accent/40 bg-accent/10 px-4 py-1.5 font-mono text-sm text-accent hover:bg-accent/20"
        >
          Open console →
        </Link>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-6 pt-20 pb-16 text-center">
          <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/5 px-4 py-1.5 font-mono text-xs text-accent">
            <Clock className="h-3.5 w-3.5" /> 60-second timelock on every money movement
          </div>
          <h1 className="mx-auto max-w-3xl font-mono text-4xl font-bold leading-tight tracking-tight md:text-6xl">
            The kill switch your{" "}
            <span className="text-accent">autonomous agents</span> can&apos;t
            bypass.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted">
            AEGIS is a wallet-layer policy guard. Give an agent a key and it
            can spend — but every movement is checked against limits,
            allowlists, geo/time windows, counterparty risk, and an
            owner-controlled kill switch that no amount of prompt-injection
            can disarm.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-md bg-accent px-6 py-3 font-mono text-sm font-semibold text-background hover:bg-accent/90"
            >
              Launch the console <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/whitepaper"
              className="inline-flex items-center gap-2 rounded-md border border-border px-6 py-3 font-mono text-sm text-muted hover:text-foreground"
            >
              Read the whitepaper
            </Link>
          </div>
        </section>

        <section id="problem" className="border-y border-border bg-panel/40">
          <div className="mx-auto grid max-w-6xl gap-8 px-6 py-16 md:grid-cols-3">
            <div>
              <Bot className="h-6 w-6 text-danger" />
              <h3 className="mt-3 font-mono font-semibold">Prompt injection is not a bug</h3>
              <p className="mt-2 text-sm text-muted">
                A tool-using agent can be hijacked mid-task. If the wallet trusts
                the agent, the wallet is the attack surface.
              </p>
            </div>
            <div>
              <KeyRound className="h-6 w-6 text-danger" />
              <h3 className="mt-3 font-mono font-semibold">Keys can&apos;t be trusted</h3>
              <p className="mt-2 text-sm text-muted">
                Whoever holds the key controls the money. A leaked or exfiltrated
                agent key is an unlimited, unattended debit card.
              </p>
            </div>
            <div>
              <Snowflake className="h-6 w-6 text-danger" />
              <h3 className="mt-3 font-mono font-semibold">There is no kill switch today</h3>
              <p className="mt-2 text-sm text-muted">
                Once an agent is authorized, its spend is only limited by what the
                agent chooses to do. That is backwards.
              </p>
            </div>
          </div>
        </section>

        <section id="product" className="mx-auto max-w-6xl px-6 py-16">
          <div className="mb-12 text-center">
            <h2 className="font-mono text-3xl font-bold">Enforcement, not advice</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted">
              The guard runs in the wallet layer, independent of the agent.
              It can only answer one question: does this movement fit the policy?
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                icon: ShieldCheck,
                title: "Policy guard",
                body: "Per-tx, daily, monthly, and velocity limits with allowlists — plus spending windows and region allowlists for geo control.",
              },
              {
                icon: Snowflake,
                title: "Owner kill switch",
                body: "Freeze a wallet in one click. Every future movement is blocked instantly, even if the agent key is already out in the wild.",
              },
              {
                icon: Layers,
                title: "Multi-sig keys",
                body: "Agent keys are issued only after 2-of-3 signers approve, and rotate/revoke through a key lifecycle with expiry and ACLs.",
              },
              {
                icon: Scale,
                title: "Regulator-ready",
                body: "One-click audit pack (CSV/JSON) plus a SAR-lite monthly report flagging counterparty anomalies for compliance review.",
              },
              {
                icon: LineChart,
                title: "Usage + budgets",
                body: "Per-wallet usage metering and cross-wallet budget groups, so an org budget binds the whole fleet, not just one agent.",
              },
              {
                icon: Send,
                title: "Push alerts",
                body: "Every guard decision and wallet event streams to your ops webhook in real time, plus an in-app live feed.",
              },
            ].map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-lg border border-border bg-panel/40 p-5">
                <Icon className="h-5 w-5 text-accent" />
                <h3 className="mt-3 font-mono text-sm font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-muted">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="proof" className="border-y border-border bg-panel/40">
          <div className="mx-auto grid max-w-6xl gap-6 px-6 py-16 md:grid-cols-3">
            {[
              ["60s", "timelock on every transfer"],
              ["2-of-3", "multi-sig before a key is ever minted"],
              ["hash-chained", "tamper-evident ledger, verifiable live"],
            ].map(([v, l]) => (
              <div key={l} className="text-center">
                <div className="font-mono text-3xl font-bold text-accent">{v}</div>
                <div className="mt-1 text-sm text-muted">{l}</div>
              </div>
            ))}
          </div>
        </section>

        <section id="pricing" className="mx-auto max-w-6xl px-6 py-16">
          <div className="mb-10 text-center">
            <h2 className="font-mono text-3xl font-bold">Pricing</h2>
            <p className="mt-2 text-muted">Enforcement is table stakes for a funded agent.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {pricing.map((p) => (
              <div
                key={p.name}
                className={`flex flex-col rounded-lg border p-6 ${
                  p.highlight ? "border-accent/50 bg-accent/5" : "border-border bg-panel/40"
                }`}
              >
                <div className="font-mono text-sm font-semibold text-accent">{p.name}</div>
                <div className="mt-2 font-mono text-3xl font-bold">{p.monthly}</div>
                <p className="mt-2 text-sm text-muted">{p.blurb}</p>
                <ul className="mt-6 flex-1 space-y-2 text-sm">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-1 text-accent">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/"
                  className={`mt-6 rounded-md px-4 py-2 text-center font-mono text-sm ${
                    p.highlight
                      ? "bg-accent font-semibold text-background hover:bg-accent/90"
                      : "border border-border text-muted hover:text-foreground"
                  }`}
                >
                  {p.cta}
                </Link>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-6 text-xs text-muted">
          <span className="font-mono">AEGIS — wallet kill switch · INNOVA Hack Round 2</span>
          <div className="flex items-center gap-4">
            <Globe className="h-3.5 w-3.5" />
            <Link href="/docs" className="hover:text-foreground">API docs</Link>
            <Link href="/whitepaper" className="hover:text-foreground">Whitepaper</Link>
            <Link href="/" className="hover:text-foreground">Console</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
