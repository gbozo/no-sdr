//! Hardware smoke test for the native RTL-SDR driver.
//!
//! Run with the dongle attached:
//!
//! ```sh
//! cargo run --release --example rtlsdr_probe
//! ```
//!
//! It enumerates the bus, opens the first dongle, streams a little I/Q at
//! 100 MHz, 433.92 MHz and (via direct sampling) 14.074 MHz, and reports the
//! byte counts and raw sample statistics. `SERVERRS_TEST_BIAS_T=1` also
//! exercises the bias tee for a second; leave it unset with an unknown antenna.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use serverrs::dongle::{enumerate_local_devices, RtlSdrSource, Source};
use tokio::sync::{mpsc, watch};
use tokio::time::{timeout, Instant};

struct Stats {
    bytes: usize,
    chunks: u64,
    mean: f64,
    min: u8,
    max: u8,
    near_mid: f64,
}

async fn collect(rx: &mut mpsc::Receiver<Vec<u8>>, want: usize, secs: u64) -> Stats {
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut bytes = 0usize;
    let mut chunks = 0u64;
    let mut sum = 0f64;
    let mut count = 0u64;
    let mut min = u8::MAX;
    let mut max = 0u8;
    let mut near_mid = 0u64;

    while bytes < want {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        let Ok(Some(chunk)) = timeout(left, rx.recv()).await else {
            break;
        };
        chunks += 1;
        bytes += chunk.len();
        for &b in &chunk {
            sum += b as f64;
            count += 1;
            min = min.min(b);
            max = max.max(b);
            if b.abs_diff(127) <= 8 {
                near_mid += 1;
            }
        }
    }

    Stats {
        bytes,
        chunks,
        mean: if count == 0 { 0.0 } else { sum / count as f64 },
        min,
        max,
        near_mid: if count == 0 {
            0.0
        } else {
            near_mid as f64 / count as f64
        },
    }
}

fn report(label: &str, s: &Stats) {
    println!(
        "{label}: {} bytes in {} chunks | u8 mean {:.1}, min {}, max {}, near-mid {:.1}%",
        s.bytes,
        s.chunks,
        s.mean,
        s.min,
        s.max,
        s.near_mid * 100.0
    );
    if s.bytes == 0 {
        println!("  !! no samples");
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let devices = tokio::task::spawn_blocking(enumerate_local_devices)
        .await
        .context("enumeration task")?;
    if devices.is_empty() {
        bail!("no RTL-SDR dongle found on USB");
    }
    for d in &devices {
        println!(
            "#{} {} | manufact={:?} product={:?} serial={:?}",
            d.index, d.name, d.manufact, d.product, d.serial
        );
    }

    let source = tokio::task::spawn_blocking(|| RtlSdrSource::open(0, ""))
        .await
        .context("open task")??;
    println!("opened: {}", Source::description(&source));

    let Some(cmd) = Source::command_handle(&source) else {
        bail!("source has no command handle");
    };

    let (tx, mut rx) = mpsc::channel(32);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let source: Box<dyn Source> = Box::new(source);
    let run = tokio::spawn(source.run(tx, cancel_rx));

    let bias_test = std::env::var_os("SERVERRS_TEST_BIAS_T").is_some();
    let mut ok = true;

    // --- VHF, tuner path -------------------------------------------------
    cmd.set_frequency(100_000_000)?;
    cmd.set_sample_rate(2_400_000)?;
    cmd.set_gain_mode(1)?;
    cmd.set_gain(300)?;
    cmd.set_frequency_correction(0)?;
    cmd.set_direct_sampling(0)?;
    cmd.set_agc_mode(0)?;
    cmd.set_bias_t(0)?;
    let s = collect(&mut rx, 2 * 1024 * 1024, 4).await;
    report("100.000 MHz", &s);
    ok &= s.bytes > 0;

    // --- UHF, tuner path -------------------------------------------------
    cmd.set_frequency(433_920_000)?;
    let s = collect(&mut rx, 1024 * 1024, 3).await;
    report("433.920 MHz", &s);
    ok &= s.bytes > 0;

    // --- HF, direct sampling --------------------------------------------
    cmd.set_direct_sampling(2)?;
    cmd.set_frequency(14_074_000)?;
    let s = collect(&mut rx, 1024 * 1024, 3).await;
    report("14.074 MHz (Q-ADC)", &s);
    ok &= s.bytes > 0;

    // --- back to the tuner ----------------------------------------------
    cmd.set_direct_sampling(0)?;
    cmd.set_frequency(100_000_000)?;
    let s = collect(&mut rx, 256 * 1024, 2).await;
    report("back to 100.000 MHz", &s);
    ok &= s.bytes > 0;

    if bias_test {
        println!("bias-T on for 1 s...");
        cmd.set_bias_t(1)?;
        let _ = collect(&mut rx, 64 * 1024, 1).await;
        cmd.set_bias_t(0)?;
        println!("bias-T off");
    } else {
        println!("bias-T not exercised (set SERVERRS_TEST_BIAS_T=1 to test)");
    }

    cancel_tx.send(true).ok();
    if timeout(Duration::from_secs(5), run).await.is_err() {
        println!("stream task did not stop within 5 s");
        ok = false;
    }

    if ok {
        println!("PASS");
        Ok(())
    } else {
        bail!("one or more stages produced no samples")
    }
}
