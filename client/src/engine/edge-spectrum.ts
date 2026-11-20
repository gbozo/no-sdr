// Minimal edge WebSocket transport for the FFT plane.
//
// The Cloudflare DO speaks the existing no-sdr binary frames, so this module
// only handles connection lifecycle; decoding stays in sdr-engine's existing
// FFT worker path.

export interface EdgeClientOptions {
  onFrame: (data: ArrayBuffer) => void;
  onOpen: () => void;
  onClose: (reason: string) => void;
  onError?: (error: Event) => void;
}

export class EdgeSpectrumClient {
  private ws: WebSocket | null = null;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly options: EdgeClientOptions,
  ) {}

  connect(): void {
    if (this.ws) return;
    this.closed = false;

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.options.onClose(`edge connect failed: ${String(err)}`);
      return;
    }

    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      if (this.closed) {
        try { ws.close(); } catch { /* ignore */ }
        return;
      }
      this.options.onOpen();
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.options.onFrame(event.data);
      }
    };

    ws.onerror = (event) => {
      this.options.onError?.(event);
    };

    ws.onclose = (event) => {
      if (this.ws === ws) this.ws = null;
      if (!this.closed) {
        this.options.onClose(event.reason || `edge closed (${event.code})`);
      }
    };
  }

  send(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(text);
    }
  }

  close(): void {
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
