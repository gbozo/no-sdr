//! Outbound WebSocket publisher for one dongle.
//!
//! The publisher is intentionally latest-frame oriented: a watch channel holds
//! only the most recent encoded FFT frame. If the Cloudflare link stalls, older
//! frames are dropped rather than queued, and the dongle loop is never blocked.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::watch;
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use super::now_ms;

#[derive(Debug, Clone)]
pub struct PublisherConfig {
    pub base_url: String,
    pub instance_id: String,
    pub dongle_id: String,
    pub token: String,
    pub codec: String,
    pub max_viewers: i32,
    pub history_mode: String,
    pub history_bins: i32,
    pub history_frames: i32,
    pub reconnect_min_ms: i64,
    pub reconnect_max_ms: i64,
}

#[derive(Debug, Default)]
pub struct Metrics {
    pub connected: AtomicBool,
    pub frames_sent: AtomicU64,
    pub dropped: AtomicU64,
    pub reconnects: AtomicU64,
    pub last_frame_at: AtomicU64,
    /// Application payload bytes written to the edge WebSocket (hex/ping,
    /// history/control, live frames). Used by the server egress meter.
    pub bytes_sent: AtomicU64,
    pub last_error: Mutex<String>,
}

pub async fn run(
    cfg: PublisherConfig,
    mut frames: watch::Receiver<Option<Arc<Vec<u8>>>>,
    mut stop: watch::Receiver<bool>,
    metrics: Arc<Metrics>,
) {
    let mut backoff = cfg.reconnect_min_ms.max(100);

    loop {
        if *stop.borrow() {
            break;
        }

        match connect_once(&cfg, &mut frames, &mut stop, &metrics).await {
            Ok(()) => {
                backoff = cfg.reconnect_min_ms.max(100);
            }
            Err(err) => {
                *metrics.last_error.lock() = err.to_string();
                tracing::warn!(
                    dongle = %cfg.dongle_id,
                    error = %err,
                    "edge: publisher disconnected"
                );
            }
        }

        metrics.connected.store(false, Ordering::Relaxed);
        metrics.reconnects.fetch_add(1, Ordering::Relaxed);

        let delay = backoff.min(cfg.reconnect_max_ms.max(100)) as u64;
        backoff = (backoff.saturating_mul(2)).min(cfg.reconnect_max_ms.max(100));

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
            _ = stop.changed() => {
                if *stop.borrow() { break; }
            }
        }
    }

    metrics.connected.store(false, Ordering::Relaxed);
}

async fn connect_once(
    cfg: &PublisherConfig,
    frames: &mut watch::Receiver<Option<Arc<Vec<u8>>>>,
    stop: &mut watch::Receiver<bool>,
    metrics: &Arc<Metrics>,
) -> Result<()> {
    let base = cfg.base_url.trim_end_matches('/');
    let url = format!("{base}/ingest/{}/{}", cfg.instance_id, cfg.dongle_id);

    let mut request = url
        .clone()
        .into_client_request()
        .with_context(|| format!("edge: invalid url {url}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", cfg.token)
            .parse()
            .context("edge: invalid bearer token")?,
    );

    let (ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .with_context(|| format!("edge: connect {url}"))?;

    metrics.connected.store(true, Ordering::Relaxed);
    metrics.last_error.lock().clear();
    tracing::info!(dongle = %cfg.dongle_id, url = %url, "edge: connected");

    let (mut write, mut read) = ws.split();

    let hello = json!({
        "cmd": "hello",
        "instance": cfg.instance_id,
        "dongle": cfg.dongle_id,
        "codec": cfg.codec,
        "maxViewers": cfg.max_viewers,
        "history": {
            "mode": cfg.history_mode,
            "bins": cfg.history_bins,
            "frames": cfg.history_frames,
        },
    });
    let hello_text = hello.to_string();
    let hello_len = hello_text.len();
    write
        .send(Message::text(hello_text))
        .await
        .context("edge: send hello")?;
    metrics.bytes_sent.fetch_add(hello_len as u64, Ordering::Relaxed);

    // If a frame was produced while the socket was connecting, send the newest
    // one immediately instead of waiting for the next FFT tick.
    let initial = { frames.borrow().clone() };
    if let Some(frame) = initial {
        write
            .send(Message::binary((*frame).clone()))
            .await
            .context("edge: send initial frame")?;
        metrics.frames_sent.fetch_add(1, Ordering::Relaxed);
        metrics.bytes_sent.fetch_add(frame.len() as u64, Ordering::Relaxed);
        metrics.last_frame_at.store(now_ms(), Ordering::Relaxed);
    }

    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() {
                    let _ = write.close().await;
                    return Ok(());
                }
            }
            _ = heartbeat.tick() => {
                const PING: &str = r#"{"cmd":"ping"}"#;
                write
                    .send(Message::text(PING))
                    .await
                    .context("edge: heartbeat")?;
                metrics.bytes_sent.fetch_add(PING.len() as u64, Ordering::Relaxed);
            }
            changed = frames.changed() => {
                if changed.is_err() {
                    return Ok(());
                }
                let latest = { frames.borrow_and_update().clone() };
                if let Some(frame) = latest {
                    write
                        .send(Message::binary((*frame).clone()))
                        .await
                        .context("edge: send frame")?;
                    metrics.frames_sent.fetch_add(1, Ordering::Relaxed);
                    metrics.bytes_sent.fetch_add(frame.len() as u64, Ordering::Relaxed);
                    metrics.last_frame_at.store(now_ms(), Ordering::Relaxed);
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        tracing::debug!(dongle = %cfg.dongle_id, %text, "edge: message");
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let len = payload.len() as u64;
                        write.send(Message::Pong(payload)).await?;
                        metrics.bytes_sent.fetch_add(len, Ordering::Relaxed);
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Err(err)) => return Err(err).context("edge: read"),
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}
