// ============================================================
// node-sdr — secondary raw-IQ WebSocket probe
// ============================================================
// The identifier uses this instead of switching the main client to raw mode.
// It opens a second WebSocket, subscribes to the same dongle/profile, asks for
// raw 300 kHz IQ with audio enabled (the server only streams IQ to clients
// with audio enabled), captures for the requested duration, then disconnects.

const MSG_IQ = 0x02;
const MSG_META = 0x03;
const MSG_IQ_ADPCM = 0x09;

export class RawIqProbe {
  private ws: WebSocket | null = null;
  private chunks: Int16Array[] = [];
  private resolver: ((chunks: Int16Array[]) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private subscribed = false;

  constructor(
    private readonly dongleId: string,
    private readonly profileId: string,
    private readonly sampleRate = 300_000,
  ) {}

  capture(durationMs: number): Promise<Int16Array[]> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const fail = () => {
        if (this.closed) return;
        this.finish();
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ cmd: 'subscribe', dongleId: this.dongleId, profileId: this.profileId }));
      };
      ws.onerror = fail;
      ws.onclose = fail;
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') return;
        const buf = event.data as ArrayBuffer;
        if (buf.byteLength < 2) return;
        const view = new DataView(buf);
        const type = view.getUint8(0);
        if (type === MSG_META) {
          try {
            const text = new TextDecoder().decode(new Uint8Array(buf, 1));
            const meta = JSON.parse(text) as { type?: string };
            if (meta.type === 'subscribed' && !this.subscribed) {
              this.subscribed = true;
              ws.send(JSON.stringify({ cmd: 'mode', mode: 'raw', bandwidth: this.sampleRate }));
              ws.send(JSON.stringify({ cmd: 'bandwidth', hz: this.sampleRate }));
              ws.send(JSON.stringify({ cmd: 'codec', iqCodec: 'none' }));
              ws.send(JSON.stringify({ cmd: 'audio_enabled', enabled: true }));
              if (this.timer) clearTimeout(this.timer);
              this.timer = setTimeout(() => this.finish(), durationMs);
            }
          } catch { /* ignore malformed meta */ }
          return;
        }
        if (type === MSG_IQ && buf.byteLength > 6) {
          try {
            // Header: u32 sampleRate, u8 channels, u8 reserved, then Int16 I/Q.
            const data = new Int16Array(buf, 6);
            if (data.length > 0) this.chunks.push(data.slice());
          } catch { /* ignore malformed IQ frame */ }
          return;
        }
        if (type === MSG_IQ_ADPCM) {
          // We requested codec none; this should not happen. Ignore it.
        }
      };

      // Do not let a blocked/refused connection stall the identifier forever.
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.finish(), durationMs + 2500);
    });
  }

  close(): void {
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    const resolve = this.resolver;
    this.resolver = null;
    resolve?.(this.chunks);
    this.chunks = [];
  }
}
