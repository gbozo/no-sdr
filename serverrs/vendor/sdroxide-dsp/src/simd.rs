//! Runtime CPU dispatch for the loops that run at the front end's rate.
//!
//! sdroxide ships one binary per platform, so the compiler may assume no more
//! than the x86-64 baseline: SSE2, whose 128-bit registers a single
//! [`Complex32`](crate::Complex32) fills half of. Rebuilding the whole program
//! with `-C target-cpu=native` was measured at **26 % fewer cycles** against an
//! RX-888 streaming 16.2 Msps — 1.88 down to 1.39 G cycles/s, with the
//! instruction count the steadier of the two numbers and the sample rate fixed
//! by the hardware, so it is work per sample that is being compared. Nearly all
//! of that came from a handful of loops in this crate, none of them doing
//! anything clever: they are element-wise passes over long slices, and a wider
//! register does four or eight at a time.
//!
//! So those loops are compiled two or three times over and the CPU is asked
//! once which copy to run — the same arrangement rustfft uses internally, which
//! is why a profile of a stock build already shows `rustfft::avx::…` symbols in
//! it. Doing that for the loops listed below took a *stock* build from 1.88 to
//! 1.32 G cycles/s, which is past where rebuilding the old code for this exact
//! machine got to.
//!
//! Everything not x86-64 — aarch64, a Raspberry Pi — compiles the portable copy
//! only, and reaches its own vector unit the same way that copy reaches SSE2:
//! through the compiler's auto-vectoriser.
//!
//! # A caveat on the AVX-512 copy
//!
//! It is worth what it costs on the AMD Zen 4/5 and Intel Ice Lake and later
//! parts that run 512-bit FP at full rate — measured at a further 4 % here. On
//! Intel's Skylake-SP and Cascade Lake generation a sustained 512-bit FP load
//! drops the core to a lower licence frequency, and on those parts this arm
//! could plausibly cost more than it saves. That has not been measured — there
//! is no such CPU to hand — so if a report of *worse* performance ever arrives
//! from a machine of that vintage, deleting the `avx512` arm of [`kernel!`] and
//! its detector is the first thing to try; the AVX2 copy carries the bulk of
//! the gain either way.
//!
//! Write a kernel with [`kernel!`]; call the dispatching name from the hot
//! path.

/// Whether this CPU has the features the AVX2 copy of a kernel was built for.
///
/// `is_x86_feature_detected!` caches its answer in an atomic after the first
/// call, so this is a relaxed load on the hot path, not a `cpuid`.
#[cfg(target_arch = "x86_64")]
#[inline(always)]
pub(crate) fn avx2() -> bool {
    std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma")
}

/// Whether this CPU has the features the AVX-512 copy was built for.
#[cfg(target_arch = "x86_64")]
#[inline(always)]
pub(crate) fn avx512() -> bool {
    std::arch::is_x86_feature_detected!("avx512f")
        && std::arch::is_x86_feature_detected!("avx512vl")
        && std::arch::is_x86_feature_detected!("avx512dq")
        && std::arch::is_x86_feature_detected!("avx512bw")
}

/// Define one kernel four times over: the portable body, an AVX2+FMA copy, an
/// AVX-512 copy, and the dispatcher the hot path calls.
///
/// The names are spelled out rather than derived because `macro_rules!` cannot
/// build an identifier; the dispatching one comes first because it is the only
/// one anything outside the kernel names.
///
/// The body is written once and compiled twice, so there is no second copy of
/// the arithmetic to keep in step — a hand-written intrinsics path would be
/// exactly that, and it is how a "fast path" quietly stops matching the slow
/// one. Kernels return `()` and work through `&mut` slices for the same
/// reason: it keeps the two copies textually identical.
macro_rules! kernel {
    (
        $(#[$attr:meta])*
        fn $dispatch:ident / $portable:ident / $avx2:ident / $avx512:ident ( $($p:ident : $t:ty),* $(,)? ) $body:block
    ) => {
        #[inline(always)]
        fn $portable($($p: $t),*) $body

        #[cfg(target_arch = "x86_64")]
        #[target_feature(enable = "avx2,fma")]
        fn $avx2($($p: $t),*) {
            $portable($($p),*)
        }

        #[cfg(target_arch = "x86_64")]
        #[target_feature(enable = "avx512f,avx512vl,avx512dq,avx512bw,fma")]
        fn $avx512($($p: $t),*) {
            $portable($($p),*)
        }

        $(#[$attr])*
        #[inline]
        fn $dispatch($($p: $t),*) {
            #[cfg(target_arch = "x86_64")]
            if $crate::simd::avx512() {
                // SAFETY: as below.
                return unsafe { $avx512($($p),*) };
            }
            #[cfg(target_arch = "x86_64")]
            if $crate::simd::avx2() {
                // SAFETY: the CPU has just reported the features this copy was
                // compiled for, which is the whole of `target_feature`'s
                // contract. Nothing else about the call differs.
                return unsafe { $avx2($($p),*) };
            }
            $portable($($p),*)
        }
    };
}

pub(crate) use kernel;
