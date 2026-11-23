//! HTTP API layer: router, admin, band plan, bookmarks, recognition.

pub mod admin;
pub mod aviation;
pub mod bandplan;
pub mod bookmarks;
pub mod decoder_catalog;
#[cfg(feature = "decoders")]
pub mod decoders;
pub mod identify;
pub mod map;
pub mod recognizer;
pub mod router;
pub mod system;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::RwLock;

use crate::config::{Config, ConfigVersion};
use crate::dongle::Manager;
use crate::ws::WsManager;

pub use admin::AdminAuth;
pub use aviation::AviationService;
pub use bandplan::{BandEntry, BandPlanService};
pub use bookmarks::PublicBookmark;
pub use decoder_catalog::DecoderCatalogService;
pub use identify::IdentifyService;
pub use router::build_router;

/// Shared state for all HTTP handlers.
#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<RwLock<Config>>,
    pub ws: Arc<WsManager>,
    pub mgr: Arc<Manager>,
    pub cfg_path: PathBuf,
    pub cfg_version: Arc<ConfigVersion>,
    pub bookmarks_dir: String,
    pub bandplan: Arc<BandPlanService>,
    pub decoder_catalog: Arc<DecoderCatalogService>,
    pub aviation: Arc<AviationService>,
    pub identify: Arc<IdentifyService>,
    pub auth: Arc<admin::AdminAuth>,
    pub static_dir: PathBuf,
    pub start_time: Instant,
    #[cfg(feature = "decoders")]
    pub decoder_store: Arc<crate::decoders::store::DecoderStore>,
    #[cfg(feature = "geoip")]
    pub geoip: Option<Arc<crate::geoip::GeoIpService>>,
}
