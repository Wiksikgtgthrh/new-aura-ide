import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';
import { U } from './common.js';

// Gravitational lensing for the void (PLAN 3), one fullscreen pass, only while a void is alive.
// Point-mass (Schwarzschild, weak-field) thin lens as in James, von Tunzelmann, Franklin & Thorne 2015,
// "Gravitational lensing by spinning black holes in astrophysics, and in the movie Interstellar"
// (CQG 32, 065001): a pixel at angle theta from the lens shows the source at
//   beta = theta - thetaE^2 * theta / |theta|^2
// so outside thetaE the background is pushed outwards, at thetaE everything behind the hole is smeared
// into the Einstein ring, and inside it a mirrored second image wraps the shadow. All angles are in
// aspect-corrected screen units (fraction of screen height), from world radii through the projection.
//
// What makes it hold up in a real scene rather than on a skybox:
//   - depth: nothing in front of the lens bends (foreground stays sharp), and the deflection eases in
//     over a couple of Einstein radii behind the lens plane, so there's no seam where the floor
//     crosses it. Beyond that everything bends like the sky. (The thin-lens ratio D_ls / D_s would be
//     the physical weight, but it differs between a dummy and the sky right next to it and tears every
//     depth edge behind the hole; a screen-space pass can't afford to be that honest.)
//   - lookups never land inside the hole's own image (the opaque horizon may or may not be drawn into
//     the source), so the Einstein ring shows what surrounds the hole, never black.
//   - lookups that would leave the screen ease back to the undeflected pixel.
//
// Accretion disk (lenses[i].disk, optional, cleared by every set()): each pixel near the hole traces
// its camera ray as a Schwarzschild null geodesic, x'' = -3/2 h^2 x / r^5 in units of r_s (the
// Binet equation u'' + u = 3/2 u^2 written in Cartesian form, h = |x x v| conserved), through a thin
// Keplerian disk. Every crossing of the disk plane between the ISCO and the outer edge adds emission
// front to back, so the near side passes in front of the shadow, the far side is bent up over it and
// its underside under it, and the n >= 1 images hug the shadow. The shadow edge is the critical impact
// parameter b_c = 3 sqrt(3) / 2 r_s, with a razor photon ring just outside it. Emission: blackbody at
// T ~ r^-3/4 (Shakura-Sunyaev), shifted by g = Doppler * sqrt(1 - r_s / r), intensity ~ g^4, so the
// approaching side is much brighter and bluer; banded, differentially rotating turbulence (Omega ~ r^-1.5).
//
// shell: one expanding photographic-negative spherical shell (the void's collapse), limb-brightened
// like a real thin shell seen in projection.
const MAX = 2, STEPS = 72;

const FRAG = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform sampler3D uNoise3D;
uniform sampler2D uBlackbody;
uniform vec4 uA[${MAX}]; // centre (x * aspect, y), thetaE^2 * strength for a source at infinity, shadow radius
uniform vec4 uB[${MAX}]; // lens view depth, horizon world radius, ring gain, 1 / depth ramp (m)
uniform vec4 uC[${MAX}]; // disk: hole centre (world), r_s (world; 0 = no disk)
uniform vec4 uD[${MAX}]; // disk normal, emission scale
uniform vec4 uE[${MAX}]; // inner, outer radius (r_s), inner temperature (K), orbital speed (fraction of Kepler)
uniform vec4 uF[${MAX}]; // bending 0..1, shadow 0..1, rotation phase (s), one pixel in r_s at the hole
uniform vec4 uG[${MAX}]; // tint rgb, spin (rad/s at the inner edge)
uniform vec4 uH[${MAX}]; // frame-dragging twist of the background (rad at the Einstein ring), -, -, -
uniform vec4 uShell;     // centre (world), radius (m)
uniform vec4 uShell2;    // thickness (m), amount, -, -
uniform int uCount;
uniform vec2 uNearFar;
uniform float uAspect;
uniform float uPx;       // one pixel in screen-height units
uniform vec3 uCamPos;
uniform mat3 uCamRot;
uniform vec2 uInvP;      // 1 / projection[0][0], 1 / projection[1][1]
in vec2 vUv;
out vec4 fragColor;

vec3 blackbody(float k) { return textureLod(uBlackbody, vec2(clamp(log(k / 500.0) / log(40.0), 0.0, 1.0), 0.5), 0.0).rgb; }

