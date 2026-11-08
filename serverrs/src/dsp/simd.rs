//! Runtime CPU feature detection for the hot DSP kernels.
//!
//! Release binaries target the x86-64 baseline (SSE2), so loops that would
//! benefit from wider registers are compiled a second time behind
//! `#[target_feature]` and selected once per block. This mirrors how `rustfft`
//! ships portable + AVX kernels in one binary, and keeps the release artifacts
//! portable while using AVX2/AVX-512 when the CPU has them. On aarch64 the
//! portable copy is auto-vectorised for NEON, which is baseline.

/// AVX2 + FMA are both required by the AVX2 kernel copies.
#[cfg(target_arch = "x86_64")]
#[inline(always)]
pub fn avx2() -> bool {
    std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma")
}

/// AVX-512 F/VL/DQ/BW; all four are used by the AVX-512 kernel copies.
#[cfg(target_arch = "x86_64")]
#[inline(always)]
pub fn avx512() -> bool {
    std::arch::is_x86_feature_detected!("avx512f")
        && std::arch::is_x86_feature_detected!("avx512vl")
        && std::arch::is_x86_feature_detected!("avx512dq")
        && std::arch::is_x86_feature_detected!("avx512bw")
}
