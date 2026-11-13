// Shared optics for every refract-pass material (metaballs, ice, pool surface). These draw into
// the MSAA HDR target right after the opaque scene and sample its resolve (UW's water pass):
// uSceneColor = opaque linear HDR, uSceneDepth = its [0,1] depth.
//
// Needs COMMON_GLSL first (uResolution, uNearFar, linearDepth) and three's ShaderMaterial prefix
// (viewMatrix). Declares projectionMatrix (three's fragment prefix only has viewMatrix and
// cameraPosition; three still fills it), uSceneColor, uSceneDepth and uSkyCube: don't redeclare
// them; pass { ...U, own } so the values are shared.
//
// Units: metres, linear radiance, absorption in 1/m, cosines of unit vectors.
export const REFRACT_GLSL = /* glsl */`
uniform mat4 projectionMatrix;
uniform sampler2D uSceneColor;
uniform highp sampler2D uSceneDepth;
uniform samplerCube uSkyCube;

// Schlick. cosTheta = dot(n, v); f0 = 0.02 for water and ice (IOR ~1.33)
float fresnel(float cosTheta, float f0) {
  float m = 1.0 - clamp(cosTheta, 0.0, 1.0), m2 = m * m;
  return f0 + (1.0 - f0) * m2 * m2 * m;
}
// rough surfaces stop short of a white rim at grazing: F90 drops with roughness (Lagarde 2014,
// as UW's ocean: F90 = 1 - 0.7 sqrt(alpha), alpha = roughness^2)
float fresnelRough(float cosTheta, float f0, float roughness) {
  float f90 = max(1.0 - 0.7 * roughness, f0);
  float m = 1.0 - clamp(cosTheta, 0.0, 1.0), m2 = m * m;
  return f0 + (f90 - f0) * m2 * m2 * m;
}

// transmittance after dist metres of a medium with absorption (1/m) per channel
vec3 beerLambert(vec3 absorption, float dist) { return exp(-absorption * dist); }

// sky cube radiance along r. The cube is plain mipmapped (not convolved): a mip texel spans
// ~2^lod / size of a face, so the GGX lobe width alpha maps to lod = log2(alpha * size * 0.64).
// The cube's lower hemisphere already holds the lit ground (sky.js).
vec3 envReflect(vec3 r, float roughness) {
  float size = float(textureSize(uSkyCube, 0).x);
  return textureLod(uSkyCube, r, log2(max(roughness * roughness * size * 0.64, 1.0))).rgb;
}

float refrViewZ(vec3 p) { return -(viewMatrix * vec4(p, 1.0)).z; }
vec2 refrUV(vec3 p) { vec4 c = projectionMatrix * viewMatrix * vec4(p, 1.0); return c.xy / c.w * 0.5 + 0.5; }

// Scene seen through a surface at worldPos (normal n, v = to camera): the screen lookup moves to
// where the refracted ray is after 'thickness' metres (pass the medium thickness, scaled up for a
// stronger lens). If that lookup lands on something in front of the surface (an object edge), it
// falls back smoothly to the straight-through lookup, as UW's water does, so edges get no
// outline. behind = metres (view z) from the surface to the opaque scene behind the lookup.
vec3 sceneRefract(vec3 worldPos, vec3 n, vec3 v, float ior, float thickness, out float behind) {
  vec2 px = 1.0 / uResolution;
  vec2 uv0 = gl_FragCoord.xy * px;
  vec3 rd = refract(-v, n, 1.0 / ior);
  vec2 uv = clamp(refrUV(worldPos + rd * thickness), px, 1.0 - px);
  float zs = refrViewZ(worldPos);
  float z0 = linearDepth(textureLod(uSceneDepth, uv0, 0.0).r);
  float z1 = linearDepth(textureLod(uSceneDepth, uv, 0.0).r);
  float keep = smoothstep(zs - 0.3, zs + 0.3, z1);
  behind = max(mix(z0, z1, keep) - zs, 0.0);
  return textureLod(uSceneColor, mix(uv0, uv, keep), 0.0).rgb;
}
`;
