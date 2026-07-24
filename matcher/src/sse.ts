/**
 * SSE (Server-Sent Events) delivery channel.
 * Clients open a long-lived HTTP connection and receive matched events.
 *
 * Security: clients can optionally filter by ?sub=ID query param.
 * The SSE endpoint should NOT be exposed publicly without additional auth.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseUrl } from "node:url";

interface SSEClient {
  id: string;
  res: ServerResponse;
  subFilter: string | null; // if set, only receive events matching this subId
}

const clients = new Map<string, SSEClient>();
let clientSeq = 0;

/** Register a new SSE client. Optionally filter by ?sub=ID query param. */
export function addSSEClient(req: IncomingMessage, res: ServerResponse): void {
  const id = `sse_${++clientSeq}`;

  // Parse optional ?sub= filter from query string
  let subFilter: string | null = null;
  try {
    const parsed = parseUrl(req.url || "/");
    const params = new URLSearchParams(parsed.query || "");
    subFilter = params.get("sub") || null;
  } catch { /* no filter */ }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });

  res.write(`event: connected\ndata: {"clientId":"${id}","subFilter":${subFilter ? `"${subFilter}"` : "null"}}\n\n`);

  const client: SSEClient = { id, res, subFilter };
  clients.set(id, client);

  req.on("close", () => {
    clients.delete(id);
  });
}

/** Broadcast a matched event. Only sends to clients whose subFilter matches (if set). */
export function broadcastSSE(subId: string, event: Record<string, unknown>): void {
  if (clients.size === 0) return;

  const data = JSON.stringify({ subId, ...event });
  const message = `event: delivery\ndata: ${data}\n\n`;

  for (const [id, client] of clients) {
    // Filter: if client set a sub filter, only send matching events
    if (client.subFilter && client.subFilter !== subId) continue;
    try {
      client.res.write(message);
    } catch {
      clients.delete(id);
    }
  }
}

/** Number of connected SSE clients. */
export function sseClientCount(): number {
  return clients.size;
}

/** Simple SSE endpoint handler for Express/http. */
export function sseHandler(req: IncomingMessage, res: ServerResponse): void {
  addSSEClient(req, res);
}
