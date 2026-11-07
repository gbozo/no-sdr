//! Connected WebSocket client state and its outgoing write queue.
//!
//! Port of `serverng/internal/ws/client.go`.

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Notify};

use super::protocol::{ClientCommand, CodecStatus};

/// Default buffered write-queue capacity.
pub const DEFAULT_WRITE_CH_SIZE: usize = 128;

/// A queued outgoing WebSocket message.
#[derive(Debug, Clone)]
pub struct Outgoing {
    pub data: Vec<u8>,
    /// `true` for binary frames, `false` for text frames.
    pub binary: bool,
}

impl Outgoing {
    pub fn binary(data: Vec<u8>) -> Self {
        Self { data, binary: true }
    }

    pub fn text(data: Vec<u8>) -> Self {
        Self {
            data,
            binary: false,
        }
    }
}

struct QueueInner {
    items: VecDeque<Outgoing>,
    last_drain_at: Instant,
}

/// Bounded message queue with drop-oldest backpressure.
///
/// `last_drain_at` is updated only when a message is enqueued without having
/// to drop an older one (matching the Go implementation, which uses this to
/// distinguish a dead consumer from momentary congestion).
pub struct WriteQueue {
    inner: Mutex<QueueInner>,
    capacity: usize,
    notify: Notify,
}

