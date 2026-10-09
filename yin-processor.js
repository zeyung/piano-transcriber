// AudioWorklet: low-latency monophonic pitch detection (YIN) + note tracking.
// Posts { type: 'on' | 'off', midi, time, velocity } in AudioContext time,
// plus periodic { type: 'level', rms, midi } for UI meters.

const WINDOW = 2048;
const HOP = 256;
const YIN_THRESHOLD = 0.15;
// Hop counts for time-based thresholds (sampleRate is a worklet global).
const HOPS = (sec) => Math.max(1, Math.round((sec * sampleRate) / HOP));

class YinProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.gate = o.gate ?? 0.01; // RMS noise gate
    this.buf = new Float32Array(WINDOW);
    this.filled = 0;
    this.sinceHop = 0;
    this.diff = new Float32Array(WINDOW / 2);
    this.tauMin = Math.max(2, Math.floor(sampleRate / 4400)); // up to ~C8
    this.tauMax = Math.min(WINDOW / 2 - 1, Math.ceil(sampleRate / 26)); // down to ~A0 (needs bigger window to be reliable)
    this.current = -1; // sounding midi note
    this.candidate = -1;
    this.candidateCount = 0;
    this.candidateTime = 0;
    this.silentCount = 0;
    this.prevRms = 0;
    this.lastOnset = -1;
    this.lastOff = -1;
    this.lastOffTime = -1;
    this.onsetPending = 0;
    this.levelCounter = 0;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.gate === 'number') this.gate = e.data.gate;
    };
  }

  yin(rms) {
    const b = this.buf;
    const W = WINDOW / 2;
    const d = this.diff;
    const tauMax = this.tauMax;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < W; i++) {
        const delta = b[i] - b[i + tau];
        sum += delta * delta;
      }
      d[tau] = sum;
    }
    // Cumulative mean normalized difference.
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    let tau = -1;
    for (let t = this.tauMin; t <= tauMax; t++) {
      if (d[t] < YIN_THRESHOLD) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0 || rms < this.gate) return { freq: 0, clarity: 0 };
    // Parabolic interpolation.
    let better = tau;
    if (tau > 1 && tau < tauMax) {
      const s0 = d[tau - 1], s1 = d[tau], s2 = d[tau + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) better = tau + (s2 - s0) / denom;
    }
    return { freq: sampleRate / better, clarity: 1 - d[tau] };
  }

  analyse(time) {
    const b = this.buf;
    let sq = 0;
    for (let i = WINDOW - HOP; i < WINDOW; i++) sq += b[i] * b[i];
    const rms = Math.sqrt(sq / HOP);
    const { freq } = this.yin(rms);
    const midi = freq > 0 ? Math.round(69 + 12 * Math.log2(freq / 440)) : -1;
    const valid = midi >= 21 && midi <= 108;

    if (++this.levelCounter % 4 === 0) {
      this.port.postMessage({ type: 'level', rms, midi: valid ? midi : -1 });
    }

    // Time of the start of the newest hop.
    const hopTime = time - HOP / sampleRate;

    // Energy-based onset detection (fast attack vs. slow average).
    const rising = rms > this.prevRms * 1.8 && rms > this.gate * 3;
    if (rising && hopTime - this.lastOnset > 0.06) {
      this.lastOnset = hopTime;
      this.onsetPending = HOPS(0.05); // re-check pitch ~50 ms after the attack
    }
    this.prevRms = this.prevRms * 0.6 + rms * 0.4;
    // Back-date note starts to the energy onset when it is recent.
    const startTime = (t) => (t - this.lastOnset < 0.07 && t >= this.lastOnset ? this.lastOnset : t);

    if (!valid) {
      this.candidate = -1;
      this.candidateCount = 0;
      if (this.current >= 0 && ++this.silentCount >= HOPS(0.03)) {
        this.port.postMessage({ type: 'off', midi: this.current, time: hopTime });
        this.lastOff = this.current;
        this.lastOffTime = hopTime;
        this.current = -1;
      }
      return;
    }
    this.silentCount = 0;

    if (midi !== this.current) {
      if (midi === this.candidate) this.candidateCount++;
      else {
        this.candidate = midi;
        this.candidateCount = 1;
        this.candidateTime = hopTime;
      }
      // Require two agreeing frames (~20 ms) to suppress glitches; more if this is just the
      // decaying tail of the note that was released a moment ago.
      const tail = midi === this.lastOff && hopTime - this.lastOffTime < 0.12;
      if (this.candidateCount >= (tail ? HOPS(0.05) : HOPS(0.016))) {
        const t = startTime(this.candidateTime);
        if (this.current >= 0) this.port.postMessage({ type: 'off', midi: this.current, time: t });
        this.current = midi;
        this.port.postMessage({ type: 'on', midi, time: t, velocity: Math.min(1, Math.max(0.15, rms * 6)) });
        this.candidate = -1;
        this.candidateCount = 0;
        this.onsetPending = 0;
      }
      return;
    }
    this.candidate = -1;
    this.candidateCount = 0;
    // Same pitch as sounding note: a confirmed onset means the key was struck again.
    if (this.onsetPending > 0 && --this.onsetPending === 0) {
      const t = this.lastOnset;
      this.port.postMessage({ type: 'off', midi, time: t });
      this.port.postMessage({ type: 'on', midi, time: t, velocity: Math.min(1, Math.max(0.15, rms * 6)) });
    }
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    const b = this.buf;
    const n = input.length;
    // Shift-in samples (window is a sliding buffer).
    b.copyWithin(0, n);
    b.set(input, WINDOW - n);
    this.filled = Math.min(WINDOW, this.filled + n);
    this.sinceHop += n;
    if (this.sinceHop >= HOP && this.filled >= WINDOW) {
      this.sinceHop = 0;
      this.analyse(currentTime + n / sampleRate);
    }
    return true;
  }
}

registerProcessor('yin-processor', YinProcessor);
