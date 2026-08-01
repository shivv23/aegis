"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/home") {
    return <main className="min-h-screen">{children}</main>;
  }
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0 ml-60 p-6 lg:p-8">{children}</main>
    </div>
  );
}