// critical impact parameter for bending k (k = 1: Schwarzschild, 3 sqrt(3) / 2)
float critB(float k) { return k >= 0.6667 ? 2.598076 * k : inversesqrt(max(1.0 - k, 1e-3)); }

// banded turbulence in the disk frame: a circle through the noise for the angle (no seam), radius
// stretched so the structure runs in long arcs
float bands(float a, float rho, float seed, float as) {   // rho: 3 * r / r_in (r_s at the usual ISCO)
  vec2 cs = vec2(cos(a), sin(a)) * as;
  float n0 = textureLod(uNoise3D, vec3(cs * 0.05 + 0.5, rho * 0.06 + seed * 0.3), 0.0).r;
  float n1 = textureLod(uNoise3D, vec3(cs * 0.16, rho * 0.15 + seed), 0.0).r;
  float n2 = textureLod(uNoise3D, vec3(cs * 0.4 + 0.31, rho * 0.45 + seed * 1.7 + 0.17), 0.0).r;
  float n3 = textureLod(uNoise3D, vec3(cs * 1.1 + 0.63, rho * 1.4 + seed * 2.3 + 0.41), 0.0).r;
  return (n1 * 0.55 + n2 * 0.3 + n3 * 0.15) * (0.55 + 0.9 * n0);
}

// one pass of the ray (direction v, photon going -v) through the disk plane at xc (r_s units)
void diskHit(int i, vec3 xc, vec3 v, vec3 n, vec3 e1, vec3 e2, inout vec3 em, inout float tr) {
  float rho = length(xc), rin = uE[i].x, rout = uE[i].y;
  if (rho < rin * 0.8 || rho > rout) return;
  vec3 eR = xc / rho, eT = cross(n, eR), vd = normalize(v);
  float x = rho / rin;
  // Kepler speed (static frame) -> Doppler, times gravitational redshift
  float beta = min(uE[i].w * sqrt(0.5 / max(rho - 1.0, 0.6)), 0.95);
  float dop = sqrt(1.0 - beta * beta) / (1.0 - beta * dot(eT, -vd));
  float g = dop * sqrt(max(1.0 - uF[i].x / rho, 0.04));
  // differential rotation; two half-period-shifted layers hide each layer's shear reset
  float a0 = atan(dot(eR, e2), dot(eR, e1));
  float om = uG[i].w * pow(x, -1.5), P = 3.0;
  float f0 = fract(uF[i].z / P), f1 = fract(uF[i].z / P + 0.5), w0 = 1.0 - abs(2.0 * f0 - 1.0);
  // no bending = the blast ring after the collapse: torn into clumps rather than lanes
  float as = uF[i].x < 1e-3 ? 5.0 : 1.0;
  float dn = mix(bands(a0 - om * f1 * P, 3.0 * x, 0.53, as), bands(a0 - om * f0 * P, 3.0 * x, 0.0, as), w0);
  dn = smoothstep(0.3, 0.75, dn);
  if (as > 1.0) dn *= dn;
  float edge = smoothstep(rin * 0.8, rin * 1.25, rho) * (1.0 - smoothstep(mix(rin, rout, 0.3), rout, rho));
  float dens = edge * (0.35 + 1.8 * dn * dn);
  float cosI = abs(dot(vd, n));
  float a = 1.0 - exp(-2.2 * dens / max(cosI, 0.05));
  // thin disk: T ~ r^-3/4 (Shakura-Sunyaev, inner zero softened), hot lanes a little hotter
  float T = uE[i].z * pow(x, -0.75) * pow(max(1.0 - 0.9 * inversesqrt(max(x, 1.0)), 0.02), 0.25) * 1.6 * (0.85 + 0.3 * dn) * g;
  float I = uD[i].w * pow(x, -1.8) * g * g * g * (0.15 + 1.4 * dn);
  em += tr * a * blackbody(T) * uG[i].rgb * I;
  tr *= 1.0 - a;
}

