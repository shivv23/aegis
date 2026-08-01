import type { NextRequest } from "next/server";
import { authenticate, error } from "@/core/api";
import { getEvents, listAudit, listTransactions, listWallets, settleDue } from "@/core/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  if (!claims || claims.scope !== "owner") {
    return error("Missing or invalid credentials", 401);
  }

  await settleDue();
  const events = getEvents();

  const initial = {
    transactions: await listTransactions(),
    wallets: await listWallets(),
    audit: await listAudit(),
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`,
        ),
      );

      const onTx = (tx: unknown) => {
        controller.enqueue(encoder.encode(`event: tx\ndata: ${JSON.stringify(tx)}\n\n`));
      };
      const onWallet = (wallet: unknown) => {
        controller.enqueue(encoder.encode(`event: wallet\ndata: ${JSON.stringify(wallet)}\n\n`));
      };
      const onAudit = (entry: unknown) => {
        controller.enqueue(encoder.encode(`event: audit\ndata: ${JSON.stringify(entry)}\n\n`));
      };
      const onReset = async () => {
        await settleDue();
        const payload = {
          transactions: await listTransactions(),
          wallets: await listWallets(),
          audit: await listAudit(),
        };
        controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`));
      };

      events.on("tx", onTx);
      events.on("wallet", onWallet);
      events.on("audit", onAudit);
      events.on("reset", onReset);

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15000);

      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        events.off("tx", onTx);
        events.off("wallet", onWallet);
        events.off("audit", onAudit);
        events.off("reset", onReset);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
