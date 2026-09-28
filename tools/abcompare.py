#!/usr/bin/env python3
"""Compare two renders of the same module.

Aligns B to A by cross-correlating 10 ms loudness envelopes, then reports the
waveform correlation per second so that the moments where the two players
disagree can be located. Both files must be 16 bit stereo WAV at the same rate.

Usage: abcompare.py A.wav B.wav [seconds] [--worst N]
"""
import math
import struct
import sys
import wave


def load(path, seconds):
    w = wave.open(path)
    sr = w.getframerate()
    n = min(w.getnframes(), int(seconds * sr))
    d = w.readframes(n)
    w.close()
    s = struct.unpack("<%dh" % (len(d) // 2), d)
    return sr, [(s[i] + s[i + 1]) / 65536.0 for i in range(0, len(s), 2)]


def envelope(x, hop):
    return [math.sqrt(sum(v * v for v in x[i:i + hop]) / hop) for i in range(0, len(x) - hop, hop)]


def corr(a, b):
    n = min(len(a), len(b))
    if n < 2:
        return 0.0
    a, b = a[:n], b[:n]
    ma, mb = sum(a) / n, sum(b) / n
    sa = math.sqrt(sum((v - ma) ** 2 for v in a)) or 1e-12
    sb = math.sqrt(sum((v - mb) ** 2 for v in b)) or 1e-12
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    worst = 8
    if "--worst" in sys.argv:
        worst = int(sys.argv[sys.argv.index("--worst") + 1])
    seconds = float(args[2]) if len(args) > 2 else 60
    sr, a = load(args[0], seconds)
    sr2, b = load(args[1], seconds)
    assert sr == sr2, "sample rates differ"

    hop = sr // 100
    ea, eb = envelope(a, hop), envelope(b, hop)
    best = max(((corr(ea[max(0, -l):], eb[max(0, l):]), l) for l in range(-100, 101)), key=lambda t: t[0])
    lag = best[1] * hop                      # B starts this many frames later than A
    if lag > 0:
        b = b[lag:]
    else:
        a = a[-lag:]
    # refine to the sample within +-2 ms using the first 5 s of waveform
    win = min(len(a), len(b), 5 * sr)
    fine = max(((corr(a[max(0, -l):win], b[max(0, l):win]), l) for l in range(-2 * sr // 1000, 2 * sr // 1000 + 1, 4)), key=lambda t: t[0])
    if fine[1] > 0:
        b = b[fine[1]:]
    elif fine[1] < 0:
        a = a[-fine[1]:]
    total_lag_ms = (lag + fine[1]) * 1000.0 / sr

    print(f"alignment: B lags A by {total_lag_ms:+.1f} ms (envelope corr {best[0]:+.3f})")
    n = min(len(a), len(b))
    print(f"overall waveform correlation: {corr(a[:n], b[:n]):+.3f}")
    rms_a = math.sqrt(sum(v * v for v in a[:n]) / n)
    rms_b = math.sqrt(sum(v * v for v in b[:n]) / n)
    print(f"rms A {rms_a:.3f}  B {rms_b:.3f}  ({20 * math.log10(rms_b / rms_a):+.1f} dB)")

    per_sec = []
    for s in range(n // sr):
        seg_a, seg_b = a[s * sr:(s + 1) * sr], b[s * sr:(s + 1) * sr]
        per_sec.append((corr(seg_a, seg_b), s))
    print("per-second waveform correlation:")
    line = ""
    for c, s in per_sec:
        line += f"{c:+.2f} "
        if s % 10 == 9:
            print(f"  {s - 9:3d}s: {line}")
            line = ""
    if line:
        print(f"  {len(per_sec) - len(line.split()):3d}s: {line}")
    print(f"worst {worst} seconds:", ", ".join(f"{s}s ({c:+.2f})" for c, s in sorted(per_sec)[:worst]))


if __name__ == "__main__":
    main()
