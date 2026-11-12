//! serverrs entrypoint.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use parking_lot::RwLock;
use tokio::net::TcpListener;

use serverrs::api::{
    build_router, AdminAuth, AppState, BandPlanService, IdentifyService,
};
use serverrs::codec::OPUS_AVAILABLE;
use serverrs::config::{self, Config, ConfigVersion};
use serverrs::dongle::Manager;
use serverrs::ws::{RateLimiter, WsManager};

fn main() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async_main())
}

async fn async_main() -> Result<()> {
    if std::env::args().any(|a| a == "--version") {
        println!("serverrs {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let cfg_path = std::env::var("CONFIG_PATH")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "../config/config.yaml".to_string());
    let cfg_path = PathBuf::from(cfg_path);

    let mut cfg = config::load(&cfg_path)
        .with_context(|| format!("failed to load config at {}", cfg_path.display()))?;

    // Logging is initialised from the config file so a container can be
    // diagnosed by editing `server.logLevel` without changing its environment.
    // LOG_LEVEL still overrides the file.
    init_logging(&cfg.server.log_level);

    tracing::info!(version = env!("CARGO_PKG_VERSION"), "starting serverrs");
    tracing::info!(
        port = cfg.server.port,
        host = %cfg.server.host,
        dongles = cfg.dongles.len(),
        log_level = %cfg.server.log_level,
        demo_mode = cfg.server.demo_mode,
        "configuration loaded"
    );
    for d in &cfg.dongles {
        tracing::info!(
            id = %d.id,
            name = %d.name,
            enabled = d.enabled,
            auto_start = d.auto_start,
            source = %d.source.kind,
            host = %d.source.host,
            port = d.source.port,
            device_index = d.source.device_index,
            serial = %d.source.serial,
            sample_rate = d.sample_rate,
            "configured dongle"
        );
    }

    if std::env::var("NODE_SDR_DEMO").as_deref() == Ok("1") {
        cfg.server.demo_mode = true;
    }

    // Desktop launchers bind an ephemeral port chosen by the wrapper and keep
    // the server on loopback. Container/systemd deployments keep using the
    // YAML values, so these overrides stay opt-in.
    if let Ok(port) = std::env::var("PORT") {
        if let Ok(port) = port.parse::<u16>() {
            if port > 0 {
                cfg.server.port = i32::from(port);
            }
        }
    }
    if let Ok(host) = std::env::var("HOST") {
        if !host.trim().is_empty() {
            cfg.server.host = host;
        }
    }
    tracing::info!(
        host = %cfg.server.host,
        port = cfg.server.port,
        "bind address"
    );

    if !OPUS_AVAILABLE {
        cfg.server
            .allowed_iq_codecs
            .retain(|c| c != "opus" && c != "opus-hq" && c != "opus-lo");
        tracing::warn!("opus not compiled in - opus/opus-hq/opus-lo removed from allowed IQ codecs");
    }

    tracing::info!(
        fft = ?cfg.server.allowed_fft_codecs,
        iq = ?cfg.server.allowed_iq_codecs,
        "allowed codecs"
    );

    let static_dir = std::env::var("STATIC_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "../client/dist".to_string());

    let ws = Arc::new(WsManager::new());
    ws.set_allowed_codecs(
        &cfg.server.allowed_fft_codecs,
        &cfg.server.allowed_iq_codecs,
    );
    if !cfg.server.real_ip_header.is_empty() {
        ws.set_real_ip_header(&cfg.server.real_ip_header);
    }
    ws.set_rate_limiter(Arc::new(RateLimiter::new(10)));

    let mut max_fps = 30usize;
    for d in &cfg.dongles {
        for p in &d.profiles {
            if p.fft_fps > max_fps as i32 {
                max_fps = p.fft_fps as usize;
            }
        }
    }
    ws.set_max_fft_fps(max_fps);

    let cfg = Arc::new(RwLock::new(cfg));
    let cfg_version = Arc::new(ConfigVersion::new());

    let mgr = Manager::new(cfg.clone(), ws.clone(), &cfg_path);
    mgr.set_version_func({
        let v = cfg_version.clone();
        move || v.get()
    });

    let identify = Arc::new(IdentifyService::new());
    mgr.set_identify_token_func({
        let id = identify.clone();
        move |conn_id, persistent_id, pcm| id.issue(conn_id, persistent_id, pcm)
    });

    let bandplan = BandPlanService::new();
    bandplan.start_scheduler();

    let bookmarks_dir = std::env::var("BOOKMARKS_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let parent = cfg_path.parent().unwrap_or_else(|| Path::new("."));
            parent.join("../bookmarks").to_string_lossy().to_string()
        });
    tracing::info!(path = %bookmarks_dir, "bookmarks directory");

    let (host, port, admin_password) = {
        let c = cfg.read();
        (
            c.server.host.clone(),
            c.server.port,
            c.server.admin_password.clone(),
        )
    };

    let state = AppState {
        cfg: cfg.clone(),
        ws: ws.clone(),
        mgr: mgr.clone(),
        cfg_path: cfg_path.clone(),
        cfg_version: cfg_version.clone(),
        bookmarks_dir,
        bandplan,
        identify,
        auth: AdminAuth::new(admin_password),
        static_dir: PathBuf::from(static_dir),
        start_time: Instant::now(),
        #[cfg(feature = "decoders")]
        decoder_store: mgr.decoder_store(),
    };

    // Start dongles + stats loop (non-fatal).
    mgr.start();

    let app = build_router(state);
    let addr = format!("{host}:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("failed to bind {addr}"))?;

    tracing::info!(addr = %addr, "starting HTTP server");

    let shutdown_mgr = mgr.clone();
    let shutdown_ws = ws.clone();
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("shutting down gracefully...");

        shutdown_mgr.stop();
        for rec in shutdown_mgr.recording_status() {
            let _ = shutdown_mgr.stop_recording(&rec.dongle_id);
        }
        shutdown_ws.shutdown();
    });

    server.await.context("HTTP server error")?;
    Ok(())
}

fn init_logging(config_level: &str) {
    use tracing_subscriber::EnvFilter;

    let level = std::env::var("LOG_LEVEL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| config_level.to_string());
    let filter = EnvFilter::new(format!(
        "serverrs={level},info"
    ));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

// Silence unused-import warnings for Config when only referenced in signatures.
#[allow(dead_code)]
fn _cfg(_: &Config) {}
