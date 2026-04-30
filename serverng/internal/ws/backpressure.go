package ws

// Backpressure strategy:
//
// - writeCh is a buffered channel (cap = DefaultWriteChSize, typically 8).
//   This allows ~8 FFT frames to queue before triggering drops.
//
// - When writeCh is full, the oldest message is dropped via non-blocking
//   receive, then the new message is sent. This ensures recent data always
//   takes priority over stale frames.
//
// - A per-client write goroutine drains writeCh and sends via the websocket
//   connection. This decouples producers (FFT/IQ pipelines) from the actual
//   network write speed.
//
// - If a websocket write fails (network error, client gone), the client is
//   disconnected immediately. The write goroutine exits and cleanup runs.
//
// - The read goroutine handles JSON commands from the client. If the read
//   fails (disconnect, malformed), the client context is cancelled which
//   also tears down the write goroutine.
//
// Flow diagram:
//
//   Producer goroutines                 Per-client write goroutine
//   (FFT, IQ broadcasts)               (drains writeCh)
//         │                                     │
//         ▼                                     ▼
//   client.Send(msg)  ──►  writeCh  ──►  conn.Write(binary)
//         │                   │
//         │ (if full)         │
//         ▼                   │
//   drop oldest from ch       │
//   re-enqueue new msg        │
//                             │
//                     On write error:
//                     cancel ctx → cleanup
