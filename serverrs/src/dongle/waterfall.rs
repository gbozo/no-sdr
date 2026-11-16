//! Server-side segmented multi-tier waterfall state.
//!
//! The tiered waterfall serves each client only the spectrum tiles that
//! overlap its current viewport, at a resolution tier chosen to roughly match
//! one bin per CSS pixel. This keeps bandwidth bounded while a client is zoomed
//! in, and lets a zoomed-out client receive a coarse (folded) view of the full
//! span.
//!
//! Model (frozen wire contract):
//!   * `tierBins[t] = fftSize >> t` for `t` in `0..tierCount` — consecutive
//!     octave folds (`fftSize, /2, /4, … /2^(tierCount-1)`). Every tier covers
//!     the full span; tier 0 is finest.
//!   * `effectiveTileBins = min(waterfallTileBins, fftSize / 8)`.
//!   * `tilesPerTier[t] = tierBins[t] / effectiveTileBins`.
//!   * `tileIndex 0` = lowest-Hz edge; wire bin 0 = lowest Hz.
//!
//! The ladder is generated, not configured bin by bin: operators choose how
//! many tiers they want (`waterfallTierCount`, 0 = as many as are useful) and
//! the model folds one octave per tier. Folding stops when the coarsest tier
//! would no longer hold one whole tile — beyond that, tiers only add state and
//! folders for no visible benefit.
//!
//! Tiles are built lazily: a tile's history ring is only allocated once at
//! least one client's view overlaps it, and torn down when the last such
//! client leaves.

use std::sync::Arc;

use crate::codec::FftDeflateEncoder;
use crate::history::FftBuffer;

/// Hard ceiling on the ladder. A tier index travels as a u8, and each extra
/// tier doubles the fold range (2^(MAX_TIERS-1) = 128×), which is far past the
/// point where a 1024-bin tile stops being useful.
pub const MAX_TIERS: usize = 8;

/// Per-tile encoding + history state. Allocated lazily when a client first
/// views the tile; `refcount` tracks how many client views currently include
/// it so it can be torn down when it drops to zero.
pub struct TileState {
    pub deflate_enc: FftDeflateEncoder,
    pub deflate_floor_enc: FftDeflateEncoder,
    /// `Arc` so the prefill path can clone the handle and read the ring
    /// without holding the per-dongle `tiers` lock (a full 1024-frame ring is
    /// several MiB of memcpy and must not stall the FFT broadcast).
    pub history: Arc<FftBuffer>,
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
            history: Arc::new(history),
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
    /// Frame sequence in which `fold_buf` was last filled. Lets the broadcast
    /// path reuse the fold computed by `push_tiered_history` for the same
    /// frame instead of folding the source frame twice.
    pub folded_seq: u64,
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
            // Never equal to a real `TierModel::seq`, so a freshly built model
            // always folds before its buffer is read.
            folded_seq: u64::MAX,
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
    /// Fold ladder: `tiers[t].factor == 1 << t`, one octave per tier.
    pub tiers: Vec<TierState>,
    /// Monotonic frame counter. Incremented once per finest frame; used to
    /// recognise a `fold_buf` that already holds the current frame.
    pub seq: u64,
}

impl TierModel {
    /// Builds an (empty, no tiles allocated) tier model for `fft_size`.
    ///
    /// `requested_tiers` is the operator's `waterfallTierCount`; `0` means
    /// "as many as are useful". The request is clamped to `1..=MAX_TIERS` and
    /// then to what the FFT/tile geometry can actually use (see
    /// [`Self::max_tiers_for`]), so the coarsest tier always keeps one whole
    /// tile and no tier is ever a single undersized sliver.
    pub fn new(
        fft_size: usize,
        waterfall_tile_bins: usize,
        history_frames: usize,
        requested_tiers: usize,
    ) -> Self {
        let effective_tile_bins = effective_tile_bins(fft_size, waterfall_tile_bins);
        let max_tiers = Self::max_tiers_for(fft_size, effective_tile_bins);
        let count = if requested_tiers == 0 {
            max_tiers
        } else {
            requested_tiers.clamp(1, MAX_TIERS).min(max_tiers)
        };
        let tiers = (0..count)
            .map(|t| {
                let factor = 1usize << t;
                let bins = (fft_size / factor).max(1);
                let tiles_per_tier = (bins / effective_tile_bins).max(1);
                TierState::new(factor, bins, tiles_per_tier)
            })
            .collect();
        Self {
            fft_size,
            effective_tile_bins,
            history_frames,
            tiers,
            seq: 0,
        }
    }

