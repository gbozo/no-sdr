//! WebSocket connection manager.
//!
//! Port of `serverng/internal/ws/manager.go` using axum's WebSocket support.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use parking_lot::RwLock;
use serde::Deserialize;
use tokio::sync::watch;
use uuid::Uuid;

use super::client::{
    AllowedCodecs, Client, ClientInfo, DEFAULT_WRITE_CH_SIZE,
};
use super::protocol::{
    pack_codec_status_message, pack_meta_message, parse_client_command, ClientCommand, ServerMeta,
};
use super::ratelimit::RateLimiter;

/// Server version advertised in the welcome message.
pub const SERVER_VERSION: &str = "2.11.3";

type CommandHandler = Arc<dyn Fn(&str, &ClientCommand) + Send + Sync>;
type ClientHandler = Arc<dyn Fn(&str) + Send + Sync>;

/// Query parameters accepted on the `/ws` upgrade request.
#[derive(Debug, Default, Deserialize)]
pub struct UpgradeQuery {
    #[serde(rename = "clientId", default)]
    pub client_id: Option<String>,
}

/// Handles WebSocket client connections and broadcasting.
pub struct WsManager {
    clients: RwLock<HashMap<String, Arc<Client>>>,
    on_command: RwLock<Option<CommandHandler>>,
    on_disconnect: RwLock<Option<ClientHandler>>,
    on_connect: RwLock<Option<ClientHandler>>,
    rate_limiter: RwLock<Option<Arc<RateLimiter>>>,
    allowed: RwLock<AllowedCodecs>,
    real_ip_header: RwLock<String>,
    max_fft_fps: AtomicUsize,
    stale_started: AtomicBool,
    total_bytes: Arc<AtomicU64>,
}

impl Default for WsManager {
    fn default() -> Self {
        Self::new()
    }
}

