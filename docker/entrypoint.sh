#!/bin/sh
# Detects CPU level and runs the appropriate binary

arch=$(uname -m)
# ARM64 doesn't use GOAMD64 - just run v1
if [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then
    exec /app/serverng-v1 "$@"
fi

# Detect x86-64 level from /proc/cpuinfo
FLAGS=$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null | cut -d: -f2)
FLAGS=" $FLAGS "

# Check v4 (AVX512)
if echo "$FLAGS" | grep -q " avx512f " && \
   echo "$FLAGS" | grep -q " avx512bw " && \
   echo "$FLAGS" | grep -q " avx512cd " && \
   echo "$FLAGS" | grep -q " avx512dq " && \
   echo "$FLAGS" | grep -q " avx512vl "; then
    exec /app/serverng-v4 "$@"
fi

# Check v3 (AVX2, BMI, FMA)
if echo "$FLAGS" | grep -q " avx " && \
   echo "$FLAGS" | grep -q " avx2 " && \
   echo "$FLAGS" | grep -q " bmi1 " && \
   echo "$FLAGS" | grep -q " bmi2 " && \
   echo "$FLAGS" | grep -q " f16c " && \
   echo "$FLAGS" | grep -q " fma " && \
   echo "$FLAGS" | grep -q " abm " && \
   echo "$FLAGS" | grep -q " movbe " && \
   echo "$FLAGS" | grep -q " xsave "; then
    exec /app/serverng-v3 "$@"
fi

# Check v2 (SSE4, POPCNT)
if echo "$FLAGS" | grep -q " cx16 " && \
   echo "$FLAGS" | grep -q " lahf_lm " && \
   echo "$FLAGS" | grep -q " popcnt " && \
   echo "$FLAGS" | grep -q " sse4_1 " && \
   echo "$FLAGS" | grep -q " sse4_2 " && \
   echo "$FLAGS" | grep -q " ssse3 "; then
    exec /app/serverng-v2 "$@"
fi

# Default to v1
exec /app/serverng-v1 "$@"