impl WriteQueue {
    pub fn new(capacity: usize) -> Self {
        let capacity = if capacity == 0 {
            DEFAULT_WRITE_CH_SIZE
        } else {
            capacity
        };
        Self {
            inner: Mutex::new(QueueInner {
                items: VecDeque::with_capacity(capacity),
                last_drain_at: Instant::now(),
            }),
            capacity,
            notify: Notify::new(),
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn len(&self) -> usize {
        self.inner.lock().items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Enqueue a message. When the queue is full the oldest entry is dropped.
    pub fn push(&self, msg: Outgoing) {
        {
            let mut inner = self.inner.lock();
            if inner.items.len() >= self.capacity {
                inner.items.pop_front();
                inner.items.push_back(msg);
                // Do NOT update last_drain_at — the stale checker relies on this.
            } else {
                inner.items.push_back(msg);
                inner.last_drain_at = Instant::now();
            }
        }
        self.notify.notify_one();
    }

    pub fn pop(&self) -> Option<Outgoing> {
        self.inner.lock().items.pop_front()
    }

    /// Drops queued FFT frames (used when the client changes FFT codec or the
    /// dongle profile changes, so stale frames of the old codec/center frequency
    /// are not delivered before the new stream).
    pub fn drop_fft(&self) {
        let mut inner = self.inner.lock();
        inner.items.retain(|msg| {
            if !msg.binary || msg.data.is_empty() {
                return true;
            }
            // MSG_FFT, MSG_FFT_COMPRESSED, MSG_FFT_ADPCM, MSG_FFT_DEFLATE
            !matches!(msg.data[0], 0x01 | 0x04 | 0x08 | 0x0B)
        });
    }

    /// Wait until a message is available, then pop it.
    pub async fn wait_pop(&self) -> Option<Outgoing> {
        loop {
            let notified = self.notify.notified();
            if let Some(msg) = self.pop() {
                return Some(msg);
            }
            notified.await;
        }
    }

    /// A queue is stale when it is full and nothing has been enqueued (without
    /// dropping) for longer than `threshold`.
    pub fn is_stale(&self, threshold: Duration) -> bool {
        let inner = self.inner.lock();
        if inner.items.len() < self.capacity {
            return false;
        }
        inner.last_drain_at.elapsed() > threshold
    }
}

/// Codec sets the server accepts from clients.
#[derive(Debug, Clone)]
pub struct AllowedCodecs {
    pub fft: HashSet<String>,
    pub iq: HashSet<String>,
}

impl Default for AllowedCodecs {
    fn default() -> Self {
        Self {
            fft: ["none", "adpcm", "deflate", "deflate-floor"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            iq: ["none", "adpcm", "opus-lo", "opus", "opus-hq"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }
}

/// Per-subscription client state, written from the read loop.
#[derive(Debug, Clone, Default)]
pub struct ClientState {
    pub dongle_id: String,
    pub profile_id: String,
    pub audio_enabled: bool,
    pub stereo_enabled: bool,
    pub fft_codec: String,
    pub iq_codec: String,
    pub mode: String,
    pub tune_offset: i64,
    pub bandwidth: i64,
}

impl ClientState {
    fn new() -> Self {
        Self {
            stereo_enabled: true,
            ..Default::default()
        }
    }
}

/// A connected WebSocket client.
pub struct Client {
    /// Internal connection ID (changes on every reconnect).
    pub id: String,
    /// Client-facing UUID (stable across reconnects).
    pub persistent_id: String,
    /// Connection index for this persistent ID (1, 2, 3... for multi-tab).
    pub conn_index: i64,
    pub connected_at: DateTime<Utc>,
    /// Resolved client IP (may come from a proxy header).
    pub remote_addr: String,
    /// Raw proxy header value; empty when no proxy header is configured.
    pub real_ip: String,

    state: Mutex<ClientState>,
    queue: WriteQueue,
    cancel_tx: watch::Sender<bool>,
    last_seen: Mutex<Instant>,
}

impl Client {
    pub fn new(
        id: String,
        persistent_id: String,
        conn_index: i64,
        remote_addr: String,
        real_ip: String,
        write_cap: usize,
    ) -> Self {
        let (cancel_tx, _) = watch::channel(false);
        Self {
            id,
            persistent_id,
            conn_index,
            connected_at: Utc::now(),
            remote_addr,
            real_ip,
            state: Mutex::new(ClientState::new()),
            queue: WriteQueue::new(write_cap),
            cancel_tx,
            last_seen: Mutex::new(Instant::now()),
        }
    }

    /// Record activity from the peer (any received frame, including pongs).
    pub fn touch(&self) {
        *self.last_seen.lock() = Instant::now();
    }

    /// Time since the last frame was received from the peer.
    pub fn last_seen_elapsed(&self) -> Duration {
        self.last_seen.lock().elapsed()
    }

    /// Enqueue a binary message. Never blocks; drops the oldest entry when full.
    pub fn send(&self, msg: Vec<u8>) {
        self.queue.push(Outgoing::binary(msg));
    }

    /// Enqueue a text message.
    pub fn send_text(&self, msg: Vec<u8>) {
        self.queue.push(Outgoing::text(msg));
    }

    pub fn queue(&self) -> &WriteQueue {
        &self.queue
    }

    /// Subscribe to cancellation. The write loop uses this to exit promptly.
    pub fn subscribe_cancel(&self) -> watch::Receiver<bool> {
        self.cancel_tx.subscribe()
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancel_tx.borrow()
    }

    /// Cancel the client context, which triggers cleanup.
    pub fn close(&self) {
        let _ = self.cancel_tx.send(true);
    }

    pub fn is_stale(&self, threshold: Duration) -> bool {
        self.queue.is_stale(threshold)
    }

    pub fn subscribed_to(&self) -> String {
        self.state.lock().dongle_id.clone()
    }

    pub fn profile_id(&self) -> String {
        self.state.lock().profile_id.clone()
    }

    pub fn set_profile_id(&self, profile_id: &str) {
        self.state.lock().profile_id = profile_id.to_string();
    }

    pub fn fft_codec(&self) -> String {
        self.state.lock().fft_codec.clone()
    }

    pub fn iq_codec(&self) -> String {
        self.state.lock().iq_codec.clone()
    }

    pub fn mode(&self) -> String {
        self.state.lock().mode.clone()
    }

    pub fn tune_offset(&self) -> i64 {
        self.state.lock().tune_offset
    }

    pub fn bandwidth(&self) -> i64 {
        self.state.lock().bandwidth
    }

    pub fn audio_enabled(&self) -> bool {
        self.state.lock().audio_enabled
    }

    pub fn stereo_enabled(&self) -> bool {
        self.state.lock().stereo_enabled
    }

    pub fn snapshot(&self) -> ClientState {
        self.state.lock().clone()
    }

    /// Clear the client's dongle subscription.
    pub fn unsubscribe(&self) {
        let mut st = self.state.lock();
        st.dongle_id.clear();
        st.profile_id.clear();
    }

    /// Discards queued FFT frames so a codec/profile change takes effect
    /// immediately instead of after draining the old backlog.
    pub fn drop_queued_fft(&self) {
        self.queue.drop_fft();
    }

    /// Update state when the server switches profiles.
    pub fn apply_profile_change(&self, profile_id: &str, mode: &str, bandwidth: i64) {
        let mut st = self.state.lock();
        st.profile_id = profile_id.to_string();
        st.mode = mode.to_string();
        st.bandwidth = bandwidth;
        st.tune_offset = 0; // offset is invalid for the new center frequency
    }

    /// Apply a client command to the client's state.
    ///
    /// Returns a `CodecStatus` if a codec was rejected.
    pub fn update_from_command(
        &self,
        cmd: &ClientCommand,
        allowed: &AllowedCodecs,
    ) -> Option<CodecStatus> {
        let mut st = self.state.lock();
        match cmd.cmd.as_str() {
            "subscribe" => {
                if !cmd.dongle_id.is_empty() {
                    st.dongle_id = cmd.dongle_id.clone();
                    // Reset per-subscription state — repopulated by later commands.
                    st.profile_id.clear();
                    st.audio_enabled = false;
                    st.stereo_enabled = false;
                    st.mode.clear();
                    st.tune_offset = 0;
                    st.bandwidth = 0;
                }
                None
            }
            "tune" => {
                st.tune_offset = cmd.offset;
                None
            }
            "mode" => {
                if !cmd.mode.is_empty() {
                    st.mode = cmd.mode.clone();
                }
                if cmd.bandwidth > 0 {
                    st.bandwidth = cmd.bandwidth;
                }
                None
            }
            "bandwidth" => {
                st.bandwidth = cmd.hz;
                None
            }
            "codec" => {
                let mut status: Option<CodecStatus> = None;
                if !cmd.fft_codec.is_empty() {
                    if allowed.fft.contains(&cmd.fft_codec) {
                        st.fft_codec = cmd.fft_codec.clone();
                    } else {
                        st.fft_codec = "none".to_string();
                        status = Some(CodecStatus {
                            fft_codec: "none".to_string(),
                            fft_msg: format!(
                                "codec '{}' not available on this server, using 'none'",
                                cmd.fft_codec
                            ),
                            ..Default::default()
                        });
                    }
                }
                if !cmd.iq_codec.is_empty() {
                    if allowed.iq.contains(&cmd.iq_codec) {
                        st.iq_codec = cmd.iq_codec.clone();
                    } else {
                        st.iq_codec = "none".to_string();
                        let s = status.get_or_insert_with(CodecStatus::default);
                        s.iq_codec = "none".to_string();
                        s.iq_msg = format!(
                            "codec '{}' not available on this server, using 'none'",
                            cmd.iq_codec
                        );
                    }
                }
                status
            }
            "audio_enabled" => {
                if let Some(enabled) = cmd.enabled {
                    st.audio_enabled = enabled;
                }
                None
            }
            "stereo_enabled" => {
                if let Some(enabled) = cmd.enabled {
                    st.stereo_enabled = enabled;
                }
                None
            }
            _ => None,
        }
    }
}

/// Snapshot of client state for the admin API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub id: String,
    pub persistent_id: String,
    pub conn_index: i64,
    pub ip: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub real_ip: String,
    pub dongle_id: String,
    pub profile_id: String,
    pub fft_codec: String,
    pub iq_codec: String,
    pub mode: String,
    pub tune_offset: i64,
    pub bandwidth: i64,
    pub audio_enabled: bool,
    pub stereo_enabled: bool,
    pub connected_at: DateTime<Utc>,
}

impl ClientInfo {
    pub fn from_client(c: &Client) -> Self {
        let st = c.snapshot();
        Self {
            id: c.id.clone(),
            persistent_id: c.persistent_id.clone(),
            conn_index: c.conn_index,
            ip: c.remote_addr.clone(),
            real_ip: c.real_ip.clone(),
            dongle_id: st.dongle_id,
            profile_id: st.profile_id,
            fft_codec: st.fft_codec,
            iq_codec: st.iq_codec,
            mode: st.mode,
            tune_offset: st.tune_offset,
            bandwidth: st.bandwidth,
            audio_enabled: st.audio_enabled,
            stereo_enabled: st.stereo_enabled,
            connected_at: c.connected_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(json: &str) -> ClientCommand {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn backpressure_drops_oldest() {
        let (tx, _rx) = watch::channel(false);
        let c = Client {
            id: "test".into(),
            persistent_id: "p".into(),
            conn_index: 1,
            connected_at: Utc::now(),
            remote_addr: String::new(),
            real_ip: String::new(),
            state: Mutex::new(ClientState::new()),
            queue: WriteQueue::new(3),
            cancel_tx: tx,
            last_seen: Mutex::new(Instant::now()),
        };
        c.send(vec![1]);
        c.send(vec![2]);
        c.send(vec![3]);
        c.send(vec![4]);
        assert!(!c.is_cancelled());
        assert_eq!(c.queue.len(), 3);
        let ids: Vec<u8> = (0..3).map(|_| c.queue.pop().unwrap().data[0]).collect();
        assert_eq!(ids, vec![2, 3, 4]);
    }

    #[test]
    fn is_stale_semantics() {
        let q = WriteQueue::new(3);
        assert!(!q.is_stale(Duration::from_secs(1)));
        // Pretend the queue is full with an ancient enqueue.
        {
            let mut inner = q.inner.lock();
            inner.items.push_back(Outgoing::binary(vec![1]));
            inner.items.push_back(Outgoing::binary(vec![2]));
            inner.items.push_back(Outgoing::binary(vec![3]));
            inner.last_drain_at = Instant::now() - Duration::from_secs(5);
        }
        assert!(q.is_stale(Duration::from_secs(1)));
        // Fresh enqueue that had to drop an old message must not refresh it.
        q.push(Outgoing::binary(vec![4]));
        assert!(q.is_stale(Duration::from_secs(1)));
    }

    #[test]
    fn queue_updates_drain_when_not_full() {
        let q = WriteQueue::new(4);
        {
            let mut inner = q.inner.lock();
            inner.last_drain_at = Instant::now() - Duration::from_secs(5);
        }
        q.push(Outgoing::binary(vec![1]));
        assert!(!q.is_stale(Duration::from_secs(1)));
    }

    #[test]
    fn command_state_machine() {
        let c = Client::new(
            "id".into(),
            "pid".into(),
            1,
            String::new(),
            String::new(),
            8,
        );
        let allowed = AllowedCodecs::default();

        assert!(c.update_from_command(&cmd(r#"{"cmd":"subscribe","dongleId":"d1"}"#), &allowed).is_none());
        assert_eq!(c.subscribed_to(), "d1");
        // subscribe resets stereo and audio
        assert!(!c.stereo_enabled());
        assert!(!c.audio_enabled());

        c.update_from_command(&cmd(r#"{"cmd":"tune","offset":50000}"#), &allowed);
        assert_eq!(c.tune_offset(), 50000);

        c.update_from_command(&cmd(r#"{"cmd":"mode","mode":"usb","bandwidth":2400}"#), &allowed);
        assert_eq!(c.mode(), "usb");
        assert_eq!(c.bandwidth(), 2400);

        c.update_from_command(&cmd(r#"{"cmd":"bandwidth","hz":3000}"#), &allowed);
        assert_eq!(c.bandwidth(), 3000);

        c.update_from_command(&cmd(r#"{"cmd":"audio_enabled","enabled":true}"#), &allowed);
        assert!(c.audio_enabled());
        c.update_from_command(&cmd(r#"{"cmd":"stereo_enabled","enabled":true}"#), &allowed);
        assert!(c.stereo_enabled());

        // Valid codecs are accepted silently.
        let st = c.update_from_command(
            &cmd(r#"{"cmd":"codec","fftCodec":"deflate","iqCodec":"opus"}"#),
            &allowed,
        );
        assert!(st.is_none());
        assert_eq!(c.fft_codec(), "deflate");
        assert_eq!(c.iq_codec(), "opus");

        // Unknown codecs fall back to none and produce a status message.
        let st = c
            .update_from_command(&cmd(r#"{"cmd":"codec","fftCodec":"bogus"}"#), &allowed)
            .unwrap();
        assert_eq!(st.fft_codec, "none");
        assert_eq!(c.fft_codec(), "none");
        assert!(st.fft_msg.contains("bogus"));

        c.apply_profile_change("p2", "am", 8330);
        assert_eq!(c.profile_id(), "p2");
        assert_eq!(c.mode(), "am");
        assert_eq!(c.bandwidth(), 8330);
        assert_eq!(c.tune_offset(), 0);

        c.unsubscribe();
        assert!(c.subscribed_to().is_empty());
        assert!(c.profile_id().is_empty());
    }

    #[test]
    fn client_info_serializes_camel_case() {
        let c = Client::new(
            "id".into(),
            "pid".into(),
            2,
            "1.2.3.4".into(),
            "5.6.7.8".into(),
            8,
        );
        let info = ClientInfo::from_client(&c);
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["persistentId"], "pid");
        assert_eq!(v["connIndex"], 2);
        assert_eq!(v["ip"], "1.2.3.4");
        assert_eq!(v["realIp"], "5.6.7.8");
        assert!(v["connectedAt"].as_str().unwrap().contains('T'));
    }
}

#[cfg(test)]
mod queue_tests {
    use super::*;

    #[test]
    fn drop_fft_keeps_other_messages() {
        let q = WriteQueue::new(16);
        q.push(Outgoing::binary(vec![0x04, 1, 2]));
        q.push(Outgoing::binary(vec![0x03, b'{', b'}']));
        q.push(Outgoing::binary(vec![0x0C, 1]));
        q.push(Outgoing::binary(vec![0x08, 1]));
        q.push(Outgoing::text(b"{}".to_vec()));

        q.drop_fft();

        let mut types = Vec::new();
        while let Some(msg) = q.pop() {
            types.push(msg.data[0]);
        }
        assert_eq!(types, vec![0x03, 0x0C, b'{']);
    }
}
