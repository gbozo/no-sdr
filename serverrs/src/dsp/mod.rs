//! DSP building blocks.
//!
//! Mirrors `serverng/internal/dsp`.

pub mod block;
pub mod dc_block;
pub mod decimate;
pub mod fanout;
pub mod fft;
pub mod fft_processor;
pub mod filter;
pub mod iq_extractor;
pub mod nco;
pub mod noise_blanker;
pub mod pipeline;
pub mod window;

pub use block::ProcessorBlock;
pub use dc_block::DcBlocker;
pub use decimate::DecimateBlock;
pub use fanout::{FanOut, FanOutReader};
pub use fft::Fft;
pub use fft_processor::{FftProcessor, FftProcessorConfig};
pub use filter::ButterworthBlock;
pub use iq_extractor::{find_decimation_factor, IqExtractor, IqExtractorConfig};
pub use nco::NcoBlock;
pub use noise_blanker::NoiseBlanker;
pub use pipeline::Pipeline;