impl WsManager {
    pub fn new() -> Self {
        Self {
            clients: RwLock::new(HashMap::new()),
            on_command: RwLock::new(None),
            on_disconnect: RwLock::new(None),
            on_connect: RwLock::new(None),
            rate_limiter: RwLock::new(None),
            allowed: RwLock::new(AllowedCodecs::default()),
            real_ip_header: RwLock::new(String::new()),
            max_fft_fps: AtomicUsize::new(30),
            stale_started: AtomicBool::new(false),
            total_bytes: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Maximum FFT frame rate across all active profiles; controls the
    /// per-client write-queue capacity (`fps*3 + 64`, at least 128).
    pub fn set_max_fft_fps(&self, fps: usize) {
        let fps = if fps == 0 { 30 } else { fps };
        self.max_fft_fps.store(fps, Ordering::SeqCst);
    }

    pub fn max_fft_fps(&self) -> usize {
        self.max_fft_fps.load(Ordering::SeqCst)
    }

    fn write_chan_cap(&self) -> usize {
        let cap = self.max_fft_fps() * 3 + 64;
        cap.max(DEFAULT_WRITE_CH_SIZE)
    }

    /// Replace the server's allowed codec sets.
    pub fn set_allowed_codecs(&self, fft: &[String], iq: &[String]) {
        *self.allowed.write() = AllowedCodecs {
            fft: fft.iter().cloned().collect(),
            iq: iq.iter().cloned().collect(),
        };
    }

    pub fn set_rate_limiter(&self, rl: Arc<RateLimiter>) {
        *self.rate_limiter.write() = Some(rl);
    }

    pub fn rate_limiter(&self) -> Option<Arc<RateLimiter>> {
        self.rate_limiter.read().clone()
    }

    /// Configure which header carries the real client IP when behind a proxy.
    pub fn set_real_ip_header(&self, header: &str) {
        *self.real_ip_header.write() = header.to_string();
    }

    pub fn real_ip_header(&self) -> String {
        self.real_ip_header.read().clone()
    }

    /// Extract the real client IP from request headers.
    ///
    /// Returns `(resolved, raw)` where `resolved` is the first entry of
    /// `X-Forwarded-For` (or the whole value for other headers) and `raw` is
    /// the verbatim header value (empty when no proxy header is configured).
    pub fn resolve_client_ip_full(&self, headers: &HeaderMap, remote: &str) -> (String, String) {
        let hdr = self.real_ip_header.read().clone();
        if !hdr.is_empty() {
            if let Some(val) = headers.get(&hdr).and_then(|v| v.to_str().ok()) {
                if !val.is_empty() {
                    let resolved = val
                        .split(',')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    return (resolved, val.to_string());
                }
            }
        }
        (remote.to_string(), String::new())
    }

    pub fn resolve_client_ip(&self, headers: &HeaderMap, remote: &str) -> String {
        self.resolve_client_ip_full(headers, remote).0
    }

    pub fn set_command_handler<F>(&self, f: F)
    where
        F: Fn(&str, &ClientCommand) + Send + Sync + 'static,
    {
        *self.on_command.write() = Some(Arc::new(f));
    }

    pub fn set_disconnect_handler<F>(&self, f: F)
    where
        F: Fn(&str) + Send + Sync + 'static,
    {
        *self.on_disconnect.write() = Some(Arc::new(f));
    }

    pub fn set_connect_handler<F>(&self, f: F)
    where
        F: Fn(&str) + Send + Sync + 'static,
    {
        *self.on_connect.write() = Some(Arc::new(f));
    }

    /// Set the active profile ID on a connected client.
    pub fn set_client_profile_id(&self, client_id: &str, profile_id: &str) {
        if let Some(c) = self.clients.read().get(client_id) {
            c.set_profile_id(profile_id);
        }
    }

    /// Update a client's state for a profile switch.
    pub fn apply_profile_change_to_client(
        &self,
        client_id: &str,
        profile_id: &str,
        mode: &str,
        bandwidth: i64,
    ) {
        if let Some(c) = self.clients.read().get(client_id) {
            c.apply_profile_change(profile_id, mode, bandwidth);
        }
    }

    /// Broadcast a binary message to all clients subscribed to `dongle_id`.
    pub fn broadcast(&self, dongle_id: &str, msg: Vec<u8>) {
        let clients: Vec<Arc<Client>> = self.clients.read().values().cloned().collect();
        for c in clients {
            if c.subscribed_to() == dongle_id {
                c.send(msg.clone());
            }
        }
    }

    /// Broadcast a binary message to every connected client.
    pub fn broadcast_all(&self, msg: Vec<u8>) {
        let clients: Vec<Arc<Client>> = self.clients.read().values().cloned().collect();
        for c in clients {
            c.send(msg.clone());
        }
    }

    /// Send a binary message to a specific client.
    pub fn send_to(&self, client_id: &str, msg: Vec<u8>) {
        if let Some(c) = self.clients.read().get(client_id) {
            c.send(msg);
        }
    }

    pub fn client_count(&self) -> usize {
        self.clients.read().len()
    }

    /// Cumulative payload bytes written to WebSocket clients (survives disconnects).
    pub fn total_bytes_written(&self) -> u64 {
        self.total_bytes.load(Ordering::Relaxed)
    }

    /// Clients subscribed to a specific dongle.
    pub fn subscribed_clients(&self, dongle_id: &str) -> Vec<Arc<Client>> {
        self.clients
            .read()
            .values()
            .filter(|c| c.subscribed_to() == dongle_id)
            .cloned()
            .collect()
    }

    /// Unsubscribe all clients from a dongle and send `dongle_disconnected`
    /// metadata. Returns the affected client IDs.
    pub fn unsubscribe_from_dongle(&self, dongle_id: &str, reason: &str) -> Vec<String> {
        let affected: Vec<Arc<Client>> = self
            .clients
            .read()
            .values()
            .filter(|c| c.subscribed_to() == dongle_id)
            .cloned()
            .collect();

        let meta = pack_meta_message(&ServerMeta {
            msg_type: "dongle_disconnected".into(),
            dongle_id: Some(dongle_id.to_string()),
            message: Some(reason.to_string()),
            ..Default::default()
        });

        let mut ids = Vec::with_capacity(affected.len());
        for c in affected {
            c.unsubscribe();
            ids.push(c.id.clone());
            c.send(meta.clone());
        }
        ids
    }

    pub fn get_client(&self, client_id: &str) -> Option<Arc<Client>> {
        self.clients.read().get(client_id).cloned()
    }

    /// Gracefully close all client connections.
    pub fn shutdown(&self) {
        let clients: Vec<Arc<Client>> = self.clients.read().values().cloned().collect();
        for c in &clients {
            c.close();
        }
        tracing::info!(clients_closed = clients.len(), "websocket manager shut down");
    }

    fn add_client(&self, c: Arc<Client>) {
        self.clients.write().insert(c.id.clone(), c);
    }

    fn remove_client(&self, client_id: &str) {
        let client = self.clients.write().remove(client_id);
        let handler = self.on_disconnect.read().clone();
        let rl = self.rate_limiter.read().clone();

        if let Some(c) = client {
            c.close();
            tracing::info!(id = %client_id, "client disconnected");
            if let Some(rl) = rl {
                if !c.remote_addr.is_empty() {
                    rl.release(&c.remote_addr);
                }
            }
            if let Some(h) = handler {
                h(client_id);
            }
        }
    }

    /// Validate a client-provided persistent ID; generate a new UUID when empty
    /// or invalid (mirrors `uuid.Parse` + `String()` normalization).
    fn resolve_client_id(&self, provided: &str) -> String {
        if provided.is_empty() {
            return Uuid::new_v4().to_string();
        }
        match Uuid::parse_str(provided) {
            Ok(u) => u.to_string(),
            Err(_) => {
                tracing::warn!(provided, "client sent invalid ID, generating new");
                Uuid::new_v4().to_string()
            }
        }
    }

    fn next_conn_index(&self, persistent_id: &str) -> i64 {
        self.clients
            .read()
            .values()
            .filter(|c| c.persistent_id == persistent_id)
            .map(|c| c.conn_index)
            .max()
            .unwrap_or(0)
            + 1
    }

    /// Send a JSON text message to a specific client.
    pub fn send_json<T: serde::Serialize>(
        &self,
        client_id: &str,
        v: &T,
    ) -> Result<(), serde_json::Error> {
        if let Some(c) = self.clients.read().get(client_id) {
            let data = serde_json::to_vec(v)?;
            c.send_text(data);
        }
        Ok(())
    }

    /// Snapshot of all connected clients for the admin API.
    pub fn get_all_clients(&self) -> Vec<ClientInfo> {
        self.clients
            .read()
            .values()
            .map(|c| ClientInfo::from_client(c))
            .collect()
    }

    fn start_stale_checker(self: &Arc<Self>) {
        if self.stale_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(5));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let Some(mgr) = weak.upgrade() else {
                    return;
                };
                let stale: Vec<Arc<Client>> = mgr
                    .clients
                    .read()
                    .values()
                    .filter(|c| c.is_stale(Duration::from_secs(10)))
                    .cloned()
                    .collect();
                drop(mgr);
                for c in stale {
                    tracing::info!(
                        id = %c.id,
                        write_queue_len = c.queue().len(),
                        write_queue_cap = c.queue().capacity(),
                        "stale client detected, disconnecting"
                    );
                    c.close();
                }
            }
        });
    }

    /// Axum handler for `/ws` upgrade requests.
    pub async fn handle_upgrade(
        State(mgr): State<Arc<WsManager>>,
        ws: WebSocketUpgrade,
        ConnectInfo(remote): ConnectInfo<SocketAddr>,
        headers: HeaderMap,
        Query(query): Query<UpgradeQuery>,
    ) -> Response {
        let remote_ip = remote.ip().to_string();
        let (client_ip, raw_ip) = mgr.resolve_client_ip_full(&headers, &remote_ip);

        if let Some(rl) = mgr.rate_limiter() {
            if !rl.allow(&client_ip) {
                tracing::warn!(ip = %client_ip, "websocket connection rate limited");
                return (StatusCode::TOO_MANY_REQUESTS, "Too Many Requests").into_response();
            }
        }

        let provided = query.client_id.clone();
        ws.on_upgrade(move |socket| async move {
            mgr.serve_client(socket, provided, client_ip, raw_ip).await;
        })
    }

    async fn serve_client(
        self: Arc<Self>,
        socket: WebSocket,
        provided_id: Option<String>,
        client_ip: String,
        raw_ip: String,
    ) {
        let conn_id = Uuid::new_v4().to_string();
        let persistent_id = self.resolve_client_id(provided_id.as_deref().unwrap_or(""));
        let conn_index = self.next_conn_index(&persistent_id);

        let client = Arc::new(
            Client::new(
                conn_id.clone(),
                persistent_id.clone(),
                conn_index,
                client_ip.clone(),
                raw_ip.clone(),
                self.write_chan_cap(),
            )
            .with_traffic(self.total_bytes.clone()),
        );

        self.add_client(client.clone());
        tracing::info!(
            conn_id = %conn_id,
            persistent_id = %persistent_id,
            remote = %client_ip,
            real_ip = %raw_ip,
            "client connected"
        );

        self.start_stale_checker();

        // Welcome message with capabilities and the authoritative client ID.
        let (allowed_fft, allowed_iq) = {
            let allowed = self.allowed.read();
            let mut fft: Vec<String> = allowed.fft.iter().cloned().collect();
            let mut iq: Vec<String> = allowed.iq.iter().cloned().collect();
            fft.sort();
            iq.sort();
            (fft, iq)
        };
        client.send(pack_meta_message(&ServerMeta {
            msg_type: "welcome".into(),
            client_id: Some(persistent_id),
            conn_index: Some(conn_index),
            server_version: Some(SERVER_VERSION.into()),
            allowed_fft_codecs: Some(allowed_fft),
            allowed_iq_codecs: Some(allowed_iq),
            ..Default::default()
        }));

        if let Some(h) = self.on_connect.read().clone() {
            h(&conn_id);
        }

        let (sink, stream) = socket.split();
        let write_task = tokio::spawn(self.clone().write_loop(client.clone(), sink));
        let read_task = tokio::spawn(self.clone().read_loop(client.clone(), stream));

        tokio::select! {
            _ = write_task => {},
            _ = read_task => {},
        }

        client.close();
        self.remove_client(&conn_id);
    }

    async fn read_loop<S>(self: Arc<Self>, client: Arc<Client>, mut stream: S)
    where
        S: futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin,
    {
        let mut cancel = client.subscribe_cancel();
        loop {
            tokio::select! {
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        break;
                    }
                }
                item = stream.next() => {
                    let Some(Ok(msg)) = item else { break };
                    match msg {
                        Message::Text(text) => {
                            client.touch();
                            self.handle_text(&client, text.as_str());
                        }
                        Message::Binary(_) => {
                            client.touch();
                            tracing::warn!(id = %client.id, "unexpected binary message from client");
                        }
                        Message::Ping(_) | Message::Pong(_) => {
                            client.touch();
                        }
                        Message::Close(_) => break,
                    }
                }
            }
        }
        client.close();
    }

    fn handle_text(self: &Arc<Self>, client: &Arc<Client>, text: &str) {
        let cmd = match parse_client_command(text.as_bytes()) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(id = %client.id, error = %e, raw = text, "invalid command from client");
                return;
            }
        };

        let allowed = self.allowed.read().clone();
        if let Some(status) = client.update_from_command(&cmd, &allowed) {
            client.send(pack_codec_status_message(&status));
        }

        if let Some(h) = self.on_command.read().clone() {
            h(&client.id, &cmd);
        }

        tracing::debug!(
            id = %client.id,
            cmd = %cmd.cmd,
            dongle = %client.subscribed_to(),
            "client command"
        );
    }

    async fn write_loop<S>(self: Arc<Self>, client: Arc<Client>, mut sink: S)
    where
        S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
    {
        let mut cancel: watch::Receiver<bool> = client.subscribe_cancel();
        let mut ping = tokio::time::interval(Duration::from_secs(15));
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick completes immediately; consume it.
        ping.tick().await;

        loop {
            tokio::select! {
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    // Go uses conn.Ping with a 10s timeout; approximate the
                    // same behaviour by requiring a frame within 25 seconds.
                    if client.last_seen_elapsed() > Duration::from_secs(25) {
                        tracing::debug!(id = %client.id, "ping timeout, disconnecting client");
                        client.close();
                        break;
                    }
                    if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
                msg = client.queue().wait_pop() => {
                    let Some(out) = msg else { break };
                    let frame_len = out.data.len() as u64;
                    let frame = if out.binary {
                        Message::Binary(out.data.into())
                    } else {
                        Message::Text(String::from_utf8_lossy(&out.data).into_owned().into())
                    };
                    if sink.send(frame).await.is_err() {
                        tracing::debug!(id = %client.id, "write error, disconnecting client");
                        break;
                    }
                    client.add_bytes_written(frame_len);
                }
            }
        }

        let _ = sink
            .send(Message::Close(Some(CloseFrame {
                code: 1000,
                reason: "".into(),
            })))
            .await;
        client.close();
    }
}

