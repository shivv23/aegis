import { cn, money } from "@/lib/utils";
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from "react";
import type { RejectionReason, TxStatus, WalletStatus } from "@/core/types";

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-panel/70 p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "danger" | "warn" | "accent" | "info";
}) {
  const tones: Record<string, string> = {
    default: "text-foreground",
    danger: "text-danger",
    warn: "text-warn",
    accent: "text-accent",
    info: "text-info",
  };
  return (
    <Card className="flex flex-col gap-1">
      <div className="text-[11px] font-mono uppercase tracking-widest text-muted">
        {label}
      </div>
      <div className={cn("font-mono text-2xl font-bold tracking-tight", tones[tone])}>
        {value}
      </div>
      {sub ? <div className="text-xs text-muted">{sub}</div> : null}
    </Card>
  );
}

const statusTones: Record<TxStatus, string> = {
  SETTLED: "bg-accent/15 text-accent border-accent/40",
  PENDING: "bg-warn/15 text-warn border-warn/40",
  BLOCKED: "bg-danger/15 text-danger border-danger/40",
  REVOKED: "bg-info/15 text-info border-info/40",
};

const walletTones: Record<WalletStatus, string> = {
  ACTIVE: "bg-accent/15 text-accent border-accent/40",
  FROZEN: "bg-danger/15 text-danger border-danger/40",
};

const reasonTones: Record<string, string> = {
  LIMIT_EXCEEDED: "text-warn",
  NOT_ALLOWLISTED: "text-danger",
  VELOCITY_EXCEEDED: "text-danger",
  WALLET_FROZEN: "text-danger",
  INSUFFICIENT_FUNDS: "text-warn",
  IN_FLIGHT_REVOKED: "text-info",
  INVALID_SIGNATURE: "text-danger",
};

export function TxBadge({ status }: { status: TxStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-2 py-0.5 font-mono text-[11px] border",
        statusTones[status],
      )}
    >
      {status}
    </span>
  );
}

export function WalletBadge({ status }: { status: WalletStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[11px] border",
        walletTones[status],
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          status === "FROZEN" ? "bg-danger freeze-pulse" : "bg-accent",
        )}
      />
      {status}
    </span>
  );
}

export function Reason({ reason }: { reason?: RejectionReason }) {
  if (!reason) return null;
  return (
    <span className={cn("font-mono text-[11px]", reasonTones[reason])}>
      {reason}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "danger" | "outline" | "ghost" | "warn";
  size?: "sm" | "md";
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  const variants: Record<string, string> = {
    primary:
      "bg-accent text-[#050807] hover:bg-accent/90 border border-accent",
    danger:
      "bg-danger/15 text-danger hover:bg-danger/25 border border-danger/50",
    warn: "bg-warn/15 text-warn hover:bg-warn/25 border border-warn/50",
    outline:
      "bg-transparent text-foreground hover:bg-white/5 border border-border",
    ghost: "bg-transparent text-muted hover:text-foreground border border-transparent",
  };
  const sizes: Record<string, string> = {
    sm: "px-2.5 py-1 text-xs",
    md: "px-4 py-2 text-sm",
  };
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-mono font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Field({
  label,
  hint,
  ...props
}: InputProps & { label: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-mono uppercase tracking-widest text-muted">
        {label}
      </span>
      <input
        className="rounded-md border border-border bg-black/40 px-3 py-2 text-sm text-foreground outline-none focus:border-accent/60 font-mono"
        {...props}
      />
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function CodeBlock({ text }: { text: string }) {
  return (
    <code className="block overflow-x-auto rounded-md border border-border bg-black/50 px-3 py-2 text-xs text-info font-mono break-all">
      {text}
    </code>
  );
}

export function Money({ value }: { value: number }) {
  return <span className="font-mono">{money(value)}</span>;
}
