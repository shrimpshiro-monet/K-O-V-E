#!/usr/bin/env python3
"""
Generate golden loudness values from INDEPENDENT implementations for
src/audio/loudness/loudness.oracle.test.ts:

  * ffmpeg's `ebur128` filter (a port of libebur128; integrated, LRA, true peak)
  * pyloudnorm (BS.1770-4, integrated only)

Signals are deterministic closed-form (same formula as `oracleSignal()` in the TS test), rounded to
float32 before measuring, so both sides see the same samples.

    python3 -m venv /tmp/oracle && /tmp/oracle/bin/pip install numpy scipy pyloudnorm imageio-ffmpeg
    /tmp/oracle/bin/python scripts/loudness-oracle.py > src/audio/loudness/oracle.golden.json

The TS test needs neither Python nor ffmpeg at run time.
"""
import json, re, subprocess, sys, tempfile, os
import numpy as np
from scipy.io import wavfile
import pyloudnorm as pyln
import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
SECONDS = 40

CASES = [
    {"name": "stereo-44k1", "fs": 44100, "channels": 2},
    {"name": "stereo-48k", "fs": 48000, "channels": 2},
    {"name": "stereo-96k", "fs": 96000, "channels": 2},
    {"name": "mono-48k", "fs": 48000, "channels": 1},
    {"name": "5.1-48k", "fs": 48000, "channels": 6},
]

def oracle_signal(fs, channels, seconds=SECONDS):
    n = int(round(seconds * fs))
    t = np.arange(n, dtype=np.float64) / fs
    out = []
    for c in range(channels):
        x = (0.25 * np.sin(2*np.pi*220*t + 0.3*c)
             + 0.15 * np.sin(2*np.pi*1375*t + 1.1)
             + 0.10 * np.sin(2*np.pi*5200*t + 0.7*c)
             + 0.05 * np.sin(2*np.pi*13000*t))
        env = np.power(10.0, (-18.0 * (0.5 + 0.5*np.sin(2*np.pi*t/17.0))) / 20.0)
        x = x * env
        k = int(round(10.0 * fs))           # two adjacent hot samples -> inter-sample overshoot
        x[k] += 0.9; x[k+1] += 0.9
        out.append(x.astype(np.float32))
    return np.stack(out, axis=1)

def ffmpeg_measure(path):
    # Per-frame metadata carries 3 decimals; the last frame holds the final I / LRA values.
    p = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-af",
                        "ebur128=metadata=1:peak=true:framelog=quiet,ametadata=mode=print:file=-",
                        "-f", "null", "-"], capture_output=True, text=True)
    last = lambda key: float(re.findall(r"lavfi\.r128\." + re.escape(key) + r"=(-?[\d.]+)", p.stdout)[-1])
    err = p.stderr
    summary = err[err.rindex("Summary:"):]
    tp = float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", summary).group(1))   # summary: 0.1 dB resolution
    return {"integratedLufs": last("I"), "loudnessRangeLu": last("LRA"), "truePeakDbtp": tp}

res = {"generator": "scripts/loudness-oracle.py", "seconds": SECONDS,
       "ffmpeg": subprocess.run([FFMPEG, "-version"], capture_output=True, text=True).stdout.splitlines()[0],
       "pyloudnorm": getattr(pyln, "__version__", "unknown"), "cases": {}}
for c in CASES:
    sig = oracle_signal(c["fs"], c["channels"])
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "x.wav")
        wavfile.write(path, c["fs"], sig)
        ff = ffmpeg_measure(path)
    entry = {"fs": c["fs"], "channels": c["channels"], "ffmpeg": ff}
    if c["channels"] in (1, 2):
        entry["pyloudnorm"] = {"integratedLufs": float(pyln.Meter(c["fs"]).integrated_loudness(sig.astype(np.float64)))}
    res["cases"][c["name"]] = entry
json.dump(res, sys.stdout, indent=2); print()
