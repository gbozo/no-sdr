//! Optional Cloudflare Durable Object fan-out.
//!
//! One `EdgeService` owns one outbound WebSocket publisher per dongle. The
//! publishers are fed only the latest encoded FFT frame, so a slow or broken
//! edge link can never back-pressure the dongle loop.

pub mod publisher;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::{Mutex, RwLock};
use serde_json::json;
use tokio::sync::watch;

use crate::config::{Config, EdgeConfig};

use publisher::{Metrics, PublisherConfig};

struct PublisherHandle {
    frames: watch::Sender<Option<Arc<Vec<u8>>>>,
    stop: watch::Sender<bool>,
    metrics: Arc<Metrics>,
}

/// Owns the edge publishers and exposes their status to the admin API.
pub struct EdgeService {
    cfg: Arc<RwLock<Config>>,
    publishers: Mutex<HashMap<String, PublisherHandle>>,
}

impl EdgeService {
    pub fn new(cfg: Arc<RwLock<Config>>) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            publishers: Mutex::new(HashMap::new()),
        })
    }

    /// Starts publishers for every enabled/selected dongle.
    pub fn start(self: &Arc<Self>) {
        self.reload();
    }

    /// Rebuilds the publisher set after a config change.
    pub fn reload(self: &Arc<Self>) {
        self.stop_all();

        let cfg = self.cfg.read();
        let edge = cfg.edge.clone();
        if !edge.enabled {
            tracing::info!("edge: disabled");
            return;
        }

        let dongles: Vec<String> = if edge.dongles.is_empty() {
            cfg.dongles.iter().map(|d| d.id.clone()).collect()
        } else {
            edge.dongles.clone()
        };

        for dongle in dongles {
            if !cfg.dongles.iter().any(|d| d.id == dongle) {
                tracing::warn!(dongle = %dongle, "edge: configured dongle not found, skipping");
                continue;
            }
            self.spawn_publisher(&edge, &dongle);
        }

        tracing::info!(
            instance = %edge.instance_id,
            url = %edge.url,
            codec = %edge.codec,
            publishers = ?self.publishers.lock().keys().collect::<Vec<_>>(),
            "edge: started"
        );
    }

    fn spawn_publisher(self: &Arc<Self>, edge: &EdgeConfig, dongle: &str) {
        let (frames_tx, frames_rx) = watch::channel(None);
        let (stop_tx, stop_rx) = watch::channel(false);
        let metrics = Arc::new(Metrics::default());

        let config = PublisherConfig {
            base_url: edge.url.clone(),
            instance_id: edge.instance_id.clone(),
            dongle_id: dongle.to_string(),
            token: edge.ingest_token.clone(),
            codec: edge.codec.clone(),
            max_viewers: edge.max_viewers,
            history_mode: edge.history.mode.clone(),
            history_bins: edge.history.bins,
            history_frames: edge.history.frames,
            reconnect_min_ms: edge.reconnect.min_ms,
            reconnect_max_ms: edge.reconnect.max_ms,
        };

        tokio::spawn(publisher::run(
            config,
            frames_rx,
            stop_rx,
            metrics.clone(),
        ));

        self.publishers.lock().insert(
            dongle.to_string(),
            PublisherHandle {
                frames: frames_tx,
                stop: stop_tx,
                metrics,
            },
        );
    }

    /// Pushes the latest encoded frame. Intermediate frames are coalesced by
    /// the watch channel; the dongle loop never waits for the network.
    pub fn publish(&self, dongle: &str, frame: Arc<Vec<u8>>) {
        if let Some(handle) = self.publishers.lock().get(dongle) {
            let _ = handle.frames.send_replace(Some(frame));
        }
    }

    pub fn is_enabled_for(&self, dongle: &str) -> bool {
        let cfg = self.cfg.read();
        if !cfg.edge.enabled {
            return false;
        }
        cfg.edge.dongles.is_empty() || cfg.edge.dongles.iter().any(|d| d == dongle)
    }

    pub fn codec(&self) -> String {
        self.cfg.read().edge.codec.clone()
    }

    /// Cumulative application bytes written to all edge publishers. Added to
    /// the server egress meter so the UI shows total outbound wire traffic.
    pub fn total_bytes_sent(&self) -> u64 {
        self.publishers
            .lock()
            .values()
            .map(|handle| handle.metrics.bytes_sent.load(Ordering::Relaxed))
            .sum()
    }

    pub fn shutdown(&self) {
        self.stop_all();
    }

    fn stop_all(&self) {
        let handles: Vec<PublisherHandle> = {
            let mut map = self.publishers.lock();
            let handles = map
                .drain()
                .map(|(_, handle)| handle)
                .collect::<Vec<PublisherHandle>>();
            handles
        };
        for handle in handles {
            let _ = handle.stop.send_replace(true);
        }
    }

    pub fn status(&self) -> serde_json::Value {
        let cfg = self.cfg.read();
        let publishers = self.publishers.lock();
        let mut out = serde_json::Map::new();

        for (dongle, handle) in publishers.iter() {
            out.insert(
                dongle.clone(),
                json!({
                    "connected": handle.metrics.connected.load(Ordering::Relaxed),
                    "framesSent": handle.metrics.frames_sent.load(Ordering::Relaxed),
                    "bytesSent": handle.metrics.bytes_sent.load(Ordering::Relaxed),
                    "dropped": handle.metrics.dropped.load(Ordering::Relaxed),
                    "reconnects": handle.metrics.reconnects.load(Ordering::Relaxed),
                    "lastFrameAt": handle.metrics.last_frame_at.load(Ordering::Relaxed),
                    "lastError": handle.metrics.last_error.lock().clone(),
                }),
            );
        }

        json!({
            "enabled": cfg.edge.enabled,
            "url": cfg.edge.url,
            "instanceId": cfg.edge.instance_id,
            "codec": cfg.edge.codec,
            "hasIngestToken": !cfg.edge.ingest_token.is_empty(),
            "publishers": out,
        })
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
