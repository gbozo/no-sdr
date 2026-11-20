// Durable Object: one object per `${instance}:${dongle}`.
//
// Responsibilities:
//   - accept exactly one authenticated ingest socket from serverrs
//   - fan out live FFT frames to viewer sockets
//   - decode range/deflate-smooth frames into a small history ring
//   - serve that ring as one 0x0D codec-4 (per-frame range) message
//
// It deliberately knows nothing about control, audio, IQ, or sessions. Those
// stay on the origin WebSocket.

import { DurableObject } from "cloudflare:workers";
import {
  clampBins,
  clampFrames,
  clampHistoryMode,
  clampInt,
  DEFAULT_HISTORY,
  DEFAULT_MAX_VIEWERS,
  type HistoryMode,
} from "./config";
import { decodeDeflateSmooth, decimateMaxHold, PayloadRing } from "./history";
import { decodeRangeFrame, encodeRangeFrame } from "./range";
import {
  MAX_INGEST_BYTES,
  MSG_FFT_DEFLATE,
  MSG_FFT_HISTORY,
  MSG_FFT_RANGE,
  packRangeFrameHistory,
  parseFftDeflate,
  parseFftRange,
} from "./protocol";

interface FanoutEnv {
  MAX_VIEWERS?: string;
  EDGE_VERSION?: string;
}

type Role = "ingest" | "viewer";

interface Attachment {
  role: Role;
}

export class Fanout extends DurableObject<FanoutEnv> {
  private ring = new PayloadRing(DEFAULT_HISTORY.frames);
  private historyBins = DEFAULT_HISTORY.bins;
  private historyMode: HistoryMode = DEFAULT_HISTORY.mode;
  private lastSnapshot: ArrayBuffer | null = null;

  private maxViewers = DEFAULT_MAX_VIEWERS;
  private lastFrameAt = 0;
  private minDb = -130;
  private maxDb = 0;

  private framesIn = 0;
  private framesOut = 0;
  private dropped = 0;
  private historyDecodeMs = 0;
  private historyDecodeFrames = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal stats endpoint, reached only through the Worker's authenticated
    // /stats route. It is never exposed directly to browsers.
    if (url.pathname === "/stats") {
      return json(this.stats());
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const role: Role =
      request.headers.get("x-nosdr-role") === "ingest" ? "ingest" : "viewer";

    if (role === "viewer" && this.viewers().length >= this.maxViewers) {
      return json({ error: "viewer limit reached", maxViewers: this.maxViewers }, 503);
    }

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];