void main() {
  vec2 asp = vec2(uAspect, 1.0), p = vUv * asp;
  float d = texture(tDepth, vUv).r;
  float zp = uNearFar.x * uNearFar.y / (uNearFar.y - d * (uNearFar.y - uNearFar.x));
  vec3 rd = normalize(uCamRot * vec3((vUv * 2.0 - 1.0) * uInvP, -1.0));
  vec3 fwd = uCamRot * vec3(0.0, 0.0, -1.0);
  float cosV = dot(rd, fwd);

  vec2 q = p;
  float shadow = 1.0, ring = 0.0, tr = 1.0;
  vec3 em = vec3(0.0);
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uCount) break;
    vec2 t = p - uA[i].xy;
    float r2 = max(dot(t, t), 1e-10), r = sqrt(r2);
    float w = clamp((zp - uB[i].x) * uB[i].w, 0.0, 1.0);
    w *= w * (3.0 - 2.0 * w);
    q -= t * (uA[i].z * w / r2);
    float rs = uC[i].w;
    if (uH[i].x != 0.0) {
      // frame dragging: the background swirls round a spinning hole, ~1 / r^2
      float ang = uH[i].x * w * uA[i].z / (r2 + 0.3 * uA[i].z), cs = cos(ang), sn = sin(ang);
      vec2 tq = q - uA[i].xy;
      q = uA[i].xy + mat2(cs, sn, -sn, cs) * tq;
    }
    if (rs <= 0.0) {
      if (zp < uB[i].x - uB[i].y * 1.05) continue;  // something in front hides this hole
      shadow *= smoothstep(uA[i].w - uPx, uA[i].w + uPx, r);
      // Einstein ring brightening where the magnification 1 / (1 - (thetaE / theta)^4) peaks
      float te = sqrt(uA[i].z * w), x = (r - te) / (0.1 * te + 2.0 * uPx);
      ring += uB[i].z * exp(-x * x);
      continue;
    }
    // --- disk: trace the camera ray through the hole's region (units of r_s)
    float rout = uE[i].y, RB = rout * 1.08 + 3.0;
    if (zp < uB[i].x - RB * rs) continue;          // all of it is behind something in front
    vec3 o = (uCamPos - uC[i].xyz) / rs;
    float bo = dot(o, rd), disc = bo * bo - dot(o, o) + RB * RB;
    vec3 Lm = cross(o, rd);
    float h2 = dot(Lm, Lm), b = sqrt(h2), k = uF[i].x;
    float bc = critB(k), aa = uF[i].w;
    vec3 n = uD[i].xyz;
    vec3 e1 = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))), e2 = cross(n, e1);
    if (disc > 0.0 && -bo + sqrt(disc) > 0.0) {
      float t0 = max(-bo - sqrt(disc), 0.0);
      vec3 x = o + rd * t0, v = rd;
      float zs = zp / cosV / rs;                    // scene hit distance along the ray (r_s)
      bool front = zp < uB[i].x - 2.0 * rs;         // something between the camera and the hole
      if (k < 1e-3) {
        // no bending (after the collapse): one straight crossing
        float den = dot(rd, n);
        float tc = abs(den) > 1e-5 ? -dot(o, n) / den : -1.0;
        if (tc > 0.0 && tc < zs + 0.3 / rs) diskHit(i, o + rd * tc, rd, n, e1, e2, em, tr);
      } else {
        float kb = 1.5 * k * h2, y0 = dot(x, n), travelled = 0.0;
        float rr = dot(x, x);
        vec3 acc = -kb * x / (rr * rr * sqrt(rr));
        for (int s = 0; s < ${STEPS}; s++) {
          float rx = sqrt(rr), dt = clamp(0.11 * rx, 0.03, 2.5);
          // kick-drift-kick leapfrog
          v += acc * (0.5 * dt);
          vec3 xn = x + v * dt;
          rr = dot(xn, xn);
          acc = -kb * xn / (rr * rr * sqrt(rr));
          v += acc * (0.5 * dt);
          float y1 = dot(xn, n);
          if (y0 * y1 < 0.0) {
            vec3 xc = mix(x, xn, y0 / (y0 - y1));
            // nearly straight rays meet the scene at its depth; bent ones are images of the far side,
            // hidden only by what stands in front of the hole
            bool straight = dot(normalize(v), rd) > 0.985;
            if (straight ? t0 + travelled + length(xc - x) < zs + 0.3 / rs : !front) diskHit(i, xc, v, n, e1, e2, em, tr);
          }
          travelled += dt * length(v);
          y0 = y1; x = xn;
          if (rr < 1.0 || tr < 0.01 || (rr > RB * RB && dot(x, v) > 0.0)) break;
        }
      }
    }
    // shadow edge at the critical impact parameter, and the photon ring hugging it
    float sh = uF[i].y;
    if (sh > 0.0 && zp > uB[i].x - 1.5 * bc * rs - 0.35) {
      shadow *= 1.0 - sh * (1.0 - smoothstep(bc - aa, bc + aa, b));
      float rw = max(aa * 0.9, 0.006 * bc), xr = (b - bc - 1.6 * rw) / rw;
      vec3 c = o - rd * bo, ce = c - n * dot(c, n);
      float beta = 0.5 * min(uE[i].w, 1.9);
      float dop = sqrt(1.0 - beta * beta) / (1.0 - beta * dot(cross(n, normalize(ce + 1e-5)), -rd));
      em += tr * sh * exp(-xr * xr) * blackbody(uE[i].z * 1.3 * dop) * uG[i].rgb * (uD[i].w * 0.7 * dop * dop * dop);
    }
  }
  for (int i = 0; i < ${MAX}; i++) {  // keep lookups out of the hole's own image
    if (i >= uCount) break;
    if (uC[i].w > 0.0) continue;                   // a traced hole draws no opaque horizon into the source
    if (zp < uB[i].x - uB[i].y * 1.05) continue;  // in front of the hole: leave it be
    vec2 t = q - uA[i].xy;
    float r = length(t), rmin = uA[i].w * 1.08 + 2.0 * uPx;
    if (r < rmin) q = uA[i].xy + (r > 1e-6 ? t / r : vec2(0.0, 1.0)) * rmin;
  }

  vec2 uv = q / asp, e = min(uv, 1.0 - uv);
  float fade = smoothstep(0.0, 0.06, min(e.x, e.y));
  uv = mix(vUv, uv, fade);
  vec3 col = texture(tSrc, uv).rgb * ((1.0 + ring * fade) * shadow * tr) + em;

  // photographic-negative spherical shell: path length through it, brightest at its limb
  if (uShell2.y > 0.0) {
    vec3 c = uShell.xyz - uCamPos;
    float tc = dot(c, rd), d2 = dot(c, c) - tc * tc, R = uShell.w, Ri = max(R - uShell2.x, 0.0);
    float chord = sqrt(max(R * R - d2, 0.0)) - sqrt(max(Ri * Ri - d2, 0.0));
    float m = chord / max(sqrt(R * R - Ri * Ri), 1e-4);
    m *= smoothstep(-0.2, 0.2, zp / cosV - (tc - sqrt(max(R * R - d2, 0.0))));
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    vec3 neg = vec3(0.55, 0.42, 1.0) * (2.2 / (1.0 + 3.0 * l)) + vec3(0.9, 0.95, 1.0) * 0.6 * exp(-24.0 * (1.0 - m) * (1.0 - m));
    col = mix(col, neg, clamp(m * uShell2.y, 0.0, 1.0));
  }
  fragColor = vec4(col, 1.0);
}`;

const _v = new THREE.Vector3();

export class Lens {
  active = false;  // false: render() returns the source untouched, no draw
  warming = false; // main's warm-up: draw even with no lens, so the program exists before the first void

  constructor(renderer) {
    this.renderer = renderer;
    this.lenses = Array.from({ length: MAX }, () => ({
      pos: new THREE.Vector3(), einstein: 1, horizon: 0.4, strength: 0,
      // accretion disk, traced (see the header). Cleared by set(): write it after set() every frame.
      disk: {
        on: false, axis: new THREE.Vector3(0, 1, 0), rs: 0.12, inner: 3, outer: 14, temperature: 4800, beaming: 0.6,
        intensity: 6, tint: new THREE.Color(1, 1, 1), phase: 0, spin: 2.2, bend: 1, shadow: 1, twist: 0,
      },
    }));
    // one photographic-negative shell (amount 0 = off); render() still needs active
    this.shell = { pos: new THREE.Vector3(), radius: 1, thickness: 0.3, amount: 0 };
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    const v4 = () => Array.from({ length: MAX }, () => new THREE.Vector4());
    this.quad = new FullscreenQuad(rawPass(FRAG, {
      tSrc: { value: null }, tDepth: { value: null }, uNoise3D: U.uNoise3D, uBlackbody: U.uBlackbody,
      uA: { value: v4() }, uB: { value: v4() }, uC: { value: v4() }, uD: { value: v4() }, uE: { value: v4() }, uF: { value: v4() }, uG: { value: v4() }, uH: { value: v4() },
      uShell: { value: new THREE.Vector4() }, uShell2: { value: new THREE.Vector4() },
      uCount: { value: 0 }, uNearFar: { value: new THREE.Vector2() }, uAspect: { value: 1 }, uPx: { value: 1 },
      uCamPos: { value: new THREE.Vector3() }, uCamRot: { value: new THREE.Matrix3() }, uInvP: { value: new THREE.Vector2() },
    }));
    const s = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.setSize(s.x, s.y);
  }

  // i: 0 or 1. Radii in metres: einsteinRadius is the ring for a source at infinity, horizonRadius the
  // black shadow. strength scales the deflection (the lens "mass") and the ring; 0 switches the lens off.
  set(i, worldPos, einsteinRadius, horizonRadius, strength = 1) {
    const l = this.lenses[i];
    l.pos.copy(worldPos);
    l.einstein = einsteinRadius;
    l.horizon = horizonRadius;
    l.strength = strength;
    l.disk.on = false;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
    this.target.setSize(w, h);
    const u = this.quad.material.uniforms;
    u.uAspect.value = w / h;
    u.uPx.value = 1 / h;
  }

  // srcTex: composited HDR; depthTex: resolved scene depth; camera: the one that rendered them
  render(srcTex, depthTex, camera) {
    if (!this.active) return srcTex;
    const u = this.quad.material.uniforms, aspect = u.uAspect.value;
    const k = camera.projectionMatrix.elements[5] * 0.5; // metres at view depth 1 -> screen-height units
    let n = 0;
    for (const l of this.lenses) {
      if (!(l.strength > 0)) continue;
      _v.copy(l.pos).applyMatrix4(camera.matrixWorldInverse);
      const z = -_v.z;
      const D = l.disk, dk = D.on && D.rs > 0;
      if (z <= camera.near && !dk) continue;
      _v.applyMatrix4(camera.projectionMatrix);
      const zz = Math.max(z, camera.near), te = l.einstein * k / zz;
      u.uA.value[n].set((_v.x * 0.5 + 0.5) * aspect, _v.y * 0.5 + 0.5, z > camera.near ? te * te * l.strength : 0, l.horizon * k / zz);
      u.uB.value[n].set(z, l.horizon, dk ? 0 : 1.5 * Math.min(l.strength, 2), 1 / Math.max(2 * l.einstein, 0.1));
      u.uC.value[n].set(l.pos.x, l.pos.y, l.pos.z, dk ? D.rs : 0);
      u.uH.value[n].set(dk ? D.twist : 0, 0, 0, 0);
      if (dk) {
        u.uD.value[n].set(D.axis.x, D.axis.y, D.axis.z, D.intensity);
        u.uE.value[n].set(D.inner, D.outer, D.temperature, D.beaming);
        u.uF.value[n].set(D.bend, D.shadow, D.phase, u.uPx.value * zz / (k * D.rs));
        u.uG.value[n].set(D.tint.r, D.tint.g, D.tint.b, D.spin);
      }
      n++;
    }
    const sh = this.shell;
    u.uShell.value.set(sh.pos.x, sh.pos.y, sh.pos.z, sh.radius);
    u.uShell2.value.set(sh.thickness, Math.max(sh.amount, 0), 0, 0);
    if (!n && !this.warming && !(sh.amount > 0)) return srcTex;
    u.uCount.value = n;
    u.tSrc.value = srcTex;
    u.tDepth.value = depthTex;
    u.uNearFar.value.set(camera.near, camera.far);
    const e = camera.matrixWorld.elements, pe = camera.projectionMatrix.elements;
    u.uCamPos.value.set(e[12], e[13], e[14]);
    u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    u.uInvP.value.set(1 / pe[0], 1 / pe[5]);

    const r = this.renderer, prev = r.getRenderTarget(), clear = r.autoClear;
    r.autoClear = false;
    this.quad.render(r, this.target);
    r.setRenderTarget(prev);
    r.autoClear = clear;
    return this.target.texture;
  }

  dispose() {
    this.target.dispose();
    this.quad.material.dispose();
  }
}
