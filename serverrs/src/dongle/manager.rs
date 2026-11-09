//! Dongle lifecycle manager.
//!
//! Mirrors `serverng/internal/dongle/manager.go` and `notifications.go`:
//! owns running dongles, their FFT/IQ processing loops, and per-client
//! pipelines (sub-band extraction, ADPCM or server-side Opus encoding).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};

use crate::codec::adpcm::encode_fft_adpcm;
use crate::codec::fft::compress_fft;
use crate::codec::{FftDeflateEncoder, ImaAdpcmEncoder};
use crate::config::{Config, DongleConfig, DongleProfile};
use crate::dsp::{FftProcessor, FftProcessorConfig, IqCorrect, IqExtractor, IqExtractorConfig};
use crate::history::FftBuffer;
use crate::ws::{
    pack_audio_opus_message, pack_codec_status_message, pack_fft_adpcm_message,
    pack_fft_compressed_message, pack_iq_adpcm_message, pack_iq_message, pack_meta_message,
    pack_rds_message, ClientCommand, CodecStatus, ServerMeta, WsManager, MSG_META,
};

use super::demo::{DemoConfig, DemoSource};
use super::opus_pipeline::{bitrate_for_quality, OpusPipeline, OpusPipelineConfig};
use super::recorder::{Recorder, RecordingStatus};
#[cfg(feature = "rtlsdr")]
use super::rtlsdr::RtlSdrSource;
use super::rtltcp::{spawn_rtl_tcp, RtlTcpSource};
use super::source::{CommandHandle, Source};

pub const STATUS_STOPPED: &str = "stopped";
pub const STATUS_STARTING: &str = "starting";
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_RETRYING: &str = "retrying";
pub const STATUS_ERROR: &str = "error";

const MAX_RETRIES: i32 = 5;
const MAX_ADMIN_AUTH_FAILURES: u32 = 5;

fn retry_backoff(attempt: i32) -> Duration {
    let secs = 1u64 << attempt.clamp(0, 4);
    Duration::from_secs(secs.min(16))
}

/// Lifecycle state of a dongle.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DongleState {
    pub status: String,
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub retry_count: i32,
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub max_retries: i32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_error: String,
}

fn is_zero_i32(v: &i32) -> bool {
    *v == 0
}

impl DongleState {
    fn stopped() -> Self {
        Self {
            status: STATUS_STOPPED.to_string(),
            ..Default::default()
        }
    }
}

/// Public view of a configured dongle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DongleInfo {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub source_type: String,
    pub sample_rate: i32,
    pub client_count: usize,
    pub profiles: Vec<DongleProfile>,
    pub state: DongleState,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub active_profile: String,
}

/// Public view of server settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigInfo {
    pub callsign: String,
    pub description: String,
    pub location: String,
    pub demo_mode: bool,
}

/// Generic config-change notification sent as a META message.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigNotification {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub dongle_id: String,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dongle: Option<DongleInfo>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<DongleProfile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<DongleProfile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dongles: Vec<DongleInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<ServerConfigInfo>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<DongleState>,
}

fn is_zero_u64(v: &u64) -> bool {
    *v == 0
}

fn pack_notification(n: &ConfigNotification) -> Vec<u8> {
    let bytes = serde_json::to_vec(n).unwrap_or_default();
    let mut out = Vec::with_capacity(1 + bytes.len());
    out.push(MSG_META);
    out.extend_from_slice(&bytes);
    out
}

/// A running dongle instance.
struct ActiveDongle {
    id: String,
    profile: RwLock<DongleProfile>,
    command: Option<CommandHandle>,
    fft_proc: Mutex<FftProcessor>,
    deflate_enc: Mutex<FftDeflateEncoder>,
    deflate_floor_enc: Mutex<FftDeflateEncoder>,
    history: FftBuffer,
    iq_correct: Mutex<Option<IqCorrect>>,
    cancel: watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
}

/// Per-client IQ extraction + encoding pipeline.
struct ClientPipeline {
    extractor: IqExtractor,
    adpcm_enc: ImaAdpcmEncoder,
    opus_pipeline: Option<OpusPipeline>,
    sub_band: Vec<i16>,
    accum_buf: Vec<i16>,
    accum_pos: usize,
    chunk_size: usize,
    iq_codec: String,
    dongle_id: String,
    nb_enabled: bool,
    nb_threshold: f32,
    iq_chunk_count: u64,
    stereo_enabled: bool,
    adpcm_buf: Vec<u8>,
}

/// Shared dongle manager.
pub struct Manager {
    pub cfg: Arc<RwLock<Config>>,
    pub ws: Arc<WsManager>,
    dongles: RwLock<HashMap<String, Arc<ActiveDongle>>>,
    dongle_states: Mutex<HashMap<String, DongleState>>,
    client_pipelines: Mutex<HashMap<String, Arc<Mutex<ClientPipeline>>>>,
    /// Last per-dongle subscribed-client counts, used to broadcast
    /// `dongle_status` only when a count actually changes.
    last_client_counts: Mutex<HashMap<String, usize>>,
    recorder: Recorder,
    get_version: Mutex<Option<Arc<dyn Fn() -> u64 + Send + Sync>>>,
    identify_token_func:
        Mutex<Option<Arc<dyn Fn(&str, &str, Vec<f32>) -> (String, String) + Send + Sync>>>,
}

impl Manager {
    /// Creates the manager and registers WebSocket handlers.
    pub fn new(cfg: Arc<RwLock<Config>>, ws: Arc<WsManager>) -> Arc<Self> {
        let mut states = HashMap::new();
        {
            let cfg = cfg.read();
            for d in &cfg.dongles {
                states.insert(d.id.clone(), DongleState::stopped());
            }
        }

        let mgr = Arc::new(Self {
            cfg,
            ws: ws.clone(),
            dongles: RwLock::new(HashMap::new()),
            dongle_states: Mutex::new(states),
            client_pipelines: Mutex::new(HashMap::new()),
            last_client_counts: Mutex::new(HashMap::new()),
            recorder: Recorder::new("recordings"),
            get_version: Mutex::new(None),
            identify_token_func: Mutex::new(None),
        });

        let weak = Arc::downgrade(&mgr);
        ws.set_command_handler(move |client_id, cmd| {
            if let Some(m) = weak.upgrade() {
                m.handle_command(client_id, cmd);
            }
        });
        let weak = Arc::downgrade(&mgr);
        ws.set_disconnect_handler(move |client_id| {
            if let Some(m) = weak.upgrade() {
                m.destroy_client_pipeline(client_id);
            }
        });
        let weak = Arc::downgrade(&mgr);
        ws.set_connect_handler(move |client_id| {
            if let Some(m) = weak.upgrade() {
                m.send_state_sync(client_id);
            }
        });

        mgr
    }

    pub fn set_version_func<F>(&self, f: F)
    where
        F: Fn() -> u64 + Send + Sync + 'static,
    {
        *self.get_version.lock() = Some(Arc::new(f));
    }

    pub fn set_identify_token_func<F>(&self, f: F)
    where
        F: Fn(&str, &str, Vec<f32>) -> (String, String) + Send + Sync + 'static,
    {
        *self.identify_token_func.lock() = Some(Arc::new(f));
    }

    pub fn current_version(&self) -> u64 {
        self.get_version.lock().as_ref().map(|f| f()).unwrap_or(0)
    }

    pub fn recorder(&self) -> &Recorder {
        &self.recorder
    }

    /// Starts all enabled dongles with `autoStart`, then the stats loop.
    pub fn start(self: &Arc<Self>) {
        let mgr = Arc::clone(self);
        tokio::spawn(async move {
            let dongles: Vec<DongleConfig> = mgr.cfg.read().dongles.clone();
            for dcfg in dongles {
                if !dcfg.enabled || !dcfg.auto_start {
                    info!(id = %dcfg.id, "skipping dongle");
                    continue;
                }
                if dcfg.profiles.is_empty() {
                    warn!(id = %dcfg.id, "dongle has no profiles, skipping");
                    continue;
                }
                if let Err(e) = mgr.start_dongle_with_retry(dcfg.clone()).await {
                    error!(id = %dcfg.id, error = %e, "dongle failed after all retries");
                }
            }
            mgr.spawn_stats_loop();
        });
    }

    /// Stops every dongle and closes all client pipelines.
    pub fn stop(&self) {
        let dongles: Vec<Arc<ActiveDongle>> = self.dongles.write().drain().map(|(_, d)| d).collect();
        for d in dongles {
            let _ = d.cancel.send(true);
            if let Some(task) = d.task.lock().take() {
                task.abort();
            }
        }

        let mut pipelines = self.client_pipelines.lock();
        for (_, cp) in pipelines.drain() {
            let mut cp = cp.lock();
            if let Some(opus) = cp.opus_pipeline.as_mut() {
                opus.close();
            }
        }
    }

