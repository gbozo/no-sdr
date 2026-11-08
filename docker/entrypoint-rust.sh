#!/bin/sh
# Selects the best serverrs build for this CPU and execs it.

arch=$(uname -m)

if [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then
    # CPU part numbers from /proc/cpuinfo:
    #   Cortex-A53  0xd03  (Pi 3, Pi Zero 2)
    #   Cortex-A72  0xd08  (Pi 4)
    #   Cortex-A76  0xd0b  (Pi 5)
    # Neoverse/other server cores are treated as A76-class.
    part=$(grep -m1 'CPU part' /proc/cpuinfo 2>/dev/null | awk '{print $NF}')
    case "$part" in
        0xd0b|0xd0c|0xd40|0xd41|0xd44|0xd49)
            exec /app/serverrs-cortex-a76 "$@" ;;
        0xd07|0xd08|0xd09)
            exec /app/serverrs-cortex-a72 "$@" ;;
        *)
            exec /app/serverrs-cortex-a53 "$@" ;;
    esac
fi

if [ "$arch" = "x86_64" ] || [ "$arch" = "amd64" ]; then
    FLAGS=$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null | cut -d: -f2)
    FLAGS=" $FLAGS "

    # v4 (AVX-512)
    if echo "$FLAGS" | grep -q " avx512f " && \
       echo "$FLAGS" | grep -q " avx512bw " && \
       echo "$FLAGS" | grep -q " avx512cd " && \
       echo "$FLAGS" | grep -q " avx512dq " && \
       echo "$FLAGS" | grep -q " avx512vl "; then
        exec /app/serverrs-v4 "$@"
    fi

    # v3 (AVX2, BMI, FMA)
    if echo "$FLAGS" | grep -q " avx " && \
       echo "$FLAGS" | grep -q " avx2 " && \
       echo "$FLAGS" | grep -q " bmi1 " && \
       echo "$FLAGS" | grep -q " bmi2 " && \
       echo "$FLAGS" | grep -q " f16c " && \
       echo "$FLAGS" | grep -q " fma " && \
       echo "$FLAGS" | grep -q " abm " && \
       echo "$FLAGS" | grep -q " movbe " && \
       echo "$FLAGS" | grep -q " xsave "; then
        exec /app/serverrs-v3 "$@"
    fi

    # v2 (SSE4.2, POPCNT)
    if echo "$FLAGS" | grep -q " cx16 " && \
       echo "$FLAGS" | grep -q " lahf_lm " && \
       echo "$FLAGS" | grep -q " popcnt " && \
       echo "$FLAGS" | grep -q " sse4_1 " && \
       echo "$FLAGS" | grep -q " sse4_2 " && \
       echo "$FLAGS" | grep -q " ssse3 "; then
        exec /app/serverrs-v2 "$@"
    fi

    exec /app/serverrs-v1 "$@"
fi

echo "unsupported architecture: $arch" >&2
exit 1
