//! Chains processor blocks together, propagating sample rates.
//!
//! Mirrors `serverng/internal/dsp/pipeline.go`. Blocks own their output
//! buffers, so the pipeline simply threads each stage's output into the next.

use anyhow::{bail, Context, Result};
use num_complex::Complex32;

use super::block::ProcessorBlock;

pub struct Pipeline {
    blocks: Vec<Box<dyn ProcessorBlock>>,
    input_rate: f64,
    output_rate: f64,
    output: Vec<Complex32>,
}

impl Pipeline {
    /// Creates a pipeline from a sequence of blocks, validating rate
    /// propagation and initializing each stage.
    pub fn new(input_rate: f64, mut blocks: Vec<Box<dyn ProcessorBlock>>) -> Result<Self> {
        if blocks.is_empty() {
            bail!("pipeline: at least one block is required");
        }
        if input_rate <= 0.0 {
            bail!("pipeline: inputRate must be positive, got {input_rate}");
        }

        let mut rate = input_rate;
        for (i, block) in blocks.iter_mut().enumerate() {
            let out_rate = block.sample_rate_out(rate);
            if out_rate <= 0.0 {
                bail!(
                    "pipeline: block {i} ({}) returned invalid output rate {out_rate} for input rate {rate}",
                    block.name()
                );
            }
            block
                .init(rate)
                .with_context(|| format!("pipeline: failed to init block {i} ({})", block.name()))?;
            rate = out_rate;
        }

        Ok(Self {
            blocks,
            input_rate,
            output_rate: rate,
            output: Vec::new(),
        })
    }

    pub fn input_rate(&self) -> f64 {
        self.input_rate
    }

    pub fn output_rate(&self) -> f64 {
        self.output_rate
    }

    pub fn blocks(&self) -> &[Box<dyn ProcessorBlock>] {
        &self.blocks
    }

    /// Runs the input through all stages. The returned slice is owned by the
    /// pipeline and reused between calls.
    pub fn process(&mut self, input: &[Complex32]) -> &[Complex32] {
        let mut current = self.blocks[0].process_complex(input);
        for block in self.blocks.iter_mut().skip(1) {
            if current.is_empty() {
                break;
            }
            current = block.process_complex(&current);
        }
        self.output = current;
        &self.output
    }

    pub fn reset(&mut self) {
        for block in &mut self.blocks {
            block.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_bad_rates() {
        assert!(Pipeline::new(48_000.0, Vec::new()).is_err());
        assert!(Pipeline::new(0.0, vec![Box::new(super::super::filter::ButterworthBlock::new(
            1000.0
        ))])
        .is_err());
    }

    #[test]
    fn propagates_rates_through_stages() {
        let p = Pipeline::new(
            2_400_000.0,
            vec![
                Box::new(super::super::nco::NcoBlock::new(0.0)),
                Box::new(super::super::decimate::DecimateBlock::new(10)),
                Box::new(super::super::filter::ButterworthBlock::new(5000.0)),
            ],
        )
        .unwrap();
        assert!((p.output_rate() - 240_000.0).abs() < 1e-9);
    }
}
