"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";

const ENV_KEY = "aegis-env";

type Env = "sandbox" | "live";

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [env, setEnv] = useState<Env>("sandbox");

  useEffect(() => {
    setEnv((localStorage.getItem(ENV_KEY) as Env) ?? "sandbox");
  }, []);

  if (pathname === "/home") {
    return <main className="min-h-screen">{children}</main>;
  }

  const isLive = env === "live";

  function toggleEnv() {
    const next: Env = isLive ? "sandbox" : "live";
    localStorage.setItem(ENV_KEY, next);
    setEnv(next);
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0 ml-60 p-6 lg:p-8">
        {isLive ? (
          <div className="mb-6 flex items-center justify-between rounded-md border border-danger/50 bg-danger/15 px-4 py-2 font-mono text-xs text-danger">
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
              LIVE MODE — every transfer runs the production rails. All money
              movement is still simulated; nothing touches a real bank.
            </span>
            <button onClick={toggleEnv} className="underline hover:text-foreground">
              switch to sandbox
            </button>
          </div>
        ) : (
          <div className="mb-6 flex items-center justify-between rounded-md border border-accent/40 bg-accent/10 px-4 py-2 font-mono text-xs text-accent">
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-accent" />
              SANDBOX — simulated rails. Transfers are exercises, not real money.
            </span>
            <button onClick={toggleEnv} className="underline hover:text-foreground">
              switch to live
            </button>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