/// Shared handle used by the router and the rest of the server.
pub type SharedWsManager = Arc<WsManager>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ws::client::AllowedCodecs;
    use crate::ws::protocol::{pack_fft_compressed_message, MSG_META};
    use axum::routing::get;
    use axum::Router;
    fn test_client(mgr: &WsManager, id: &str, persistent: &str) -> Arc<Client> {
        Arc::new(Client::new(
            id.into(),
            persistent.into(),
            1,
            "1.2.3.4".into(),
            String::new(),
            mgr.write_chan_cap(),
        ))
    }

    #[test]
    fn starts_empty_and_resolves_ids() {
        let mgr = WsManager::new();
        assert_eq!(mgr.client_count(), 0);

        let valid = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(mgr.resolve_client_id(valid), valid);
        assert_eq!(
            mgr.resolve_client_id("550E8400E29B41D4A716446655440000"),
            valid
        );
        let generated = mgr.resolve_client_id("not-a-uuid");
        assert_eq!(generated.len(), 36);
        assert_ne!(mgr.resolve_client_id(""), mgr.resolve_client_id(""));
    }

    #[test]
    fn conn_index_counts_existing() {
        let mgr = WsManager::new();
        assert_eq!(mgr.next_conn_index("p"), 1);
        let mut c = Client::new(
            "a".into(),
            "p".into(),
            1,
            String::new(),
            String::new(),
            8,
        );
        // conn_index is immutable; rebuild with index 3.
        c.conn_index = 1;
        mgr.add_client(Arc::new(c));
        let mut c2 = Client::new(
            "b".into(),
            "p".into(),
            3,
            String::new(),
            String::new(),
            8,
        );
        c2.conn_index = 3;
        mgr.add_client(Arc::new(c2));
        assert_eq!(mgr.next_conn_index("p"), 4);
        assert_eq!(mgr.next_conn_index("other"), 1);
    }

    #[test]
    fn write_channel_capacity() {
        let mgr = WsManager::new();
        assert_eq!(mgr.write_chan_cap(), 154);
        mgr.set_max_fft_fps(60);
        assert_eq!(mgr.write_chan_cap(), 244);
        mgr.set_max_fft_fps(0);
        assert_eq!(mgr.write_chan_cap(), 154);
    }

    #[test]
    fn broadcast_only_subscribed() {
        let mgr = WsManager::new();
        let a = test_client(&mgr, "a", "pa");
        let b = test_client(&mgr, "b", "pb");
        let allowed = AllowedCodecs::default();
        a.update_from_command(
            &serde_json::from_str(r#"{"cmd":"subscribe","dongleId":"dongle-a"}"#).unwrap(),
            &allowed,
        );
        b.update_from_command(
            &serde_json::from_str(r#"{"cmd":"subscribe","dongleId":"dongle-b"}"#).unwrap(),
            &allowed,
        );
        mgr.add_client(a.clone());
        mgr.add_client(b.clone());

        mgr.broadcast("dongle-a", pack_fft_compressed_message(&[1, 2, 3], -100, 0));

        assert_eq!(a.queue().len(), 1);
        assert_eq!(b.queue().len(), 0);
        let msg = a.queue().pop().unwrap();
        assert!(msg.binary);
        assert_eq!(msg.data[0], 0x04);
    }

    #[test]
    fn unsubscribe_from_dongle_sends_meta() {
        let mgr = WsManager::new();
        let a = test_client(&mgr, "a", "pa");
        a.update_from_command(
            &serde_json::from_str(r#"{"cmd":"subscribe","dongleId":"d1"}"#).unwrap(),
            &AllowedCodecs::default(),
        );
        mgr.add_client(a.clone());

        let ids = mgr.unsubscribe_from_dongle("d1", "reinitialising");
        assert_eq!(ids, vec!["a".to_string()]);
        assert!(a.subscribed_to().is_empty());
        let msg = a.queue().pop().unwrap();
        assert_eq!(msg.data[0], MSG_META);
        let meta: serde_json::Value = serde_json::from_slice(&msg.data[1..]).unwrap();
        assert_eq!(meta["type"], "dongle_disconnected");
        assert_eq!(meta["dongleId"], "d1");
        assert_eq!(meta["message"], "reinitialising");
    }

    #[test]
    fn real_ip_resolution() {
        let mgr = WsManager::new();
        let mut headers = HeaderMap::new();
        assert_eq!(
            mgr.resolve_client_ip_full(&headers, "10.0.0.1"),
            ("10.0.0.1".to_string(), String::new())
        );

        mgr.set_real_ip_header("X-Forwarded-For");
        headers.insert(
            "x-forwarded-for",
            "203.0.113.7, 10.0.0.2, 10.0.0.3".parse().unwrap(),
        );
        assert_eq!(
            mgr.resolve_client_ip_full(&headers, "10.0.0.1"),
            (
                "203.0.113.7".to_string(),
                "203.0.113.7, 10.0.0.2, 10.0.0.3".to_string()
            )
        );

        // Missing header falls back to the TCP address.
        let empty = HeaderMap::new();
        assert_eq!(
            mgr.resolve_client_ip_full(&empty, "10.0.0.1"),
            ("10.0.0.1".to_string(), String::new())
        );
    }

    #[test]
    fn rate_limit_releases_on_remove() {
        let mgr = WsManager::new();
        let rl = Arc::new(RateLimiter::new(1));
        mgr.set_rate_limiter(rl.clone());
        let c = test_client(&mgr, "a", "pa");
        mgr.add_client(c.clone());
        assert!(rl.allow(&c.remote_addr));
        assert_eq!(rl.count("1.2.3.4"), 1);
        mgr.remove_client("a");
        assert_eq!(rl.count("1.2.3.4"), 0);
        assert_eq!(mgr.client_count(), 0);
    }

    #[tokio::test]
    async fn websocket_end_to_end() {
        let mgr = Arc::new(WsManager::new());
        mgr.set_max_fft_fps(30);

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, ClientCommand)>();
        mgr.set_command_handler(move |id, cmd| {
            let _ = tx.send((id.to_string(), cmd.clone()));
        });

        let app = Router::new()
            .route("/ws", get(WsManager::handle_upgrade))
            .with_state(mgr.clone());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });

        let url = format!("ws://{addr}/ws?clientId=550e8400-e29b-41d4-a716-446655440000");
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();

        // Welcome message.
        let welcome = socket.next().await.unwrap().unwrap();
        let data = match welcome {
            tokio_tungstenite::tungstenite::Message::Binary(b) => b.to_vec(),
            other => panic!("expected binary welcome, got {other:?}"),
        };
        assert_eq!(data[0], MSG_META);
        let meta: serde_json::Value = serde_json::from_slice(&data[1..]).unwrap();
        assert_eq!(meta["type"], "welcome");
        assert_eq!(meta["clientId"], "550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(meta["connIndex"], 1);
        assert_eq!(meta["serverVersion"], "2.11.3");

        // Wait until the manager registers the client.
        for _ in 0..100 {
            if mgr.client_count() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(mgr.client_count(), 1);

        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"cmd":"subscribe","dongleId":"dongle-1"}"#.into(),
            ))
            .await
            .unwrap();

        let (id, cmd) = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cmd.cmd, "subscribe");
        assert_eq!(cmd.dongle_id, "dongle-1");
        assert_eq!(mgr.get_client(&id).unwrap().subscribed_to(), "dongle-1");

        // Broadcast reaches the subscribed client.
        let payload = pack_fft_compressed_message(&[9, 8, 7], -90, -10);
        mgr.broadcast("dongle-1", payload.clone());
        let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match frame {
            tokio_tungstenite::tungstenite::Message::Binary(b) => {
                assert_eq!(b.to_vec(), payload)
            }
            other => panic!("expected binary broadcast, got {other:?}"),
        }

        // Closing the client removes it from the manager.
        socket.close(None).await.unwrap();
        for _ in 0..200 {
            if mgr.client_count() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(mgr.client_count(), 0);

        server.abort();
    }
}