    // ------------------------------------------------------------------
    // Dongle lifecycle
    // ------------------------------------------------------------------

    async fn start_dongle_with_retry(self: &Arc<Self>, dcfg: DongleConfig) -> Result<()> {
        self.set_state(
            &dcfg.id,
            DongleState {
                status: STATUS_STARTING.to_string(),
                ..Default::default()
            },
        );

        let mut last_error = String::new();
        for attempt in 0..=MAX_RETRIES {
            if attempt > 0 {
                self.set_state(
                    &dcfg.id,
                    DongleState {
                        status: STATUS_RETRYING.to_string(),
                        retry_count: attempt,
                        max_retries: MAX_RETRIES,
                        last_error: last_error.clone(),
                    },
                );
                tokio::time::sleep(retry_backoff(attempt - 1)).await;
            }
            match self.start_dongle(dcfg.clone()).await {
                Ok(()) => {
                    self.set_state(
                        &dcfg.id,
                        DongleState {
                            status: STATUS_RUNNING.to_string(),
                            ..Default::default()
                        },
                    );
                    self.notify_dongle_started(&dcfg.id);
                    return Ok(());
                }
                Err(e) => {
                    last_error = e.to_string();
                    error!(id = %dcfg.id, attempt, error = %e, "dongle start attempt failed");
                }
            }
        }

        self.set_state(
            &dcfg.id,
            DongleState {
                status: STATUS_ERROR.to_string(),
                retry_count: MAX_RETRIES,
                max_retries: MAX_RETRIES,
                last_error: last_error.clone(),
            },
        );
        self.notify_dongle_error(&dcfg.id, &last_error);
        bail!(
            "dongle {}: all {} attempts failed: {}",
            dcfg.id,
            MAX_RETRIES,
            last_error
        );
    }

    async fn start_dongle(self: &Arc<Self>, dcfg: DongleConfig) -> Result<()> {
        let id = dcfg.id.clone();
        if self.dongles.read().contains_key(&id) {
            bail!("dongle {id} is already running");
        }

        let profile = dcfg
            .profiles
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("dongle {id} has no profiles"))?;

        let sample_rate = if profile.sample_rate > 0 {
            profile.sample_rate
        } else if dcfg.sample_rate > 0 {
            dcfg.sample_rate
        } else {
            2_400_000
        };

        let fft_size = if profile.fft_size > 0 {
            profile.fft_size as usize
        } else {
            4096
        };
        let fft_fps = if profile.fft_fps > 0 {
            profile.fft_fps
        } else {
            30
        };
        // Building the rustfft plan and, more importantly, pre-allocating the
        // 1024-frame waterfall history (32 MB at 8192 bins) is CPU/allocation
        // heavy. Keep it off the async workers so an admin-triggered reinit
        // cannot stall HTTP/WebSocket service while the dongle restarts.
        let (fft_proc, deflate_enc, deflate_floor_enc, history) =
            tokio::task::spawn_blocking(move || -> Result<_> {
                let fft_proc = FftProcessor::new(FftProcessorConfig {
                    fft_size,
                    sample_rate,
                    window: "blackman-harris".to_string(),
                    averaging: 0.5,
                    averaging_taps: 0,
                    target_fps: fft_fps,
                })?;
                let deflate_enc = FftDeflateEncoder::new(fft_size);
                let deflate_floor_enc = FftDeflateEncoder::new(fft_size);
                let history = FftBuffer::new(1024);
                history.init_frames(fft_size);
                Ok((fft_proc, deflate_enc, deflate_floor_enc, history))
            })
            .await
            .map_err(|e| anyhow!("dongle DSP init task failed: {e}"))??;

        let (source, command) = self
            .create_source(&dcfg, &profile)
            .await
            .map_err(|e| anyhow!("create source for dongle {id}: {e}"))?;

        let (cancel, cancel_rx) = watch::channel(false);
        let ad = Arc::new(ActiveDongle {
            id: id.clone(),
            profile: RwLock::new(profile),
            command,
            fft_proc: Mutex::new(fft_proc),
            deflate_enc: Mutex::new(deflate_enc),
            deflate_floor_enc: Mutex::new(deflate_floor_enc),
            history,
            iq_correct: Mutex::new(if dcfg.iq_correction {
                Some(IqCorrect::new(sample_rate as f64, 10.0, true))
            } else {
                None
            }),
            cancel,
            task: Mutex::new(None),
        });

        self.dongles.write().insert(id.clone(), ad.clone());

        let mgr = Arc::clone(self);
        let ad_task = ad.clone();
        let task = tokio::spawn(async move {
            mgr.run_dongle(ad_task, source, cancel_rx).await;
        });
        *ad.task.lock() = Some(task);