    // Hibernation API: the runtime owns the socket; use tags instead of an
    // in-memory Map so broadcast survives hibernation.
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role } satisfies Attachment);

    if (role === "ingest") {
      // One publisher per dongle. A reconnect replaces a stale socket rather
      // than fanning out duplicate frames.
      for (const old of this.ctx.getWebSockets("ingest")) {
        if (old !== server) {
          try {
            old.close(1012, "replaced by new ingest");
          } catch {
            // already closed
          }
        }
      }
      this.lastFrameAt = 0;
      this.applyEnvLimits();
    } else {
      this.sendHistory(server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    const role: Role = attachment?.role ?? this.roleOf(ws);

    if (typeof message === "string") {
      if (role === "ingest") this.handleIngestText(ws, message);
      else this.handleViewerText(ws, message);
      return;
    }

    // Viewers are receive-only. Ignore anything they send us.
    if (role !== "ingest") return;

    if (message.byteLength === 0 || message.byteLength > MAX_INGEST_BYTES) {
      return;
    }

    const type = new Uint8Array(message, 0, 1)[0];

    switch (type) {
      case MSG_FFT_DEFLATE:
        this.framesIn++;
        this.lastFrameAt = Date.now();
        this.ingestLive(message);
        break;

      case MSG_FFT_HISTORY:
        // Optional origin-snapshot fallback. Keep the latest burst and serve
        // it to new viewers; never broadcast it to the live stream.
        this.lastSnapshot = message.slice(0);
        break;

      case MSG_FFT_RANGE:
        // 0x10 is FFT_RANGE: decode it for the history ring and forward the
        // original compressed frame to viewers.
        this.framesIn++;
        this.lastFrameAt = Date.now();
        this.ingestRange(message);
        break;

      default:
        // Forward-compatible: unknown FFT-ish frames still reach viewers.
        this.broadcast(message);
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    const role: Role = attachment?.role ?? this.roleOf(ws);
    if (role === "ingest") {
      this.lastFrameAt = 0;
    }

    // Required for hibernatable WebSockets: complete the close handshake.
    try {
      if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) {
        ws.close(code, reason);
      } else {
        ws.close();
      }
    } catch {
      // already closed
    }
  }

  // ------------------------------------------------------------------
  // Ingest
  // ------------------------------------------------------------------

  private handleIngestText(ws: WebSocket, text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.cmd === "hello") {
      this.applyEnvLimits();

      const requested = clampInt(msg.maxViewers, 1, 1000, this.maxViewers);
      const envCap = clampInt(
        this.env.MAX_VIEWERS,
        1,
        1000,
        DEFAULT_MAX_VIEWERS,
      );
      this.maxViewers = Math.min(envCap, requested);

      const history = (msg.history ?? {}) as Record<string, unknown>;
      const mode = clampHistoryMode(history.mode);
      const bins = clampBins(history.bins);
      const frames = clampFrames(history.frames);

      this.historyMode = mode;
      if (mode === "do-ring" && (bins !== this.historyBins || frames !== this.ring.capacity)) {
        this.historyBins = bins;
        this.ring = new PayloadRing(frames);
      }
      if (mode !== "do-ring") this.ring.clear();
      if (mode !== "origin-snapshot") this.lastSnapshot = null;

      ws.send(
        JSON.stringify({
          cmd: "welcome",
          version: this.env.EDGE_VERSION ?? "dev",
          viewers: this.viewers().length,
          maxViewers: this.maxViewers,
          history: {
            mode: this.historyMode,
            bins: this.historyBins,
            frames: this.ring.capacity,
          },
        }),
      );
      return;
    }

    if (msg.cmd === "ping") {
      ws.send(JSON.stringify({ cmd: "pong", ts: Date.now() }));
      return;
    }

    if (msg.cmd === "status") {
      ws.send(JSON.stringify({ cmd: "status", ...this.stats() }));
    }
  }

  private ingestLive(frame: ArrayBuffer): void {
    if (this.historyMode === "do-ring") {
      const started = performance.now();
      try {
        const parsed = parseFftDeflate(frame);
        const bins = decodeDeflateSmooth(parsed.deflate, parsed.bins);
        const low = decimateMaxHold(bins, this.historyBins);
        this.minDb = parsed.minDb;
        this.maxDb = parsed.maxDb;
        this.ring.push(encodeRangeFrame(low));
        this.historyDecodeMs += performance.now() - started;
        this.historyDecodeFrames++;
      } catch (err) {
        // A malformed frame must never stop the live fan-out.
        console.warn("history decode failed", err);
      }
    }

    this.broadcast(frame);
  }

  private ingestRange(frame: ArrayBuffer): void {
    if (this.historyMode === "do-ring") {
      const started = performance.now();
      try {
        const parsed = parseFftRange(frame);
        const codes = decodeRangeFrame(parsed.payload, parsed.bins);
        const low = decimateMaxHold(codes, this.historyBins);
        this.minDb = parsed.minDb;
        this.maxDb = parsed.maxDb;
        this.ring.push(encodeRangeFrame(low));
        this.historyDecodeMs += performance.now() - started;
        this.historyDecodeFrames++;
      } catch (err) {
        console.warn("range history decode failed", err);
      }
    }

    this.broadcast(frame);
  }

  // ------------------------------------------------------------------
  // Viewers
  // ------------------------------------------------------------------

  private sendHistory(ws: WebSocket): void {
    try {
      if (this.historyMode === "origin-snapshot") {
        if (this.lastSnapshot) ws.send(this.lastSnapshot);
        return;
      }

      if (this.historyMode !== "do-ring") return;
      const frames = this.ring.snapshot();
      if (frames.length === 0) return;

      ws.send(packRangeFrameHistory(frames, this.historyBins, this.minDb, this.maxDb));
    } catch (err) {
      console.warn("history send failed", err);
    }
  }

  private broadcast(message: string | ArrayBuffer): void {
    for (const viewer of this.viewers()) {
      try {
        viewer.send(message);
        this.framesOut++;
      } catch {
        this.dropped++;
        try {
          viewer.close(1011, "send failed");
        } catch {
          // already closed
        }
      }
    }
  }

  private handleViewerText(ws: WebSocket, text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.cmd === "ping") {
      ws.send(JSON.stringify({ cmd: "pong", ts: Date.now() }));
    } else if (msg.cmd === "status") {
      ws.send(JSON.stringify({ cmd: "status", ...this.stats() }));
    }
  }

  private viewers(): WebSocket[] {
    return this.ctx.getWebSockets("viewer");
  }

  private roleOf(ws: WebSocket): Role {
    return this.ctx.getWebSockets("ingest").includes(ws) ? "ingest" : "viewer";
  }

  private applyEnvLimits(): void {
    const envCap = clampInt(
      this.env.MAX_VIEWERS,
      1,
      1000,
      DEFAULT_MAX_VIEWERS,
    );
    if (this.maxViewers > envCap) this.maxViewers = envCap;
  }

  private stats(): Record<string, unknown> {
    return {
      viewers: this.viewers().length,
      maxViewers: this.maxViewers,
      ringFrames: this.ring.size,
      ringBins: this.historyBins,
      historyMode: this.historyMode,
      lastFrameAgeMs: this.lastFrameAt === 0 ? null : Date.now() - this.lastFrameAt,
      framesIn: this.framesIn,
      framesOut: this.framesOut,
      dropped: this.dropped,
      historyDecodeAvgMs:
        this.historyDecodeFrames === 0
          ? null
          : this.historyDecodeMs / this.historyDecodeFrames,
      historyDecodeFrames: this.historyDecodeFrames,
    };
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
