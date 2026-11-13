// Copy this file to add an element (CONTRIBUTING.md). A spell is a plain module:
//   params / ranges: the GUI folder (numbers first; colours as '#rrggbb')
//   kinds:           particle behaviours registered at load, named '<id>.<kind>'
//   timing:          phase durations; shape picks how travel works
//   create(fx):      runs once at load, allocates everything; returns { phase, update }
// Per-cast state lives in c.data. Never allocate in update.
export default {
  id: 'template', name: 'Template', key: '', hue: '#9fd8ff',
  shape: 'projectile', forms: ['Orb'], speed: 14, radius: 0.25,
  params: { speed: 14, sparks: 1, color: '#9fd8ff' },
  ranges: { speed: [4, 40, 0.1], sparks: [0, 3, 0.01] },
  timing: { charge: 0.4, impact: 0.15, linger: 1.5 },
  kinds: {
    spark: { style: 'glow', drag: 0.8, gravity: 6, restitution: 0.4, friction: 0.3, life: [0.4, 1.2], size: [0.035, 0.01], stretch: 0.03, emissive: 30, color: ['#bfe6ff', '#2a7fff'], alpha: [1, 0] },
    puff: { style: 'media', drag: 2, buoyancy: 0.6, curl: 0.6, life: [0.8, 1.6], size: [0.4, 1.4], emissive: 0, color: ['#8899aa', '#556677'], alpha: [0.5, 0], density: 2 },
  },
  create(fx) {
    const S = this, P = fx.particles;   // called as spell.create(fx): S.params is the live GUI state
    const spark = P.emitter('template.spark', { shape: 'sphere', radius: 0.05, spread: 6 });
    const trail = P.emitter('template.spark', { shape: 'sphere', radius: 0.08, spread: 0.6 });
    const puff = P.emitter('template.puff', { shape: 'sphere', radius: 0.4, spread: 1.2 });
    return {
      phase(c, name) {
        const p = S.params;
        if (name === 'charge') {
          c.data.light = fx.lights.acquire();
          if (c.data.light) Object.assign(c.data.light, { range: 8, intensity: 0 });
          c.data.light?.color.set(p.color);
        } else if (name === 'impact') {
          spark.pos.copy(c.pos); spark.burst(400 * p.sparks);
          puff.pos.copy(c.pos); puff.burst(40);
          fx.ground.splat({ x: c.pos.x, z: c.pos.z, radius: 1.5, heat: 0.6, char: 0.4 });
          fx.rig.shake(0.35, 18);
          if (c.data.light) c.data.light.intensity = 60;
        } else if (name === 'done') {
          c.data.light?.release();
          c.data.light = null;
        }
      },
      update(c, dt) {
        const L = c.data.light;
        if (L) {
          L.pos.copy(c.pos);
          if (c.phase === 'charge') L.intensity = 8 * c.t / c.durations.charge;
          else if (c.phase === 'travel') L.intensity = 10;
          else L.intensity *= Math.exp(-dt * 6);
        }
        if (c.phase === 'travel') { trail.pos.copy(c.pos); trail.rate(300, dt); }
      },
    };
  },
};