        info!(id = %id, "dongle started");
        Ok(())
    }

    async fn create_source(
        &self,
        dcfg: &DongleConfig,
        profile: &DongleProfile,
    ) -> Result<(Box<dyn Source>, Option<CommandHandle>)> {
        let mut source_type = dcfg.source.kind.clone();
        if source_type.is_empty() {
            source_type = "demo".to_string();
        }
        if self.cfg.read().server.demo_mode {
            source_type = "demo".to_string();
        }

        let sample_rate = if profile.sample_rate > 0 {
            profile.sample_rate
        } else if dcfg.sample_rate > 0 {
            dcfg.sample_rate
        } else {
            2_400_000
        };

        match source_type.as_str() {
            "demo" => {
                let source = DemoSource::new(DemoConfig {
                    sample_rate,
                    signals: Vec::new(),
                });
                Ok((Box::new(source), None))
            }
            kind @ ("rtl_tcp" | "airspy_tcp" | "hfp_tcp" | "rsp_tcp") => {
                let mut child = None;
                if dcfg.source.spawn_rtl_tcp {
                    match spawn_rtl_tcp(
                        &dcfg.source.binary,
                        &dcfg.source.host,
                        dcfg.source.port,
                        &dcfg.source.extra_args,
                    )
                    .await
                    {
                        Ok(c) => child = Some(c),
                        Err(e) => warn!(error = %e, "failed to spawn rtl_tcp; connecting to existing"),
                    }
                }

                let host = if dcfg.source.host.is_empty() {
                    "127.0.0.1"
                } else {
                    dcfg.source.host.as_str()
                };
                let port = if dcfg.source.port <= 0 {
                    1234
                } else {
                    dcfg.source.port
                };

                let mut source = RtlTcpSource::connect_kind(host, port, kind)
                    .await
                    .map_err(|e| anyhow!("{kind} connect: {e}"))?;
                if let Some(c) = child {
                    source = source.with_child(c);
                }

                let command = Source::command_handle(&source);
                if let Some(cmd) = &command {
                    self.apply_dongle_settings(cmd, dcfg, profile);
                }
                Ok((Box::new(source), command))
            }
            "local" => {
                #[cfg(feature = "rtlsdr")]
                {
                    // USB enumeration/open/reset is blocking; keep it off the
                    // async workers so an admin-triggered reinit cannot stall
                    // HTTP/WebSocket service on a small (1-vCPU) host.
                    let device_index = dcfg.source.device_index;
                    let serial = dcfg.source.serial.clone();
                    let source = tokio::task::spawn_blocking(move || {
                        RtlSdrSource::open(device_index, &serial)
                    })
                    .await
                    .map_err(|e| anyhow!("local rtlsdr open task failed: {e}"))??;
                    let command = Source::command_handle(&source);
                    if let Some(cmd) = &command {
                        self.apply_dongle_settings(cmd, dcfg, profile);
                    }
                    Ok((Box::new(source), command))
                }
                #[cfg(not(feature = "rtlsdr"))]
                {
                    bail!(
                        "local rtlsdr support is not compiled in (build with --features rtlsdr)"
                    )
                }
            }
            other => bail!("unsupported source type: {other}"),
        }
    }

    fn apply_dongle_settings(
        &self,
        cmd: &CommandHandle,
        dcfg: &DongleConfig,
        profile: &DongleProfile,
    ) {
        let _ = cmd.set_frequency(
            (profile.center_frequency + profile.oscillator_offset as i64) as u32,
        );
        if profile.sample_rate > 0 {
            let _ = cmd.set_sample_rate(profile.sample_rate as u32);
        }
        if profile.gain > 0.0 {
            let _ = cmd.set_gain_mode(1);
            let _ = cmd.set_gain((profile.gain * 10.0) as u32);
        } else if dcfg.gain > 0.0 {
            let _ = cmd.set_gain_mode(1);
            let _ = cmd.set_gain((dcfg.gain * 10.0) as u32);
        }
        if dcfg.ppm != 0 {
            let _ = cmd.set_frequency_correction(dcfg.ppm as u32);
        }
        let direct_sampling = if profile.direct_sampling != 0 {
            profile.direct_sampling
        } else {
            dcfg.direct_sampling
        };
        let _ = cmd.set_direct_sampling(direct_sampling as u32);
        let _ = cmd.set_bias_t(dcfg.bias_t as u32);
        let _ = cmd.set_agc_mode(dcfg.digital_agc as u32);
        let _ = cmd.set_offset_tuning(dcfg.offset_tuning as u32);
    }

    async fn run_dongle(
        self: Arc<Self>,
        ad: Arc<ActiveDongle>,
        source: Box<dyn Source>,
        mut cancel: watch::Receiver<bool>,
    ) {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        let src_cancel = cancel.clone();
        let src = source.run(tx, src_cancel);
        tokio::pin!(src);

        loop {
            tokio::select! {
                _ = cancel.changed() => break,
                _ = &mut src => break,
                maybe = rx.recv() => {
                    match maybe {
                        Some(chunk) => self.handle_iq_chunk(&ad, chunk),
                        None => break,
                    }
                }
            }
        }
        debug!(id = %ad.id, "dongle run loop ended");
    }

    fn handle_iq_chunk(&self, ad: &Arc<ActiveDongle>, mut chunk: Vec<u8>) {
        let profile = ad.profile.read().clone();

        if profile.swap_iq {
            for pair in chunk.chunks_exact_mut(2) {
                pair.swap(0, 1);
            }
        }

        self.recorder.write_iq(&ad.id, &chunk);
        self.process_client_iq(ad, &chunk);

        let frames = ad.fft_proc.lock().process_iq_data(&chunk);
        for frame in frames {
            ad.history.push(&frame);
            self.broadcast_fft_frame(ad, &frame);
        }
    }

    fn broadcast_fft_frame(&self, ad: &Arc<ActiveDongle>, frame: &[f32]) {
        const MIN_DB: f32 = -130.0;
        const MAX_DB: f32 = 0.0;

        let clients = self.ws.subscribed_clients(&ad.id);
        if clients.is_empty() {
            return;
        }

        let mut cache: HashMap<String, Result<Vec<u8>, String>> = HashMap::new();
        for client in clients {
            let codec = client.fft_codec();
            let key = if codec.is_empty() {
                "none".to_string()
            } else {
                codec.clone()
            };
            let msg = cache.entry(key.clone()).or_insert_with(|| {
                match key.as_str() {
                    "deflate" => ad
                        .deflate_enc
                        .lock()
                        .encode_message(crate::ws::MSG_FFT_DEFLATE, frame, MIN_DB, MAX_DB)
                        .map_err(|e| e.to_string()),
                    "deflate-floor" => ad
                        .deflate_floor_enc
                        .lock()
                        .encode_message_floor(crate::ws::MSG_FFT_DEFLATE, frame, MIN_DB, MAX_DB)
                        .map_err(|e| e.to_string()),
                    "adpcm" => Ok(pack_fft_adpcm_message(&encode_fft_adpcm(
                        frame, MIN_DB, MAX_DB,
                    ))),
                    "none" | "" => {
                        let bins = compress_fft(frame, MIN_DB, MAX_DB);
                        Ok(pack_fft_compressed_message(
                            &bins,
                            MIN_DB.round() as i16,
                            MAX_DB.round() as i16,
                        ))
                    }
                    other => Err(format!("unknown FFT codec: {other}")),
                }
            });

            match msg {
                Ok(bytes) => self.ws.send_to(&client.id, bytes.clone()),
                Err(e) => {
                    warn!(client = %client.id, codec = %key, error = %e, "FFT encode failed");
                }
            }
        }
    }

    fn process_client_iq(&self, ad: &Arc<ActiveDongle>, chunk: &[u8]) {
        let pipelines: Vec<(String, Arc<Mutex<ClientPipeline>>)> = {
            let map = self.client_pipelines.lock();
            map.iter()
                .filter(|(_, cp)| cp.lock().dongle_id == ad.id)
                .map(|(id, cp)| (id.clone(), cp.clone()))
                .collect()
        };

        for (client_id, cp) in pipelines {
            self.process_one_client(&client_id, &cp, chunk);
        }
    }

    fn process_one_client(
        &self,
        client_id: &str,
        cp: &Arc<Mutex<ClientPipeline>>,
        chunk: &[u8],
    ) {
        let mut cp = cp.lock();
        cp.iq_chunk_count += 1;
        if cp.iq_chunk_count % 500 == 0 {
            debug!(client = %client_id, chunks = cp.iq_chunk_count, "IQ chunks processed");
        }

        // Move the scratch buffer out so the extractor and the encoders can
        // hold disjoint borrows; it is returned at every exit path.
        let mut sub_band = std::mem::take(&mut cp.sub_band);
        cp.extractor.process_into(chunk, &mut sub_band);
        if sub_band.is_empty() {
            cp.sub_band = sub_band;
            return;
        }

        if let Some(opus) = cp.opus_pipeline.as_mut() {
            let results = opus.process(&sub_band);
            for r in results {
                self.ws.send_to(
                    client_id,
                    pack_audio_opus_message(&r.packet, r.samples as u16, r.channels as u8),
                );
                if let Some(rds) = r.rds_json {
                    self.ws.send_to(client_id, pack_rds_message(&rds));
                }
            }
            cp.sub_band = sub_band;
            return;
        }

        let out_rate = cp.extractor.output_sample_rate() as u32;
        let mut copied = 0;
        while copied < sub_band.len() {
            let space = cp.chunk_size.saturating_sub(cp.accum_pos);
            let n = space.min(sub_band.len() - copied);
            let pos = cp.accum_pos;
            cp.accum_buf[pos..pos + n].copy_from_slice(&sub_band[copied..copied + n]);
            cp.accum_pos += n;
            copied += n;

            if cp.accum_pos >= cp.chunk_size {
                let encoded = if cp.iq_codec == "adpcm" {
                    let cp = &mut *cp;
                    let n = cp
                        .adpcm_enc
                        .encode_into(&cp.accum_buf, &mut cp.adpcm_buf);
                    Some(n)
                } else {
                    None
                };
                match encoded {
                    Some(n) => self.ws.send_to(
                        client_id,
                        pack_iq_adpcm_message(&cp.adpcm_buf[..n], cp.chunk_size as u32, out_rate),
                    ),
                    None => self
                        .ws
                        .send_to(client_id, pack_iq_message(&cp.accum_buf, out_rate)),
                }
                cp.accum_pos = 0;
            }
        }
        cp.sub_band = sub_band;
    }

    // ------------------------------------------------------------------
    // Client pipelines
    // ------------------------------------------------------------------

    fn create_client_pipeline(&self, client_id: &str) {
        let client = match self.ws.get_client(client_id) {
            Some(c) => c,
            None => return,
        };

        let dongle_id = client.subscribed_to();
        let ad = match self.dongles.read().get(&dongle_id) {
            Some(d) => d.clone(),
            None => {
                warn!(client = %client_id, dongle = %dongle_id, "no running dongle for client");
                return;
            }
        };

        let profile = ad.profile.read().clone();
        let mode = {
            let m = client.mode();
            if m.is_empty() {
                profile.mode.clone()
            } else {
                m
            }
        };
        let output_rate = output_rate_for_mode(&mode);
        let iq_codec = {
            let c = client.iq_codec();
            if c.is_empty() {
                "none".to_string()
            } else {
                c
            }
        };
        let mut tune_offset = client.tune_offset() as i32;
        if tune_offset == 0 {
            tune_offset = profile.tune_offset;
        }
        let input_rate = if profile.sample_rate > 0 {
            profile.sample_rate
        } else {
            2_400_000
        };

        let extractor = match IqExtractor::new(IqExtractorConfig {
            input_sample_rate: input_rate,
            output_sample_rate: output_rate,
            tune_offset,
            dc_offset_removal: profile.dc_offset_removal_enabled(),
        }) {
            Ok(e) => e,
            Err(e) => {
                error!(client = %client_id, error = %e, "failed to create IQ extractor");
                return;
            }
        };

        let chunk_size = (extractor.output_sample_rate() as f64 * 2.0 * 0.020) as usize;
        let stereo_enabled = client.stereo_enabled();

        let mut cp = ClientPipeline {
            extractor,
            adpcm_enc: ImaAdpcmEncoder::new(),
            opus_pipeline: None,
            sub_band: Vec::new(),
            accum_buf: vec![0; chunk_size.max(2)],
            accum_pos: 0,
            chunk_size: chunk_size.max(2),
            iq_codec: iq_codec.clone(),
            dongle_id: dongle_id.clone(),
            nb_enabled: false,
            nb_threshold: 10.0,
            iq_chunk_count: 0,
            stereo_enabled,
            adpcm_buf: vec![0; (chunk_size + 1) / 2],
        };

        if profile.pre_filter_nb {
            cp.nb_enabled = true;
            cp.extractor.set_nb_enabled(true);
            if profile.pre_filter_nb_threshold > 0 {
                cp.nb_threshold = profile.pre_filter_nb_threshold as f32;
                cp.extractor
                    .set_nb_threshold(profile.pre_filter_nb_threshold as f32);
            }
        }

        let bandwidth = {
            let b = client.bandwidth() as i32;
            if b > 0 {
                b
            } else {
                default_bandwidth_for_mode(&mode)
            }
        };
        cp.extractor.set_bandwidth(bandwidth);

        let mut fallback_status: Option<CodecStatus> = None;
        if is_opus_codec(&iq_codec) {
            let complexity = self.cfg.read().server.opus_complexity;
            match OpusPipeline::new(OpusPipelineConfig {
                mode: mode.clone(),
                sample_rate: output_rate,
                bitrate: 0,
                stereo_enabled: Some(stereo_enabled),
                quality: iq_codec.clone(),
                complexity,
            }) {
                Ok(mut p) => {
                    // OpusPipeline starts with bandwidth 0; without this the
                    // server-side demod would run with its audio/IF filters
                    // disabled until the client sends a separate bandwidth
                    // command.
                    p.set_bandwidth(bandwidth);
                    cp.opus_pipeline = Some(p);
                }
                Err(e) => {
                    error!(client = %client_id, error = %e, "failed to create Opus pipeline; falling back to ADPCM");
                    cp.iq_codec = "adpcm".to_string();
                    fallback_status = Some(CodecStatus {
                        iq_codec: "adpcm".to_string(),
                        iq_msg: format!(
                            "codec '{iq_codec}' not available on this server, using 'adpcm': {e}"
                        ),
                        ..Default::default()
                    });
                }
            }
        }

        self.client_pipelines
            .lock()
            .insert(client_id.to_string(), Arc::new(Mutex::new(cp)));

        if let Some(status) = fallback_status {
            self.ws.set_client_iq_codec(client_id, "adpcm");
            self.ws
                .send_to(client_id, pack_codec_status_message(&status));
        }
    }

    fn destroy_client_pipeline(&self, client_id: &str) {
        let removed = self.client_pipelines.lock().remove(client_id);
        if let Some(cp) = removed {
            if let Some(mut opus) = cp.lock().opus_pipeline.take() {
                opus.close();
            }
        }
    }

    fn update_chunk_size(cp: &mut ClientPipeline, rate: i32) {
        let size = (rate as f64 * 2.0 * 0.020) as usize;
        if size > 0 && size != cp.chunk_size {
            cp.chunk_size = size;
            cp.accum_buf = vec![0; size];
            cp.adpcm_buf = vec![0; (size + 1) / 2];
            cp.accum_pos = 0;
            cp.adpcm_enc.reset();
        }
    }

    pub fn capture_pcm_for_client(&self, client_id: &str, secs: i32) -> Option<Vec<f32>> {
        let cp = self.client_pipelines.lock().get(client_id).cloned()?;
        let cp = cp.lock();
        let opus = cp.opus_pipeline.as_ref()?;
        Some(opus.capture_pcm(secs))
    }

    // ------------------------------------------------------------------
    // Commands
    // ------------------------------------------------------------------

    fn handle_command(&self, client_id: &str, cmd: &ClientCommand) {
        match cmd.cmd.as_str() {
            "subscribe" => self.handle_subscribe(client_id, cmd),
            "unsubscribe" => self.handle_unsubscribe(client_id),
            "audio_enabled" => self.handle_audio_enabled(client_id, cmd),
            "tune" => self.handle_tune(client_id, cmd),
            "bandwidth" => self.handle_bandwidth(client_id, cmd),
            "mode" => self.handle_mode(client_id, cmd),
            "codec" => {
                // A codec switch must not wait behind queued FFT frames of the
                // old codec (can be several seconds of backlog).
                if !cmd.fft_codec.is_empty() {
                    if let Some(c) = self.ws.get_client(client_id) {
                        c.drop_queued_fft();
                    }
                }
                self.handle_codec_change(client_id, cmd);
            }
            "stereo_enabled" => self.handle_stereo_enabled(client_id, cmd),
            "admin_set_profile" => self.handle_admin_set_profile(client_id, cmd),
            "admin_auth" => self.handle_admin_auth(client_id, cmd),
            "request_history" => self.handle_request_history(client_id),
            "identify_start" => self.handle_identify_start(client_id),
            "set_pre_filter_nb" => self.handle_set_pre_filter_nb(client_id, cmd),
            "set_pre_filter_nb_threshold" => {
                self.handle_set_pre_filter_nb_threshold(client_id, cmd)
            }
            "mute" | "volume" => {}
            other => debug!(client = %client_id, cmd = other, "unhandled command"),
        }
    }

    fn send_meta(&self, client_id: &str, meta: ServerMeta) {
        self.ws.send_to(client_id, pack_meta_message(&meta));
    }

    fn send_error(&self, client_id: &str, message: String, code: &str) {
        self.send_meta(
            client_id,
            ServerMeta {
                msg_type: "error".to_string(),
                message: Some(message),
                code: Some(code.to_string()),
                ..Default::default()
            },
        );
    }

    fn handle_admin_auth(&self, client_id: &str, cmd: &ClientCommand) {
        let Some(client) = self.ws.get_client(client_id) else {
            return;
        };
        if client.auth_failures() >= MAX_ADMIN_AUTH_FAILURES {
            self.send_error(
                client_id,
                "Too many failed admin password attempts".to_string(),
                "AUTH_RATE_LIMITED",
            );
            return;
        }
        let password = self.cfg.read().server.admin_password.clone();
        if !password.is_empty() && cmd.password == password {
            client.set_admin(true);
            client.set_auth_failures(0);
            self.send_meta(
                client_id,
                ServerMeta {
                    msg_type: "admin_auth_ok".to_string(),
                    ..Default::default()
                },
            );
        } else {
            client.set_admin(false);
            client.set_auth_failures(client.auth_failures().saturating_add(1));
            self.send_error(client_id, "Invalid admin password".to_string(), "AUTH_FAILED");
        }
    }

    fn handle_admin_set_profile(&self, client_id: &str, cmd: &ClientCommand) {
        let Some(client) = self.ws.get_client(client_id) else {
            return;
        };
        if !client.is_admin() {
            self.send_error(
                client_id,
                "admin authentication required".to_string(),
                "AUTH_FAILED",
            );
            return;
        }
        if cmd.dongle_id.is_empty() || cmd.profile_id.is_empty() {
            return;
        }
        if let Err(e) = self.switch_profile(&cmd.dongle_id, &cmd.profile_id) {
            error!(error = %e, "admin_set_profile failed");
            self.send_error(
                client_id,
                format!("Profile switch failed: {e}"),
                "PROFILE_SWITCH_FAILED",
            );
        }
    }

    fn handle_subscribe(&self, client_id: &str, cmd: &ClientCommand) {
        let client = match self.ws.get_client(client_id) {
            Some(c) => c,
            None => return,
        };

        let mut dongle_id = cmd.dongle_id.clone();
        if dongle_id.is_empty() {
            dongle_id = self
                .cfg
                .read()
                .dongles
                .first()
                .map(|d| d.id.clone())
                .unwrap_or_default();
            if dongle_id.is_empty() {
                return;
            }
        }

        if !self.dongles.read().contains_key(&dongle_id) {
            warn!(client = %client_id, dongle = %dongle_id, "subscribe to unknown/stopped dongle");
            return;
        }

        let active_profile_id = self
            .dongles
            .read()
            .get(&dongle_id)
            .map(|d| d.profile.read().id.clone())
            .unwrap_or_default();
        if !cmd.profile_id.is_empty() && active_profile_id != cmd.profile_id {
            if let Err(e) = self.switch_profile(&dongle_id, &cmd.profile_id) {
                self.send_error(
                    client_id,
                    format!("Profile switch failed: {e}"),
                    "PROFILE_SWITCH_FAILED",
                );
                return;
            }
        }

        if let Some(cp) = self.client_pipelines.lock().get(client_id) {
            cp.lock().dongle_id = dongle_id.clone();
        }

        let profile = match self.dongles.read().get(&dongle_id) {
            Some(d) => d.profile.read().clone(),
            None => return,
        };
        let mode = {
            let m = client.mode();
            if m.is_empty() {
                profile.mode.clone()
            } else {
                m
            }
        };

        let meta = ServerMeta {
            msg_type: "subscribed".to_string(),
            dongle_id: Some(dongle_id),
            profile_id: Some(profile.id.clone()),
            center_freq: Some(profile.center_frequency as f64),
            sample_rate: Some(profile.sample_rate as i64),
            fft_size: Some(profile.fft_size as i64),
            iq_sample_rate: Some(output_rate_for_mode(&mode) as i64),
            mode: Some(mode),
            tuning_step: Some(profile.tuning_step as i64),
            tune_offset: Some(profile.tune_offset as i64),
            ..Default::default()
        };
        self.send_meta(client_id, meta);
        self.ws.set_client_profile_id(client_id, &profile.id);
    }

    fn handle_unsubscribe(&self, client_id: &str) {
        if let Some(client) = self.ws.get_client(client_id) {
            client.unsubscribe();
        }
        self.destroy_client_pipeline(client_id);
    }

    fn handle_audio_enabled(&self, client_id: &str, cmd: &ClientCommand) {
        match cmd.enabled {
            Some(true) => self.create_client_pipeline(client_id),
            Some(false) => self.destroy_client_pipeline(client_id),
            None => {}
        }
    }

    fn handle_tune(&self, client_id: &str, cmd: &ClientCommand) {
        if let Some(cp) = self.client_pipelines.lock().get(client_id) {
            let mut cp = cp.lock();
            cp.extractor.set_tune_offset(cmd.offset as i32);
            cp.extractor.reset();
            cp.accum_pos = 0;
            cp.adpcm_enc.reset();
        }
    }

    fn handle_bandwidth(&self, client_id: &str, cmd: &ClientCommand) {
        if let Some(cp) = self.client_pipelines.lock().get(client_id) {
            let mut cp = cp.lock();
            cp.extractor.set_bandwidth(cmd.hz as i32);
            if let Some(opus) = cp.opus_pipeline.as_mut() {
                opus.set_bandwidth(cmd.hz as i32);
            }
        }
    }

    fn handle_mode(&self, client_id: &str, cmd: &ClientCommand) {
        let cp = match self.client_pipelines.lock().get(client_id).cloned() {
            Some(cp) => cp,
            None => return,
        };
        let mut cp = cp.lock();

        let rate = output_rate_for_mode(&cmd.mode);
        cp.extractor.set_output_sample_rate(rate);
        let bandwidth = if cmd.bandwidth > 0 {
            cmd.bandwidth as i32
        } else {
            default_bandwidth_for_mode(&cmd.mode)
        };
        cp.extractor.set_bandwidth(bandwidth);
        let out_rate = cp.extractor.output_sample_rate();
        Self::update_chunk_size(&mut cp, out_rate);

        if let Some(opus) = cp.opus_pipeline.as_mut() {
            opus.update_sample_rate(rate);
            if let Err(e) = opus.set_mode(&cmd.mode) {
                error!(client = %client_id, error = %e, "failed to set Opus mode");
            }
            opus.set_bandwidth(bandwidth);
        }
        cp.accum_pos = 0;
        cp.adpcm_enc.reset();
    }

    fn handle_stereo_enabled(&self, client_id: &str, cmd: &ClientCommand) {
        let enabled = match cmd.enabled {
            Some(v) => v,
            None => return,
        };
        if let Some(cp) = self.client_pipelines.lock().get(client_id) {
            let mut cp = cp.lock();
            cp.stereo_enabled = enabled;
            if let Some(opus) = cp.opus_pipeline.as_mut() {
                opus.set_stereo(enabled);
            }
        }
    }

    fn handle_codec_change(&self, client_id: &str, cmd: &ClientCommand) {
        if cmd.iq_codec.is_empty() {
            return;
        }
        // The WS layer already applied the allowed-codec fallback to the
        // client state; use that sanitized value rather than the raw request.
        let new_codec = match self.ws.get_client(client_id) {
            Some(c) => c.iq_codec(),
            None => return,
        };
        if new_codec.is_empty() {
            return;
        }
        let cp = match self.client_pipelines.lock().get(client_id).cloned() {
            Some(cp) => cp,
            None => return,
        };
        let mut cp = cp.lock();

        let old_codec = cp.iq_codec.clone();
        if old_codec == new_codec {
            return;
        }
        let old_opus = is_opus_codec(&old_codec);
        let new_opus = is_opus_codec(&new_codec);

        match (old_opus, new_opus) {
            (false, true) => {
                let mode = {
                    let m = self.ws.get_client(client_id).map(|c| c.mode()).unwrap_or_default();
                    if !m.is_empty() {
                        m
                    } else {
                        let dongle_id = cp.dongle_id.clone();
                        self.dongles
                            .read()
                            .get(&dongle_id)
                            .map(|d| d.profile.read().mode.clone())
                            .filter(|m| !m.is_empty())
                            .unwrap_or_else(|| "nfm".to_string())
                    }
                };
                let complexity = self.cfg.read().server.opus_complexity;
                match OpusPipeline::new(OpusPipelineConfig {
                    mode,
                    sample_rate: cp.extractor.output_sample_rate(),
                    bitrate: 0,
                    stereo_enabled: Some(cp.stereo_enabled),
                    quality: new_codec.clone(),
                    complexity,
                }) {
                    Ok(p) => {
                        cp.extractor.reset();
                        cp.opus_pipeline = Some(p);
                        cp.iq_codec = new_codec;
                    }
                    Err(e) => {
                        error!(client = %client_id, error = %e, "failed to create Opus pipeline");
                        // Keep the pipeline on the previous codec and tell the
                        // client what it is actually receiving.
                        self.ws.set_client_iq_codec(client_id, &old_codec);
                        self.ws.send_to(
                            client_id,
                            pack_codec_status_message(&CodecStatus {
                                iq_codec: old_codec.clone(),
                                iq_msg: format!(
                                    "codec '{new_codec}' could not be enabled, staying on '{old_codec}': {e}"
                                ),
                                ..Default::default()
                            }),
                        );
                    }
                }
            }
            (true, false) => {
                if let Some(mut opus) = cp.opus_pipeline.take() {
                    opus.close();
                }
                cp.iq_codec = new_codec;
                cp.adpcm_enc.reset();
                cp.accum_pos = 0;
            }
            (true, true) => {
                if let Some(opus) = cp.opus_pipeline.as_mut() {
                    let channels = opus.channels();
                    let bitrate = bitrate_for_quality(&new_codec, channels);
                    opus.set_bitrate(bitrate);
                }
                cp.iq_codec = new_codec;
            }
            (false, false) => {
                cp.iq_codec = new_codec;
                cp.adpcm_enc.reset();
                cp.accum_pos = 0;
            }
        }
    }

    fn handle_identify_start(&self, client_id: &str) {
        let func = match self.identify_token_func.lock().clone() {
            Some(f) => f,
            None => return,
        };
        let persistent_id = self
            .ws
            .get_client(client_id)
            .map(|c| c.persistent_id.clone())
            .unwrap_or_else(|| client_id.to_string());
        let pcm = self
            .capture_pcm_for_client(client_id, 10)
            .unwrap_or_default();
        let (token, err) = func(client_id, &persistent_id, pcm);
        if !err.is_empty() {
            self.send_meta(
                client_id,
                ServerMeta {
                    msg_type: "toast".to_string(),
                    message: Some(err),
                    code: Some("identify_rate_limit".to_string()),
                    ..Default::default()
                },
            );
        } else {
            self.send_meta(
                client_id,
                ServerMeta {
                    msg_type: "identify_token".to_string(),
                    message: Some(token),
                    ..Default::default()
                },
            );
        }
    }

    fn handle_set_pre_filter_nb(&self, client_id: &str, cmd: &ClientCommand) {
        let enabled = match cmd.enabled {
            Some(v) => v,
            None => return,
        };
        if let Some(cp) = self.client_pipelines.lock().get(client_id) {
            let mut cp = cp.lock();
            cp.nb_enabled = enabled;
            cp.extractor.set_nb_enabled(enabled);
        }
    }

    fn handle_set_pre_filter_nb_threshold(&self, client_id: &str, cmd: &ClientCommand) {
        // The client sends `threshold`; older clients/tools send `level`.
        let threshold = match cmd.threshold {
            Some(v) => v,
            None => cmd.level,
        };
        if threshold <= 0.0 {
            return;
        }
        let threshold = threshold as f32;
        if let Some(cp) = self.client_pipelines.lock().get(client_id) {
            let mut cp = cp.lock();
            cp.nb_threshold = threshold;
            cp.extractor.set_nb_threshold(threshold);
        }
    }

    // ------------------------------------------------------------------
    // FFT history
    // ------------------------------------------------------------------

    fn handle_request_history(&self, client_id: &str) {
        let client = match self.ws.get_client(client_id) {
            Some(c) => c,
            None => return,
        };
        let dongle_id = client.subscribed_to();
        let ad = match self.dongles.read().get(&dongle_id) {
            Some(d) => d.clone(),
            None => return,
        };

        let frames = ad.history.get_range();
        if frames.is_empty() {
            return;
        }
        let bin_count = frames[0].len();
        if bin_count == 0 {
            return;
        }

        const MIN_DB: f32 = -130.0;
        const MAX_DB: f32 = 0.0;
        let range = MAX_DB - MIN_DB;

        let mut history_bins = self.cfg.read().server.fft_history_fft_size;
        if history_bins <= 0 || history_bins as usize >= bin_count {
            history_bins = bin_count as i32;
        }
        let history_bins = history_bins as usize;
        let ratio = bin_count as f64 / history_bins as f64;

        let mut quantized: Vec<u8> = Vec::with_capacity(frames.len() * history_bins);
        let mut frame_count = 0u16;
        for frame in &frames {
            if frame.len() != bin_count {
                continue;
            }
            for j in 0..history_bins {
                let src_start = (j as f64 * ratio) as usize;
                let mut src_end = ((j + 1) as f64 * ratio) as usize;
                if src_end <= src_start {
                    src_end = src_start + 1;
                }
                if src_end > bin_count {
                    src_end = bin_count;
                }
                let mut max_val = f32::NEG_INFINITY;
                for v in &frame[src_start..src_end] {
                    if *v > max_val {
                        max_val = *v;
                    }
                }
                let norm = ((max_val - MIN_DB) / range).clamp(0.0, 1.0);
                quantized.push((norm * 255.0) as u8);
            }
            frame_count += 1;
        }
        if frame_count == 0 {
            return;
        }

        let compression = {
            let c = self.cfg.read().server.fft_history_compression.clone();
            if c.is_empty() {
                "deflate".to_string()
            } else {
                c
            }
        };

        let (codec_byte, payload): (u8, Vec<u8>) = match compression.as_str() {
            "deflate" => {
                let mut delta = Vec::with_capacity(quantized.len());
                if let Some(first) = quantized.first() {
                    delta.push(*first);
                    for i in 1..quantized.len() {
                        delta.push(quantized[i].wrapping_sub(quantized[i - 1]));
                    }
                }
                let mut enc = flate2::write::DeflateEncoder::new(
                    Vec::new(),
                    flate2::Compression::new(6),
                );
                use std::io::Write;
                if enc.write_all(&delta).is_err() {
                    return;
                }
                match enc.finish() {
                    Ok(b) => (1, b),
                    Err(_) => return,
                }
            }
            "adpcm" => {
                let mut float_db = Vec::with_capacity(quantized.len());
                for b in &quantized {
                    float_db.push(*b as f32 / 255.0 * range + MIN_DB);
                }
                (2, encode_fft_adpcm(&float_db, MIN_DB, MAX_DB))
            }
            _ => (0, quantized),
        };

        let mut msg = Vec::with_capacity(1 + 2 + 4 + 2 + 2 + 1 + payload.len());
        msg.push(crate::ws::MSG_FFT_HISTORY);
        msg.extend_from_slice(&frame_count.to_le_bytes());
        msg.extend_from_slice(&(history_bins as u32).to_le_bytes());
        msg.extend_from_slice(&(MIN_DB as i16).to_le_bytes());
        msg.extend_from_slice(&(MAX_DB as i16).to_le_bytes());
        msg.push(codec_byte);
        msg.extend_from_slice(&payload);
        self.ws.send_to(client_id, msg);
    }

    // ------------------------------------------------------------------
    // Public API (used by the REST/admin layer)
    // ------------------------------------------------------------------

    pub fn start_dongle_by_id(&self, dongle_id: &str) -> Result<()> {
        let _ = dongle_id;
        // Starting is async (source connection); callers use
        // `start_dongle_by_id_async` from an async context.
        bail!("internal error: use start_dongle_by_id_async")
    }

    /// Starts a dongle using the current config entry.
    pub async fn start_dongle_by_id_async(self: &Arc<Self>, dongle_id: &str) -> Result<()> {
        if self.dongles.read().contains_key(dongle_id) {
            bail!("dongle {dongle_id} is already running");
        }
        let dcfg = self
            .cfg
            .read()
            .dongles
            .iter()
            .find(|d| d.id == dongle_id)
            .cloned()
            .ok_or_else(|| anyhow!("dongle {dongle_id} not found in config"))?;
        self.start_dongle_with_retry(dcfg).await
    }

    pub async fn stop_dongle_by_id(&self, dongle_id: &str) -> Result<()> {
        let ad = match self.dongles.write().remove(dongle_id) {
            Some(d) => d,
            None => bail!("dongle {dongle_id} is not running"),
        };
        let _ = ad.cancel.send(true);
        // Let the run loop observe cancellation and a blocking source read
        // finish before the source is dropped and the device is closed. An
        // immediate abort can drop a local RTL-SDR device while `read_sync` is
        // still inside librtlsdr, and it blocks the reinit unnecessarily.
        let task = ad.task.lock().take();
        if let Some(mut task) = task {
            if tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                warn!(id = %dongle_id, "dongle task did not stop in time; aborting");
                task.abort();
            }
        }

        let pipelines: Vec<String> = {
            let map = self.client_pipelines.lock();
            map.iter()
                .filter(|(_, cp)| cp.lock().dongle_id == dongle_id)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in pipelines {
            self.destroy_client_pipeline(&id);
        }

        self.set_state(dongle_id, DongleState::stopped());
        self.ws
            .unsubscribe_from_dongle(dongle_id, "dongle stopped");
        self.notify_dongle_stopped(dongle_id);
        Ok(())
    }

    pub async fn reinit_dongle(self: &Arc<Self>, dongle_id: &str) -> Result<()> {
        let dcfg = self
            .cfg
            .read()
            .dongles
            .iter()
            .find(|d| d.id == dongle_id)
            .cloned()
            .ok_or_else(|| anyhow!("dongle {dongle_id} not found in config"))?;

        let client_ids = self.ws.unsubscribe_from_dongle(dongle_id, "dongle reinitialising");
        for id in client_ids {
            self.destroy_client_pipeline(&id);
        }
        if self.dongles.read().contains_key(dongle_id) {
            let _ = self.stop_dongle_by_id(dongle_id).await;
        }

        if !dcfg.enabled {
            self.set_state(dongle_id, DongleState::stopped());
            return Ok(());
        }
        if dcfg.profiles.is_empty() {
            self.set_state(
                dongle_id,
                DongleState {
                    status: STATUS_STOPPED.to_string(),
                    last_error: "no profiles configured".to_string(),
                    ..Default::default()
                },
            );
            return Ok(());
        }
        let started = Instant::now();
        let result = self.start_dongle_with_retry(dcfg).await;
        tracing::info!(
            id = %dongle_id,
            elapsed_ms = started.elapsed().as_millis() as u64,
            ok = result.is_ok(),
            "dongle reinit finished"
        );
        result
    }

    pub async fn handle_profile_removed(&self, dongle_id: &str, profile_id: &str) {
        let active = {
            let map = self.dongles.read();
            match map.get(dongle_id) {
                Some(d) => d.profile.read().id.clone(),
                None => return,
            }
        };
        if active != profile_id {
            return;
        }

        let remaining = self
            .cfg
            .read()
            .dongles
            .iter()
            .find(|d| d.id == dongle_id)
            .map(|d| d.profiles.clone())
            .unwrap_or_default();

        if remaining.is_empty() {
            let _ = self.stop_dongle_by_id(dongle_id).await;
        } else if let Err(e) = self.switch_profile(dongle_id, &remaining[0].id) {
            warn!(dongle = %dongle_id, error = %e, "failed to switch to remaining profile");
        }
    }

    /// Switches a running dongle to another profile.
    pub fn switch_profile(&self, dongle_id: &str, profile_id: &str) -> Result<()> {
        let ad = match self.dongles.read().get(dongle_id) {
            Some(d) => d.clone(),
            None => bail!("dongle {dongle_id} is not running"),
        };
        let dcfg = self
            .cfg
            .read()
            .dongles
            .iter()
            .find(|d| d.id == dongle_id)
            .cloned()
            .ok_or_else(|| anyhow!("dongle {dongle_id} not found in config"))?;
        let profile = dcfg
            .profiles
            .iter()
            .find(|p| p.id == profile_id)
            .cloned()
            .ok_or_else(|| anyhow!("profile {profile_id} not found in dongle {dongle_id}"))?;

        if let Some(cmd) = &ad.command {
            let freq = (profile.center_frequency + profile.oscillator_offset as i64) as u32;
            let _ = cmd.set_frequency(freq);
            if profile.sample_rate > 0 {
                let _ = cmd.set_sample_rate(profile.sample_rate as u32);
            }
            if profile.gain > 0.0 {
                let _ = cmd.set_gain_mode(1);
                let _ = cmd.set_gain((profile.gain * 10.0) as u32);
            }
            let direct = if profile.direct_sampling != 0 {
                profile.direct_sampling
            } else {
                dcfg.direct_sampling
            };
            let _ = cmd.set_direct_sampling(direct as u32);
            let _ = cmd.set_bias_t(dcfg.bias_t as u32);
            let _ = cmd.set_offset_tuning(dcfg.offset_tuning as u32);
        }

        if profile.fft_size > 0 {
            let sample_rate = if profile.sample_rate > 0 {
                profile.sample_rate
            } else if dcfg.sample_rate > 0 {
                dcfg.sample_rate
            } else {
                2_400_000
            };
            let fft_fps = if profile.fft_fps > 0 { profile.fft_fps } else { 30 };
            let fft_size = profile.fft_size as usize;
            let fft_proc = FftProcessor::new(FftProcessorConfig {
                fft_size,
                sample_rate,
                window: "blackman-harris".to_string(),
                averaging: 0.5,
                averaging_taps: 0,
                target_fps: fft_fps,
            })
            .map_err(|e| anyhow!("rebuild FFT processor: {e}"))?;
            *ad.fft_proc.lock() = fft_proc;
            *ad.deflate_enc.lock() = FftDeflateEncoder::new(fft_size);
            *ad.deflate_floor_enc.lock() = FftDeflateEncoder::new(fft_size);
        }

        *ad.profile.write() = profile.clone();
        if dcfg.iq_correction {
            let rate = if profile.sample_rate > 0 {
                profile.sample_rate
            } else if dcfg.sample_rate > 0 {
                dcfg.sample_rate
            } else {
                2_400_000
            };
            *ad.iq_correct.lock() = Some(IqCorrect::new(rate as f64, 10.0, true));
        } else {
            *ad.iq_correct.lock() = None;
        }
        ad.history.reset();
        if profile.fft_size > 0 {
            ad.history.init_frames(profile.fft_size as usize);
        }

        let mode = profile.mode.clone();
        let default_bw = default_bandwidth_for_mode(&mode) as i64;
        let subscribed = self.ws.subscribed_clients(dongle_id);
        for client in subscribed {
            client.drop_queued_fft();
            let meta = ServerMeta {
                msg_type: "profile_changed".to_string(),
                dongle_id: Some(dongle_id.to_string()),
                profile_id: Some(profile.id.clone()),
                center_freq: Some(profile.center_frequency as f64),
                sample_rate: Some(profile.sample_rate as i64),
                fft_size: Some(profile.fft_size as i64),
                iq_sample_rate: Some(output_rate_for_mode(&mode) as i64),
                mode: Some(mode.clone()),
                tuning_step: Some(profile.tuning_step as i64),
                ..Default::default()
            };
            self.ws.send_to(&client.id, pack_meta_message(&meta));
            self.ws.apply_profile_change_to_client(
                &client.id,
                &profile.id,
                &mode,
                default_bw,
            );
        }

        let pipelines: Vec<(String, Arc<Mutex<ClientPipeline>>)> = {
            let map = self.client_pipelines.lock();
            map.iter()
                .filter(|(_, cp)| cp.lock().dongle_id == dongle_id)
                .map(|(id, cp)| (id.clone(), cp.clone()))
                .collect()
        };
        for (_, cp) in pipelines {
            let mut cp = cp.lock();
            let rate = output_rate_for_mode(&mode);
            cp.extractor.set_output_sample_rate(rate);
            cp.extractor.set_bandwidth(default_bandwidth_for_mode(&mode));
            cp.extractor.set_tune_offset(0);
            cp.extractor
                .set_dc_offset_removal(profile.dc_offset_removal_enabled());
            Self::update_chunk_size(&mut cp, rate);
            if let Some(opus) = cp.opus_pipeline.as_mut() {
                opus.update_sample_rate(rate);
                if let Err(e) = opus.set_mode(&mode) {
                    warn!(error = %e, "failed to update Opus mode on profile switch");
                }
                opus.set_bandwidth(default_bandwidth_for_mode(&mode));
            }
            cp.accum_pos = 0;
            cp.adpcm_enc.reset();
        }

        info!(dongle = %dongle_id, profile = %profile_id, "profile switched");
        Ok(())
    }

    // ------------------------------------------------------------------
    // State / info
    // ------------------------------------------------------------------

    pub fn get_dongle_state(&self, dongle_id: &str) -> DongleState {
        self.dongle_states
            .lock()
            .get(dongle_id)
            .cloned()
            .unwrap_or_else(DongleState::stopped)
    }

    pub fn get_all_dongle_states(&self) -> HashMap<String, DongleState> {
        self.dongle_states.lock().clone()
    }

    /// True while the dongle pipeline is actually running.
    pub fn is_dongle_running(&self, dongle_id: &str) -> bool {
        self.dongles.read().contains_key(dongle_id)
    }

    /// Active profile of a running dongle, or the first configured profile
    /// when it is stopped.
    pub fn active_profile_id(&self, dongle_id: &str) -> Option<String> {
        if let Some(d) = self.dongles.read().get(dongle_id) {
            return Some(d.profile.read().id.clone());
        }
        self.cfg
            .read()
            .dongles
            .iter()
            .find(|d| d.id == dongle_id)
            .and_then(|d| d.profiles.first())
            .map(|p| p.id.clone())
    }

    fn set_state(&self, dongle_id: &str, state: DongleState) {
        self.dongle_states
            .lock()
            .insert(dongle_id.to_string(), state);
    }

    pub fn build_dongle_info(&self, dcfg: &DongleConfig) -> DongleInfo {
        let state = self.get_dongle_state(&dcfg.id);
        let active_profile = self
            .dongles
            .read()
            .get(&dcfg.id)
            .map(|d| d.profile.read().id.clone())
            .unwrap_or_default();
        let client_count = self.ws.subscribed_clients(&dcfg.id).len();

        DongleInfo {
            id: dcfg.id.clone(),
            name: dcfg.name.clone(),
            enabled: dcfg.enabled,
            source_type: dcfg.source.kind.clone(),
            sample_rate: dcfg.sample_rate,
            client_count,
            profiles: dcfg.profiles.clone(),
            state,
            active_profile,
        }
    }

    pub fn get_dongle_infos(&self) -> Vec<DongleInfo> {
        let cfg = self.cfg.read();
        cfg.dongles.iter().map(|d| self.build_dongle_info(d)).collect()
    }

    pub fn get_server_config_info(&self) -> ServerConfigInfo {
        let cfg = self.cfg.read();
        ServerConfigInfo {
            callsign: cfg.server.callsign.clone(),
            description: cfg.server.description.clone(),
            location: cfg.server.location.clone(),
            demo_mode: cfg.server.demo_mode,
        }
    }

    // ------------------------------------------------------------------
    // Notifications
    // ------------------------------------------------------------------

    fn notify(&self, n: ConfigNotification) {
        self.ws.broadcast_all(pack_notification(&n));
    }

    pub fn notify_dongle_added(&self, dcfg: &DongleConfig) {
        let dongle = self.build_dongle_info(dcfg);
        self.notify(ConfigNotification {
            msg_type: "dongle_added".to_string(),
            dongle_id: dcfg.id.clone(),
            dongle: Some(dongle),
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn notify_dongle_updated(&self, dcfg: &DongleConfig) {
        let dongle = self.build_dongle_info(dcfg);
        self.notify(ConfigNotification {
            msg_type: "dongle_updated".to_string(),
            dongle_id: dcfg.id.clone(),
            dongle: Some(dongle),
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn notify_dongle_removed(&self, dongle_id: &str) {
        self.notify(ConfigNotification {
            msg_type: "dongle_removed".to_string(),
            dongle_id: dongle_id.to_string(),
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn notify_dongle_started(&self, dongle_id: &str) {
        self.notify(ConfigNotification {
            msg_type: "dongle_started".to_string(),
            dongle_id: dongle_id.to_string(),
            state: Some(self.get_dongle_state(dongle_id)),
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn notify_dongle_stopped(&self, dongle_id: &str) {
        self.notify(ConfigNotification {
            msg_type: "dongle_stopped".to_string(),
            dongle_id: dongle_id.to_string(),
            state: Some(self.get_dongle_state(dongle_id)),
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn notify_dongle_error(&self, dongle_id: &str, error: &str) {
        self.notify(ConfigNotification {
            msg_type: "dongle_error".to_string(),
            dongle_id: dongle_id.to_string(),
            error: error.to_string(),
            state: Some(self.get_dongle_state(dongle_id)),
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn notify_profile_added(&self, dongle_id: &str, profile: &DongleProfile) {
        self.notify(ConfigNotification {
            msg_type: "profile_added".to_string(),
            dongle_id: dongle_id.to_string(),
            profile_id: profile.id.clone(),
            profile: Some(profile.clone()),
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn notify_profile_updated(&self, dongle_id: &str, profile: &DongleProfile) {
        let is_active = self
            .dongles
            .read()
            .get(dongle_id)
            .map(|d| d.profile.read().id == profile.id)
            .unwrap_or(false);
        if is_active {
            if let Err(e) = self.switch_profile(dongle_id, &profile.id) {
                warn!(dongle = %dongle_id, error = %e, "failed to apply profile update");
            }
        }
        self.notify(ConfigNotification {
            msg_type: "profile_updated".to_string(),
            dongle_id: dongle_id.to_string(),
            profile_id: profile.id.clone(),
            profile: Some(profile.clone()),
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn notify_profile_removed(&self, dongle_id: &str, profile_id: &str) {
        self.notify(ConfigNotification {
            msg_type: "profile_removed".to_string(),
            dongle_id: dongle_id.to_string(),
            profile_id: profile_id.to_string(),
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn notify_profiles_reordered(&self, dongle_id: &str, profiles: Vec<DongleProfile>) {
        self.notify(ConfigNotification {
            msg_type: "profiles_reordered".to_string(),
            dongle_id: dongle_id.to_string(),
            profiles,
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn notify_server_config_updated(&self) {
        self.notify(ConfigNotification {
            msg_type: "server_config_updated".to_string(),
            server: Some(self.get_server_config_info()),
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn notify_config_saved(&self) {
        self.notify(ConfigNotification {
            msg_type: "config_saved".to_string(),
            version: self.current_version(),
            ..Default::default()
        });
    }

    pub fn send_state_sync(&self, client_id: &str) {
        let n = ConfigNotification {
            msg_type: "state_sync".to_string(),
            dongles: self.get_dongle_infos(),
            server: Some(self.get_server_config_info()),
            version: self.current_version(),
            ..Default::default()
        };
        self.ws.send_to(client_id, pack_notification(&n));
    }

    pub fn broadcast_state_sync(&self) {
        let n = ConfigNotification {
            msg_type: "state_sync".to_string(),
            dongles: self.get_dongle_infos(),
            server: Some(self.get_server_config_info()),
            version: self.current_version(),
            ..Default::default()
        };
        self.ws.broadcast_all(pack_notification(&n));
    }

    // ------------------------------------------------------------------
    // Recording / stats
    // ------------------------------------------------------------------

    pub fn start_recording(&self, dongle_id: &str) -> Result<()> {
        let ad = self
            .dongles
            .read()
            .get(dongle_id)
            .cloned()
            .ok_or_else(|| anyhow!("dongle {dongle_id} is not running"))?;
        let profile = ad.profile.read().clone();
        let sample_rate = if profile.sample_rate > 0 {
            profile.sample_rate
        } else {
            2_400_000
        };
        self.recorder
            .start(dongle_id, profile.center_frequency, sample_rate)
    }

    pub fn stop_recording(&self, dongle_id: &str) -> Result<String> {
        self.recorder.stop(dongle_id)
    }

    pub fn recording_status(&self) -> Vec<RecordingStatus> {
        self.recorder.status()
    }

    fn spawn_stats_loop(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let ws = self.ws.clone();
        tokio::spawn(async move {
            let mut last_cpu = process_cpu_seconds();
            let mut last_at = Instant::now();
            let mut last_bytes = ws.total_bytes_written();
            let mut ticker = tokio::time::interval(Duration::from_secs(2));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let Some(mgr) = weak.upgrade() else { return };

                let now = Instant::now();
                let cpu = process_cpu_seconds();
                let elapsed = now.duration_since(last_at).as_secs_f64();
                let mut cpu_percent = if elapsed > 0.0 {
                    (cpu - last_cpu) / elapsed * 100.0
                } else {
                    0.0
                };
                if cpu_percent > 100.0 {
                    cpu_percent = 100.0;
                }
                if cpu_percent < 0.0 {
                    cpu_percent = 0.0;
                }
                last_cpu = cpu;
                last_at = now;

                let total_bytes = ws.total_bytes_written();
                let ws_bytes_per_sec = if elapsed > 0.0 {
                    ((total_bytes.saturating_sub(last_bytes)) as f64 / elapsed).round() as i64
                } else {
                    0
                };
                last_bytes = total_bytes;

                let stats = json!({
                    "type": "server_stats",
                    "cpuPercent": cpu_percent.round() as i64,
                    "memMb": process_mem_mb().round() as i64,
                    "clients": mgr.ws.client_count(),
                    "wsBytesPerSec": ws_bytes_per_sec,
                });
                let bytes = serde_json::to_vec(&stats).unwrap_or_default();
                let mut msg = Vec::with_capacity(1 + bytes.len());
                msg.push(MSG_META);
                msg.extend_from_slice(&bytes);
                mgr.ws.broadcast_all(msg);

                // Push per-dongle client counts when they change so the UI
                // does not have to poll the admin REST endpoint.
                let current_counts: Vec<(String, usize)> = {
                    let cfg = mgr.cfg.read();
                    cfg.dongles
                        .iter()
                        .map(|d| (d.id.clone(), mgr.ws.subscribed_clients(&d.id).len()))
                        .collect()
                };
                let changes: Vec<(String, usize)> = {
                    let mut last = mgr.last_client_counts.lock();
                    let mut changes = Vec::new();
                    for (id, count) in &current_counts {
                        if last.get(id).copied() != Some(*count) {
                            last.insert(id.clone(), *count);
                            changes.push((id.clone(), *count));
                        }
                    }
                    last.retain(|id, _| current_counts.iter().any(|(known, _)| known == id));
                    changes
                };
                for (id, count) in changes {
                    let meta = ServerMeta {
                        msg_type: "dongle_status".to_string(),
                        dongle_id: Some(id.clone()),
                        running: Some(mgr.is_dongle_running(&id)),
                        client_count: Some(count as i64),
                        ..Default::default()
                    };
                    mgr.ws.broadcast_all(pack_meta_message(&meta));
                }
            }
        });
    }
}

fn is_opus_codec(codec: &str) -> bool {
    matches!(codec, "opus" | "opus-hq" | "opus-lo")
}

/// Output IQ rate for a demodulation mode.
pub fn output_rate_for_mode(mode: &str) -> i32 {
    match mode {
        "wfm" => 240_000,
        "nfm" | "am" | "am-stereo" => 48_000,
        "usb" | "lsb" | "sam" => 24_000,
        "cw" => 12_000,
        _ => 48_000,
    }
}

/// Default demodulation bandwidth for a mode.
pub fn default_bandwidth_for_mode(mode: &str) -> i32 {
    match mode {
        "wfm" => 200_000,
        "nfm" => 12_500,
        "am" => 6_000,
        "am-stereo" => 10_000,
        "sam" => 6_000,
        "usb" | "lsb" => 2_400,
        "cw" => 1_500,
        _ => 12_500,
    }
}

// ----------------------------------------------------------------------
// Linux process statistics
// ----------------------------------------------------------------------

fn process_cpu_seconds() -> f64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(stat) = std::fs::read_to_string("/proc/self/stat") {
            // Fields after the comm field (which may contain spaces).
            if let Some(idx) = stat.rfind(')') {
                let rest: Vec<&str> = stat[idx + 1..].split_whitespace().collect();
                // utime is field 14, stime 15 → indices 11 and 12 here.
                if rest.len() > 12 {
                    if let (Ok(u), Ok(s)) = (rest[11].parse::<u64>(), rest[12].parse::<u64>()) {
                        return (u + s) as f64 / 100.0;
                    }
                }
            }
        }
        0.0
    }
    #[cfg(not(target_os = "linux"))]
    {
        0.0
    }
}

fn process_mem_mb() -> f64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(statm) = std::fs::read_to_string("/proc/self/statm") {
            let parts: Vec<&str> = statm.split_whitespace().collect();
            if parts.len() > 1 {
                if let Ok(pages) = parts[1].parse::<u64>() {
                    return pages as f64 * 4096.0 / (1024.0 * 1024.0);
                }
            }
        }
        0.0
    }
    #[cfg(not(target_os = "linux"))]
    {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_tables_match_go() {
        assert_eq!(output_rate_for_mode("wfm"), 240_000);
        assert_eq!(output_rate_for_mode("nfm"), 48_000);
        assert_eq!(output_rate_for_mode("usb"), 24_000);
        assert_eq!(output_rate_for_mode("cw"), 12_000);
        assert_eq!(output_rate_for_mode("unknown"), 48_000);

        assert_eq!(default_bandwidth_for_mode("wfm"), 200_000);
        assert_eq!(default_bandwidth_for_mode("nfm"), 12_500);
        assert_eq!(default_bandwidth_for_mode("am-stereo"), 10_000);
        assert_eq!(default_bandwidth_for_mode("cw"), 1_500);
    }

    #[test]
    fn reinit_detects_hardware_changes() {
        let base = DongleConfig::default();
        let mut changed = base.clone();
        changed.source.host = "other".into();
        assert!(crate::api::admin::needs_reinit(&base, &changed));

        let mut level_only = base.clone();
        level_only.gain = 10.0;
        assert!(!crate::api::admin::needs_reinit(&base, &level_only));
    }
}
