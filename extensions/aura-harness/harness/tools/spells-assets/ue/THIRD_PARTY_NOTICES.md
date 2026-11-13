# Third-party notices

Ultra Elements is MIT-licensed (see `LICENSE`). It adapts code from the projects below, all under the MIT License. Their copyright lines are listed here, and the full MIT text is at the end of this file. The papers and talks credited in source comments, such as Hillaire, Bruneton, Karis, Lagarde, Wyman–Sloan–Shirley, Bridson, Schneider, Jimenez, Eiserloh and James–von Tunzelmann–Franklin–Thorne, are references for techniques that were implemented from scratch. They are not copied code.

## three.js
https://github.com/mrdoob/three.js. Copyright © 2010–2026 three.js authors.

A runtime dependency. Also adapted:
- `src/engine/PostFX.js` reproduces the math of three's `AgXToneMapping` shader chunk so it can bake it into a LUT, and its `NeutralToneMapping` chunk (Khronos PBR Neutral)
- the cloud layer of three's `Sky.js` (`src/scene/sky.js`)
- the mirrored-camera and oblique-clip-plane math of three's `Reflector` (`src/engine/PlanarReflection.js`, `src/spells/void/portal.js`)

## lil-gui
https://github.com/georgealways/lil-gui. Copyright (c) 2019 George Michael Brower.

A runtime dependency (the settings panel), bundled into the built site.

## Ultra Water
https://github.com/Humpalumps/Ultra-Water. Copyright (c) 2026 Humpalumps.

Adapted:
- the sky and atmosphere (`src/scene/sky.js`, `src/scene/atmosphere.js`)
- scene-colour refraction with depth validation (`src/vfx/Refraction.js`, `src/scene/pool.js`, `src/vfx/Spikes.js`)
- the water presets and optics in `src/vfx/Metaballs.js` and `src/spells/water.js`
- the water surface shading and the baked foam texture used by the particle fluid (`src/vfx/ParticleFluid.js`, `src/vfx/ParticleFluid.glsl.js`)
- the ocean surface model, deep-water colour, shore foam and spray puffs on Tsunami's wave (`src/spells/water/tsunami.js`, `src/spells/water/tsunami.glsl.js`)
- the async probe readback (`src/vfx/GroundField.js`)
- the fence-synced benchmark and the uncapped frame loop (`src/main.js`)

## WebGL Water (Evan Wallace)
https://madebyevan.com/webgl-water. Copyright (c) 2011 Evan Wallace.

The pool's ripple height field: the height-plus-velocity update, the four-neighbour Laplacian and the cosine drops, in `src/scene/pool.js`.

## Hash without Sine (Dave Hoskins)
https://www.shadertoy.com/view/4djSRW. Copyright (c) 2014 David Hoskins.

The `hash11`, `hash12`, `hash21`, `hash31` and `hash33` functions in `src/vfx/common.js` and `src/engine/PostFX.js`.

## Inigo Quilez
https://iquilezles.org. Copyright (c) Inigo Quilez.

- The ray–capsule intersection in `src/vfx/Volumes.js`.
- The polynomial smooth minimum in `src/vfx/Metaballs.js`.
- The Voronoi edge distance in `src/vfx/GroundField.js`.

---

## MIT License (applies to each project above)

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
