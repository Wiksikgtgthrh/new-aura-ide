// Scripted combo demos (PLAN 3 "Combos"). The interactions themselves are emergent (ground
// field, shared forces, occluders); these just fire the right spells in the right order.
// step: { spell, form, target (dummy index) | to [x, y, z], delay (s after the previous step), hold (s, beams) }
const POOL = [9.75, 0, 0];

export const COMBOS = [
  { name: 'Steam (frost, then fire)', steps: [
    { spell: 'ice', form: 'Glacial Spike', target: 0 },
    { spell: 'fire', form: 'Fireball', target: 0, delay: 1.8 },
  ] },
  { name: 'Conduction (soak the pool, then lightning)', steps: [
    { spell: 'water', form: 'Tidal Lance', to: POOL, hold: 1.2 },
    { spell: 'lightning', form: 'Thunderstrike', to: POOL, delay: 1.6 },
  ] },
  { name: 'Firestorm (cyclone, then fireball)', steps: [
    { spell: 'wind', form: 'Cyclone', target: 0 },
    { spell: 'fire', form: 'Fireball', target: 0, delay: 1.0 },
    { spell: 'fire', form: 'Inferno', target: 0, delay: 0.6 },
  ] },
  { name: 'Magma (upheaval, then fire)', steps: [
    { spell: 'earth', form: 'Upheaval', target: 1 },
    { spell: 'fire', form: 'Inferno', target: 1, delay: 1.2 },
  ] },
  { name: 'Flash freeze (soak, then ice)', steps: [
    { spell: 'water', form: 'Tidal Lance', target: 0, hold: 1.2 },
    { spell: 'ice', form: 'Glacial Spike', target: 0, delay: 1.6 },
  ] },
  { name: 'Event horizon (storm, embers, singularity)', steps: [
    { spell: 'wind', form: 'Cyclone', target: 0 },
    { spell: 'fire', form: 'Inferno', target: 0, delay: 0.5 },
    { spell: 'void', form: 'Singularity', target: 0, delay: 1.2 },
  ] },
  { name: 'Aegis test (every element vs the shield)', steps: [
    { spell: 'arcane', form: 'Aegis', target: 0 },
    ...['lightning', 'fire', 'water', 'ice', 'earth', 'wind', 'void', 'light', 'acid', 'arcane'].map((spell, i) => ({
      spell, target: 0, delay: i === 0 ? 1.2 : 0.9, ...(spell === 'arcane' ? { form: 'Arcane Barrage' } : {}),
    })),
  ] },
];
