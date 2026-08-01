"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Wallet,
  ArrowLeftRight,
  ScrollText,
  Bot,
  ShieldCheck,
  FlaskConical,
  Users,
  BookOpen,
  FileText,
} from "lucide-react";

const links = [
  { href: "/", label: "Command Center", icon: LayoutDashboard },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/audit", label: "Audit Trail", icon: ScrollText },
  { href: "/simulator", label: "Agent Simulator", icon: Bot },
  { href: "/sandbox", label: "Policy Sandbox", icon: FlaskConical },
  { href: "/multisig", label: "Multi-sig", icon: Users },
  { href: "/docs", label: "API Docs", icon: BookOpen },
  { href: "/whitepaper", label: "Whitepaper", icon: FileText },
];

export function Sidebar() {
  const pathname = usePathname();
  const walletMatch = pathname.startsWith("/wallet");

  return (
    <aside className="fixed inset-y-0 left-0 w-60 border-r border-border bg-panel/80 backdrop-blur flex flex-col">
      <div className="px-5 py-6 border-b border-border">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 border border-accent/40">
            <ShieldCheck className="h-5 w-5 text-accent" />
          </div>
          <div>
            <div className="font-mono font-bold tracking-tight text-foreground">
              AEGIS
            </div>
            <div className="text-[11px] text-muted leading-none">
              wallet kill switch
            </div>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {links.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-accent/10 text-accent border border-accent/30"
                  : "text-muted hover:text-foreground hover:bg-white/5 border border-transparent",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}

        <div className="pt-4">
          <div className="px-3 pb-2 text-[10px] font-mono uppercase tracking-widest text-muted">
            Wallets
          </div>
          <Link
            href="/wallet"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              walletMatch
                ? "bg-accent/10 text-accent border border-accent/30"
                : "text-muted hover:text-foreground hover:bg-white/5 border border-transparent",
            )}
          >
            <Wallet className="h-4 w-4" />
            Wallet Registry
          </Link>
        </div>
      </nav>

      <div className="px-5 py-4 border-t border-border">
        <div className="font-mono text-[10px] text-muted leading-relaxed">
          <span className="text-accent">ENFORCEMENT LAYER</span>
          <br />
          wallet/contract level — independent of agent logic
        </div>
      </div>
    </aside>
  );
}