    /// Largest useful ladder: one octave per tier until the coarsest tier would
    /// hold less than one full tile. For 8192 bins with 1024-bin tiles that is
    /// 4 tiers (8192…1024); for 16384 it is 5 (…1024); for 65536 it is 7.
    pub fn max_tiers_for(fft_size: usize, effective_tile_bins: usize) -> usize {
        let ratio = (fft_size / effective_tile_bins.max(1)).max(1);
        (ratio.ilog2() as usize + 1).min(MAX_TIERS)
    }

    /// Number of tiers in the ladder (0..=MAX_TIERS).
    pub fn tier_count(&self) -> usize {
        self.tiers.len()
    }

    /// Number of tiles in tier `t`.
    pub fn tiles_per_tier(&self, tier: usize) -> usize {
        self.tiers[tier].tiles.len()
    }

    /// Clamp a tier index to this model's ladder.
    pub fn clamp_tier(&self, tier: i64) -> usize {
        tier.clamp(0, self.tiers.len() as i64 - 1) as usize
    }

    /// Target tier for a view: `round(log2((end_frac - start_frac) * fft_size /
    /// viewport_px))`, clamped to this ladder.
    ///
    /// Returns tier 0 (finest) when inputs are degenerate (non-positive viewport
    /// or span), which is the safe, highest-fidelity default.
    pub fn target_tier(&self, viewport_px: i64, start_frac: f64, end_frac: f64) -> usize {
        let span = end_frac - start_frac;
        if viewport_px <= 0 || span <= 0.0 || self.fft_size == 0 {
            return 0;
        }
        let visible_bins = span * self.fft_size as f64;
        let ratio = visible_bins / viewport_px as f64;
        if ratio <= 0.0 || !ratio.is_finite() {
            return 0;
        }
        self.clamp_tier(ratio.log2().round() as i64)
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
    fn tile_history_is_shared_and_preallocated() {
        let tile = TileState::new(64, 8);
        // Ring pre-allocated to the tile width, empty until the first frame.
        assert_eq!(tile.history.fft_size(), 64);
        assert_eq!(tile.history.count(), 0);
        // The prefill path clones the Arc instead of holding the tiers lock.
        let shared = Arc::clone(&tile.history);
        assert_eq!(Arc::strong_count(&tile.history), 2);
        drop(shared);
        assert_eq!(Arc::strong_count(&tile.history), 1);
    }

    #[test]
    fn tier_model_starts_unfolded() {
        let m = TierModel::new(8192, 1024, 256, 0);
        assert_eq!(m.seq, 0);
        // u64::MAX can never match a real sequence, so the first frame always
        // folds before the broadcast path reads a tier's fold buffer.
        for tier in &m.tiers {
            assert_eq!(tier.folded_seq, u64::MAX);
        }
    }

    #[test]
    fn effective_tile_bins_clamps_to_eighth() {
        assert_eq!(effective_tile_bins(8192, 1024), 1024); // 8192/8 = 1024
        assert_eq!(effective_tile_bins(4096, 1024), 512); // 4096/8 = 512 < 1024
        assert_eq!(effective_tile_bins(65536, 1024), 1024);
        assert_eq!(effective_tile_bins(65536, 4096), 4096);
    }

    #[test]
    fn tier_model_shape() {
        // 8192 bins / 1024-bin tiles = 8 octaves of usable fold => 4 tiers.
        let m = TierModel::new(8192, 1024, 1024, 0);
        assert_eq!(m.effective_tile_bins, 1024);
        assert_eq!(m.tier_count(), 4);
        assert_eq!(m.tiers[0].factor, 1);
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
    fn tier_ladder_auto_scales_with_fft_size() {
        // One octave per tier until the coarsest tier is one full tile.
        assert_eq!(TierModel::new(8192, 1024, 256, 0).tier_count(), 4);
        assert_eq!(TierModel::new(16384, 1024, 256, 0).tier_count(), 5);
        assert_eq!(TierModel::new(32768, 1024, 256, 0).tier_count(), 6);
        assert_eq!(TierModel::new(65536, 1024, 256, 0).tier_count(), 7);
        // Coarsest tier never drops below one whole tile.
        let m = TierModel::new(16384, 1024, 256, 0);
        assert_eq!(m.tiers[m.tier_count() - 1].bins, 1024);
        assert_eq!(m.tiles_per_tier(m.tier_count() - 1), 1);
        // Small FFTs (effectiveTileBins clamped to fft/8) still work.
        assert_eq!(TierModel::new(2048, 1024, 256, 0).tier_count(), 4);
    }

    #[test]
    fn tier_ladder_respects_requested_count() {
        // Explicit counts truncate the octave ladder.
        assert_eq!(TierModel::new(16384, 1024, 256, 1).tier_count(), 1);
        assert_eq!(TierModel::new(16384, 1024, 256, 3).tier_count(), 3);
        assert_eq!(TierModel::new(16384, 1024, 256, 5).tier_count(), 5);
        // Too many for the geometry: clamped to the useful maximum.
        assert_eq!(TierModel::new(8192, 1024, 256, 8).tier_count(), 4);
        // Out-of-range requests are clamped, never zero tiers.
        assert_eq!(TierModel::new(8192, 1024, 256, 99).tier_count(), 4);
    }

    #[test]
    fn max_tiers_respects_hard_ceiling() {
        // A 256-bin tile on a 131072-bin FFT would allow 10 octaves.
        assert_eq!(TierModel::max_tiers_for(131072, 256), MAX_TIERS);
        assert_eq!(TierModel::new(131072, 256, 256, 0).tier_count(), MAX_TIERS);
        assert_eq!(TierModel::new(131072, 256, 256, 99).tier_count(), MAX_TIERS);
    }

    #[test]
    fn target_tier_zoom_levels() {
        let m = TierModel::new(8192, 1024, 1024, 0);
        // Full span, 1024 px viewport, 8192 bins: 8192/1024 = 8 => log2 = 3.
        assert_eq!(m.target_tier(1024, 0.0, 1.0), 3);
        // Quarter span: 2048 visible bins / 1024 px = 2 => log2 = 1.
        assert_eq!(m.target_tier(1024, 0.0, 0.25), 1);
        // 1/8 span: 1024 visible / 1024 px = 1 => log2 = 0 (finest).
        assert_eq!(m.target_tier(1024, 0.0, 0.125), 0);
        // Very zoomed in clamps to finest tier 0.
        assert_eq!(m.target_tier(1024, 0.0, 0.001), 0);
        // A shorter ladder clamps the same request to its coarsest tier.
        let short = TierModel::new(8192, 1024, 1024, 2);
        assert_eq!(short.target_tier(1024, 0.0, 1.0), 1);
    }

    #[test]
    fn target_tier_degenerate_inputs() {
        let m = TierModel::new(8192, 1024, 1024, 0);
        assert_eq!(m.target_tier(0, 0.0, 1.0), 0);
        assert_eq!(m.target_tier(1024, 0.5, 0.5), 0);
        let empty = TierModel::new(0, 1024, 1024, 0);
        assert_eq!(empty.target_tier(1024, 0.0, 1.0), 0);
    }

    #[test]
    fn overlapping_tiles_cover_range() {
        let m = TierModel::new(8192, 1024, 1024, 0); // tier0 has 8 tiles
        assert_eq!(overlapping_tiles(&m, 0, 0.0, 1.0), vec![0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(overlapping_tiles(&m, 0, 0.0, 0.125), vec![0]);
        assert_eq!(overlapping_tiles(&m, 0, 0.25, 0.5), vec![2, 3]);
        // Coarsest tier has a single tile covering everything.
        assert_eq!(overlapping_tiles(&m, 3, 0.4, 0.6), vec![0]);
    }

    #[test]
    fn overlapping_tiles_rejects_empty_span() {
        let m = TierModel::new(8192, 1024, 1024, 0);
        assert!(overlapping_tiles(&m, 0, 0.5, 0.5).is_empty());
        assert!(overlapping_tiles(&m, 0, 0.6, 0.4).is_empty());
    }
}
