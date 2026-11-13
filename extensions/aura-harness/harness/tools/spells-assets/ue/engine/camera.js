import * as THREE from 'three';

// Camera game feel, all of it on the camera rather than in post:
//   - trauma shake (Eiserloh, "Juicing Your Cameras With Math", GDC 2016): offsets = trauma^2 x Perlin
//     noise, so small hits barely move it and big ones slam. Each source keeps its own frequency
//     (earth rumbles at ~8 Hz, lightning cracks at ~30 Hz) and they mix weighted by trauma.
//   - FOV punch and hitstop (Nijman, "The Art of Screenshake", 2013).
// apply() goes right after OrbitControls.update() and restore() right before the next one, so the
// controls never see the offsets and can't accumulate them. No allocations per frame.

const DEG = Math.PI / 180;
const YAW = 2 * DEG, PITCH = 2 * DEG, ROLL = 3 * DEG, MOVE = 0.06; // at trauma 1
const SOURCES = 4, QUEUE = 8;

// 1D gradient noise in [-1, 1] (hashed gradients on the integer lattice, quintic fade)
function grad(i) {
  i = Math.imul(i ^ (i >>> 16), 0x45d9f3b);
  i = Math.imul(i ^ (i >>> 16), 0x45d9f3b);
  return (((i ^ (i >>> 16)) >>> 0) / 2147483648) - 1;
}
function perlin(x, seed) {
  const i = Math.floor(x), f = x - i, s = seed * 1013;
  const a = grad(i + s) * f, b = grad(i + 1 + s) * (f - 1);
  return 2 * (a + (b - a) * f * f * f * (f * (f * 6 - 15) + 10));
}

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3();

export class CameraRig {
  reduced = false; // "Reduce flashes & shake": shake x0.25, no hitstop, no punch
  amount = 1;      // shake multiplier (GUI)
  decay = 1.5;     // trauma lost per second

  constructor() {
    this._src = Array.from({ length: SOURCES }, (_, i) => ({ trauma: 0, freq: 15, phase: 0, seed: i * 6 + 1 }));
    this._queue = Array.from({ length: QUEUE }, () => ({ t: 0, trauma: 0, freq: 15 }));
    this._stop = 0;                                  // hitstop seconds left
    this._punch = { deg: 0, t: 1, dur: 1 };
    this._off = new THREE.Vector3();                 // what apply() added, for restore()
    this._rot = new THREE.Quaternion();
    this._fov = 0;
    this._applied = false;
  }

  // trauma 0..1 (it adds up and clamps); delay in seconds (thunder: distance / 343)
  shake(trauma, freqHz = 15, delay = 0) {
    if (!(trauma > 0)) return;
    if (delay > 0) {
      let slot = this._queue[0];
      for (const q of this._queue) if (q.t <= 0) { slot = q; break; } else if (q.t > slot.t) slot = q; // full: drop the latest
      slot.t = delay; slot.trauma = trauma; slot.freq = freqHz;
      return;
    }
    // same-ish frequency: same source, trauma adds; else a free slot, else the weakest one
    let slot = null, weakest = this._src[0];
    for (const s of this._src) {
      if (s.trauma > 0 && Math.abs(s.freq - freqHz) < 0.2 * freqHz) { slot = s; break; }
      if (s.trauma < weakest.trauma) weakest = s;
    }
    if (!slot) { slot = weakest; slot.trauma = 0; slot.freq = freqHz; }
    slot.trauma = Math.min(1, slot.trauma + trauma);
  }

  // FOV kick: +deg over a frame, then eases back over the rest of `duration`
  punch(deg = 3, duration = 0.08) {
    if (this.reduced) return;
    const p = this._punch;
    if (p.t < p.dur && Math.abs(p.deg) * (1 - p.t / p.dur) > Math.abs(deg)) return; // a bigger one is still running
    p.deg = deg; p.t = 0; p.dur = Math.max(duration, 1e-3);
  }

  hitstop(seconds) {
    if (!this.reduced) this._stop = Math.max(this._stop, seconds);
  }

  // main multiplies the simulation dt by this
  get timeScale() { return this._stop > 0 && !this.reduced ? 0.05 : 1; }

  // dt: real (unscaled) seconds; the shake keeps going through hitstop
  apply(camera, dt) {
    this.restore(camera); // in case restore() was skipped
    dt = dt > 0 ? Math.min(dt, 0.1) : 0;
    for (const q of this._queue) if (q.t > 0 && (q.t -= dt) <= 0) this.shake(q.trauma, q.freq);
    this._stop = Math.max(0, this._stop - dt);

    let total = 0, yaw = 0, pitch = 0, roll = 0, x = 0, y = 0, z = 0;
    for (const s of this._src) {
      if (s.trauma <= 0) continue;
      s.phase = (s.phase + s.freq * dt) % 65536;
      const w = s.trauma, t = s.phase;
      total += w;
      yaw += w * perlin(t, s.seed); pitch += w * perlin(t, s.seed + 1); roll += w * perlin(t, s.seed + 2);
      x += w * perlin(t, s.seed + 3); y += w * perlin(t, s.seed + 4); z += w * perlin(t, s.seed + 5);
      s.trauma = Math.max(0, s.trauma - this.decay * dt);
    }

    this._off.set(0, 0, 0);
    this._rot.identity();
    if (total > 0) {
      const tr = Math.min(total, 1), k = tr * tr * this.amount * (this.reduced ? 0.25 : 1) / total;
      this._rot.setFromEuler(_e.set(pitch * k * PITCH, yaw * k * YAW, roll * k * ROLL, 'YXZ'));
      camera.quaternion.multiply(this._rot);
      this._off.set(x, y, z).multiplyScalar(k * MOVE).applyQuaternion(camera.quaternion);
      camera.position.add(this._off);
    }

    const p = this._punch;
    this._fov = 0;
    if (p.t < p.dur && !this.reduced) {
      const u = p.t / p.dur;
      this._fov = p.deg * (u < 0.2 ? u / 0.2 : ((1 - u) / 0.8) ** 2);
      p.t += dt;
    }
    if (this._fov !== 0) { camera.fov += this._fov; camera.updateProjectionMatrix(); }
    this._applied = true;
  }

  // takes back exactly what apply() added (subtracting, so camera jumps made in between survive)
  restore(camera) {
    if (!this._applied) return;
    this._applied = false;
    camera.position.sub(this._off);
    camera.quaternion.multiply(_q.copy(this._rot).invert());
    if (this._fov !== 0) { camera.fov -= this._fov; camera.updateProjectionMatrix(); }
  }
}
