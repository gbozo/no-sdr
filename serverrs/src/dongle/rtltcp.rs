//! rtl_tcp (and compatible) network IQ sources.
//!
//! Ported from the original Go backend and its RSP handling.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedReadHalf;
use tokio::net::TcpStream;
use tokio::process::{Child, Command as ProcessCommand};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use super::source::{CommandHandle, Source, SourceCommand};

/// The 12-byte header sent by rtl_tcp on connect.
#[derive(Debug, Clone, Copy, Default)]
pub struct RtlDongleInfo {
    pub magic: [u8; 4],
    pub tuner_type: u32,
    pub tuner_gains: u32,
}

/// Connects to a remote rtl_tcp server.
pub struct RtlTcpSource {
    host: String,
    port: u16,
    kind: String,
    reader: Option<OwnedReadHalf>,
    cmd_tx: mpsc::UnboundedSender<SourceCommand>,
    writer_task: Option<JoinHandle<()>>,
    info: RtlDongleInfo,
    child: Option<Child>,
}

impl RtlTcpSource {
    /// Connects and reads the 12-byte `RTL0` header.
    pub async fn connect(host: &str, port: i32) -> Result<Self> {
        Self::connect_kind(host, port, "rtl_tcp").await
    }

    /// Connects using a display kind (`rtl_tcp`, `rsp_tcp`, `airspy_tcp`, ...).
    pub async fn connect_kind(host: &str, port: i32, kind: &str) -> Result<Self> {
        let host = if host.is_empty() { "127.0.0.1" } else { host };
        let port = if port <= 0 { 1234 } else { port as u16 };
        let addr = format!("{host}:{port}");

        let mut stream = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(&addr))
            .await
            .map_err(|_| anyhow::anyhow!("rtl_tcp connect to {addr}: timeout"))?
            .with_context(|| format!("rtl_tcp connect to {addr}"))?;

        let mut header = [0u8; 12];
        tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut header))
            .await
            .map_err(|_| anyhow::anyhow!("rtl_tcp read header: timeout"))?
            .context("rtl_tcp read header")?;

        let info = RtlDongleInfo {
            magic: [header[0], header[1], header[2], header[3]],
            tuner_type: u32::from_be_bytes([header[4], header[5], header[6], header[7]]),
            tuner_gains: u32::from_be_bytes([header[8], header[9], header[10], header[11]]),
        };

        if info.magic != *b"RTL0" {
            bail!(
                "rtl_tcp invalid magic: {:?} (expected RTL0)",
                info.magic
            );
        }

        info!(
            addr = %addr,
            tuner_type = info.tuner_type,
            tuner_gains = info.tuner_gains,
            "rtl_tcp connected"
        );

        let (mut read_half, mut write_half) = stream.into_split();
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<SourceCommand>();

        let writer_task = tokio::spawn(async move {
            while let Some(cmd) = cmd_rx.recv().await {
                match cmd {
                    SourceCommand::Raw { cmd, value } => {
                        let mut buf = [0u8; 5];
                        buf[0] = cmd;
                        buf[1..].copy_from_slice(&value.to_be_bytes());
                        if let Err(e) = write_half.write_all(&buf).await {
                            warn!(error = %e, cmd = cmd, "rtl_tcp write command failed");
                            return;
                        }
                    }
                    SourceCommand::Close => return,
                }
            }
        });

        // Keep the read half alive; `mut` silences an unused-mut warning while
        // documenting that reads advance the stream.
        let _ = &mut read_half;

        Ok(Self {
            host: host.to_string(),
            port,
            kind: kind.to_string(),
            reader: Some(read_half),
            cmd_tx,
            writer_task: Some(writer_task),
            info,
            child: None,
        })
    }

    /// Attaches a spawned rtl_tcp child process so it is killed on drop.
    pub fn with_child(mut self, child: Child) -> Self {
        self.child = Some(child);
        self
    }

    pub fn dongle_info(&self) -> RtlDongleInfo {
        self.info
    }

    pub fn addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[async_trait]
impl Source for RtlTcpSource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let mut reader = match this.reader.take() {
            Some(r) => r,
            None => {
                error!("rtl_tcp Run called without connection");
                return;
            }
        };

        const CHUNK_SIZE: usize = 16384; // ~3.4ms at 2.4 MSPS
        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut cancel = cancel;

        loop {
            tokio::select! {
                _ = cancel.changed() => return,
                result = tokio::time::timeout(
                    Duration::from_millis(500),
                    reader.read_exact(&mut buf),
                ) => {
                    match result {
                        Err(_) => continue, // read timeout — check cancellation
                        Ok(Err(e)) => {
                            error!(error = %e, "rtl_tcp read error");
                            return;
                        }
                        Ok(Ok(n)) => {
                            let chunk = buf[..n].to_vec();
                            if out.send(chunk).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            }
        }
    }

    fn command_handle(&self) -> Option<CommandHandle> {
        Some(CommandHandle::new(self.cmd_tx.clone()))
    }

    fn description(&self) -> String {
        format!("{} ({}:{})", self.kind, self.host, self.port)
    }
}

impl Drop for RtlTcpSource {
    fn drop(&mut self) {
        if let Some(task) = self.writer_task.take() {
            task.abort();
        }
        if let Some(mut child) = self.child.take() {
            if let Err(e) = child.start_kill() {
                warn!(error = %e, "failed to kill spawned rtl_tcp process");
            }
        }
    }
}

/// Spawns an `rtl_tcp` process and waits briefly for its port to accept
/// connections. Errors are returned to the caller (the Go manager logs them
/// and proceeds without a spawned process).
pub async fn spawn_rtl_tcp(
    binary: &str,
    host: &str,
    port: i32,
    extra_args: &[String],
) -> Result<Child> {
    let binary = if binary.is_empty() { "rtl_tcp" } else { binary };
    let port = if port <= 0 { 1234 } else { port };

    let mut cmd = ProcessCommand::new(binary);
    cmd.arg("-a").arg(host);
    cmd.arg("-p").arg(port.to_string());
    cmd.args(extra_args);
    cmd.kill_on_drop(true);

    info!(binary, host, port, "spawning rtl_tcp");
    let child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn {binary}"))?;

    let addr = format!("{host}:{port}");
    for _ in 0..30 {
        match tokio::time::timeout(Duration::from_millis(100), TcpStream::connect(&addr)).await {
            Ok(Ok(_)) => {
                info!(addr, "rtl_tcp port ready");
                break;
            }
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }

    Ok(child)
}
