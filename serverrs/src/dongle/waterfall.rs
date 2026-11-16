//! Server-side segmented multi-tier waterfall state.
//!
//! The tiered waterfall serves each client only the spectrum tiles that
//! overlap its current viewport, at a resolution tier chosen to roughly match
//! one bin per CSS pixel. This keeps bandwidth bounded while a client is zoomed
//! in, and lets a zoomed-out client receive a coarse (folded) view of the full
//! span.
//!
//! Model (frozen wire contract):
//!   * `tierBins[t] = fftSize >> t` for `t` in `0..NUM_TIERS` — [fftSize, /2,
//!     /4, /8]. Every tier covers the full span; tier 0 is finest.
//!   * `effectiveTileBins = min(waterfallTileBins, fftSize / 8)`.
//!   * `tilesPerTier[t] = tierBins[t] / effectiveTileBins`.
//!   * `tileIndex 0` = lowest-Hz edge; wire bin 0 = lowest Hz.
//!
//! Tiles are built lazily: a tile's history ring is only allocated once at
//! least one client's view overlaps it, and torn down when the last such
//! client leaves.

use crate::codec::FftDeflateEncoder;
use crate::history::FftBuffer;

/// Number of resolution tiers (tier 0 finest … tier 3 coarsest).
pub const NUM_TIERS: usize = 4;

/// Per-tile encoding + history state. Allocated lazily when a client first
/// views the tile; `refcount` tracks how many client views currently include
/// it so it can be torn down when it drops to zero.
pub struct TileState {
    pub deflate_enc: FftDeflateEncoder,
    pub deflate_floor_enc: FftDeflateEncoder,
    pub history: FftBuffer,
    pub refcount: usize,
}

impl TileState {
    /// Builds a tile with a pre-allocated history ring of `tile_bins` bins.
    ///
    /// Allocating `history` (up to `history_frames * tile_bins * 4` bytes) is
    /// the heavy part — callers should run `new` under `spawn_blocking`.
    pub fn new(tile_bins: usize, history_frames: usize) -> Self {
        let history = FftBuffer::new(history_frames);
        history.init_frames(tile_bins);
        Self {
            deflate_enc: FftDeflateEncoder::new(tile_bins),
            deflate_floor_enc: FftDeflateEncoder::new(tile_bins),
            history,
            refcount: 0,
        }
    }
}

/// One resolution tier: a fixed fold `factor`, its total bin count across the
/// full span, and the lazily-built tiles that subdivide it.
pub struct TierState {
    /// Fold factor applied to the finest frame (`1 << tier`): 1, 2, 4, 8.
    pub factor: usize,
    /// Total bins this tier spans (`fftSize / factor`).
    pub bins: usize,
    /// One slot per tile; `None` until a client views that tile.
    pub tiles: Vec<Option<TileState>>,
    /// Reusable fold output buffer (tier 0 is an identity copy).
    pub fold_buf: Vec<f32>,
}

impl TierState {
    pub fn new(factor: usize, bins: usize, tiles_per_tier: usize) -> Self {
        let mut tiles = Vec::with_capacity(tiles_per_tier);
        tiles.resize_with(tiles_per_tier, || None);
        Self {
            factor,
            bins,
            tiles,
            fold_buf: Vec::with_capacity(bins),
        }
    }

    /// Whether at least one tile in this tier is currently active.
    pub fn any_active(&self) -> bool {
        self.tiles.iter().any(|t| t.is_some())
    }
}

/// The per-dongle tier model.
///
/// `fft_size` is the finest bin count; `effective_tile_bins` is clamped to
/// `min(waterfall_tile_bins, fft_size / 8)`. Below the tiered path's intended
/// `fft_size` range (8192..=65536) the model still works — it simply degrades
/// to fewer/larger tiles via the clamp.
pub struct TierModel {
    pub fft_size: usize,
    pub effective_tile_bins: usize,
    pub history_frames: usize,
    pub tiers: [TierState; NUM_TIERS],
}

impl TierModel {
    /// Builds an (empty, no tiles allocated) tier model for `fft_size`.
    pub fn new(fft_size: usize, waterfall_tile_bins: usize, history_frames: usize) -> Self {
        let effective_tile_bins = effective_tile_bins(fft_size, waterfall_tile_bins);
        let tiers = std::array::from_fn(|t| {
            let factor = 1usize << t;
            let bins = (fft_size / factor).max(1);
            let tiles_per_tier = (bins / effective_tile_bins).max(1);
            TierState::new(factor, bins, tiles_per_tier)
        });
        Self {
            fft_size,
            effective_tile_bins,
            history_frames,
            tiers,
        }
    }

    /// Number of tiles in tier `t`.
    pub fn tiles_per_tier(&self, tier: usize) -> usize {
        self.tiers[tier].tiles.len()
    }
}

/// A client's currently-active waterfall view: the resolution tier plus the
/// sorted set of tile indices its viewport overlaps. Used to route tiled
/// frames and to drop tile refcounts when the view changes or the client
/// leaves.
#[derive(Debug, Clone, Default)]
pub struct WaterfallView {
    pub tier: usize,
    pub tiles: Vec<usize>,
}

/// `effectiveTileBins = min(waterfall_tile_bins, fft_size / 8)`, floored at 1.
pub fn effective_tile_bins(fft_size: usize, waterfall_tile_bins: usize) -> usize {
    waterfall_tile_bins.min((fft_size / 8).max(1)).max(1)
}

/// Clamp a tier index to the valid `0..NUM_TIERS` range.
pub fn clamp_tier(tier: i64) -> usize {
    tier.clamp(0, NUM_TIERS as i64 - 1) as usize
}

/// Target tier for a view: `round(log2((end_frac - start_frac) * tierBins0 /
/// viewport_px))`, clamped to `0..NUM_TIERS`.
///
/// Returns tier 0 (finest) when inputs are degenerate (non-positive viewport
/// or span), which is the safe, highest-fidelity default.
pub fn target_tier(fft_size: usize, viewport_px: i64, start_frac: f64, end_frac: f64) -> usize {
    let span = end_frac - start_frac;
    if viewport_px <= 0 || span <= 0.0 || fft_size == 0 {
        return 0;
    }
    let visible_bins = span * fft_size as f64;
    let ratio = visible_bins / viewport_px as f64;
    if ratio <= 0.0 || !ratio.is_finite() {
        return 0;
    }
    let tier = ratio.log2().round() as i64;
    clamp_tier(tier)
}

/// The inclusive set of tile indices at `tier` overlapping `[start_frac,
/// end_frac]`. Returns an empty vec for a degenerate span.
pub fn overlapping_tiles(
    model: &TierModel,
    tier: usize,
    start_frac: f64,
    end_frac: f64,
) -> Vec<usize> {
    let count = model.tiles_per_tier(tier);
    if count == 0 || end_frac <= start_frac {
        return Vec::new();
    }
    let start = start_frac.clamp(0.0, 1.0);
    let end = end_frac.clamp(0.0, 1.0);
    let first = ((start * count as f64).floor() as isize).max(0) as usize;
    // `end` maps to a tile boundary; subtract a hair so a view that ends
    // exactly on a boundary does not pull in the next (non-overlapping) tile.
    let last_f = (end * count as f64).ceil() as isize - 1;
    let last = last_f.clamp(first as isize, count as isize - 1) as usize;
    (first..=last).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_tile_bins_clamps_to_eighth() {
        assert_eq!(effective_tile_bins(8192, 1024), 1024); // 8192/8 = 1024
        assert_eq!(effective_tile_bins(4096, 1024), 512); // 4096/8 = 512 < 1024
        assert_eq!(effective_tile_bins(65536, 1024), 1024);
        assert_eq!(effective_tile_bins(65536, 4096), 4096);
    }

    #[test]
    fn tier_model_shape() {
        let m = TierModel::new(8192, 1024, 1024);
        assert_eq!(m.effective_tile_bins, 1024);
        assert_eq!(m.tiers[0].bins, 8192);
        assert_eq!(m.tiers[1].bins, 4096);
        assert_eq!(m.tiers[2].bins, 2048);
        assert_eq!(m.tiers[3].bins, 1024);
        assert_eq!(m.tiles_per_tier(0), 8); // 8192/1024
        assert_eq!(m.tiles_per_tier(1), 4);
        assert_eq!(m.tiles_per_tier(2), 2);
        assert_eq!(m.tiles_per_tier(3), 1);
        assert!(!m.tiers[0].any_active());
    }

    #[test]
    fn target_tier_zoom_levels() {
        // Full span, 1024 px viewport, 8192 bins: 8192/1024 = 8 => log2 = 3.
        assert_eq!(target_tier(8192, 1024, 0.0, 1.0), 3);
        // Quarter span: 2048 visible bins / 1024 px = 2 => log2 = 1.
        assert_eq!(target_tier(8192, 1024, 0.0, 0.25), 1);
        // 1/8 span: 1024 visible / 1024 px = 1 => log2 = 0 (finest).
        assert_eq!(target_tier(8192, 1024, 0.0, 0.125), 0);
        // Very zoomed in clamps to finest tier 0.
        assert_eq!(target_tier(8192, 1024, 0.0, 0.001), 0);
    }

    #[test]
    fn target_tier_degenerate_inputs() {
        assert_eq!(target_tier(8192, 0, 0.0, 1.0), 0);
        assert_eq!(target_tier(8192, 1024, 0.5, 0.5), 0);
        assert_eq!(target_tier(0, 1024, 0.0, 1.0), 0);
    }

    #[test]
    fn overlapping_tiles_cover_range() {
        let m = TierModel::new(8192, 1024, 1024); // tier0 has 8 tiles
        assert_eq!(overlapping_tiles(&m, 0, 0.0, 1.0), vec![0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(overlapping_tiles(&m, 0, 0.0, 0.125), vec![0]);
        assert_eq!(overlapping_tiles(&m, 0, 0.25, 0.5), vec![2, 3]);
        // Coarsest tier has a single tile covering everything.
        assert_eq!(overlapping_tiles(&m, 3, 0.4, 0.6), vec![0]);
    }

    #[test]
    fn overlapping_tiles_rejects_empty_span() {
        let m = TierModel::new(8192, 1024, 1024);
        assert!(overlapping_tiles(&m, 0, 0.5, 0.5).is_empty());
        assert!(overlapping_tiles(&m, 0, 0.6, 0.4).is_empty());
    }
}
