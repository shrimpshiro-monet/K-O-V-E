import type { MotionShaderDef } from "./types";

const DITHER_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_levels;
uniform float u_scale;
out vec4 fragColor;

const float bayer[16] = float[16](
  0.0, 8.0, 2.0, 10.0,
  12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0,
  15.0, 7.0, 13.0, 5.0
);

float bayerValue(vec2 pixel) {
  int x = int(mod(pixel.x, 4.0));
  int y = int(mod(pixel.y, 4.0));
  return bayer[y * 4 + x] / 16.0;
}

void main() {
  vec4 src = texture(u_input, vUv);
  float scale = max(u_scale, 1.0);
  float levels = max(u_levels, 2.0);
  vec2 pixel = floor((vUv * u_resolution) / scale);
  float threshold = bayerValue(pixel) - 0.5;
  vec3 scaled = src.rgb * (levels - 1.0);
  vec3 quantized = floor(scaled + 0.5 + threshold) / (levels - 1.0);
  fragColor = vec4(clamp(quantized, 0.0, 1.0), src.a);
}
`;

const GRADIENT_MAP_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_mix;
out vec4 fragColor;

const vec3 stopDark = vec3(0.05, 0.02, 0.18);
const vec3 stopLight = vec3(1.0, 0.86, 0.45);

void main() {
  vec4 src = texture(u_input, vUv);
  float luma = dot(src.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 mapped = mix(stopDark, stopLight, luma);
  vec3 result = mix(src.rgb, mapped, clamp(u_mix, 0.0, 1.0));
  fragColor = vec4(result, src.a);
}
`;

const PIXELATE_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_size;
out vec4 fragColor;

void main() {
  float size = max(u_size, 1.0);
  vec2 blocks = max(u_resolution / size, vec2(1.0));
  vec2 quantized = (floor(vUv * blocks) + 0.5) / blocks;
  fragColor = texture(u_input, quantized);
}
`;

const HALFTONE_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_dotSize;
uniform float u_angle;
out vec4 fragColor;

void main() {
  vec4 src = texture(u_input, vUv);
  float luma = dot(src.rgb, vec3(0.2126, 0.7152, 0.0722));
  float dotSize = max(u_dotSize, 2.0);
  float rad = radians(u_angle);
  vec2 pixel = vUv * u_resolution;
  mat2 rot = mat2(cos(rad), -sin(rad), sin(rad), cos(rad));
  vec2 rotated = rot * pixel;
  vec2 cell = mod(rotated, dotSize) - dotSize * 0.5;
  float dist = length(cell) / (dotSize * 0.5);
  float radius = sqrt(1.0 - clamp(luma, 0.0, 1.0));
  float ink = step(dist, radius);
  vec3 result = mix(vec3(1.0), vec3(0.0), ink);
  fragColor = vec4(result, src.a);
}
`;

const VHS_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_intensity;
uniform float u_scanlines;
uniform float u_jitter;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  float intensity = clamp(u_intensity, 0.0, 1.0);
  float frame = floor(u_time * 24.0);
  float lineNoise = hash(vec2(frame, floor(vUv.y * 90.0)));
  float horizontalJitter = (lineNoise - 0.5) * u_jitter * 0.035;
  horizontalJitter *= step(0.82, lineNoise);
  vec2 uv = vec2(clamp(vUv.x + horizontalJitter, 0.0, 1.0), vUv.y);
  float split = (1.0 + u_jitter * 4.0) / max(u_resolution.x, 1.0);
  vec4 src = texture(u_input, uv);
  vec3 vhs = vec3(
    texture(u_input, vec2(clamp(uv.x + split, 0.0, 1.0), uv.y)).r,
    src.g,
    texture(u_input, vec2(clamp(uv.x - split, 0.0, 1.0), uv.y)).b
  );
  float scan = sin(vUv.y * u_resolution.y * 3.14159265);
  vhs *= 1.0 - (0.5 + 0.5 * scan) * clamp(u_scanlines, 0.0, 1.0) * 0.32;
  float grain = (hash(vUv * u_resolution + frame) - 0.5) * 0.11;
  vhs += grain * intensity;
  fragColor = vec4(clamp(mix(src.rgb, vhs, intensity), 0.0, 1.0), src.a);
}
`;

const POSTERIZE_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_levels;
uniform float u_mix;
out vec4 fragColor;

void main() {
  vec4 src = texture(u_input, vUv);
  float levels = max(2.0, floor(u_levels));
  vec3 posterized = floor(src.rgb * (levels - 1.0) + 0.5) / (levels - 1.0);
  fragColor = vec4(mix(src.rgb, posterized, clamp(u_mix, 0.0, 1.0)), src.a);
}
`;

const DUOTONE_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec4 u_shadowColor;
uniform vec4 u_highlightColor;
uniform float u_mix;
uniform float u_contrast;
out vec4 fragColor;

void main() {
  vec4 src = texture(u_input, vUv);
  float luma = dot(src.rgb, vec3(0.2126, 0.7152, 0.0722));
  luma = clamp((luma - 0.5) * max(u_contrast, 0.1) + 0.5, 0.0, 1.0);
  vec3 mapped = mix(u_shadowColor.rgb, u_highlightColor.rgb, luma);
  fragColor = vec4(mix(src.rgb, mapped, clamp(u_mix, 0.0, 1.0)), src.a);
}
`;

const PRISM_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_amount;
uniform float u_angle;
uniform float u_mix;
out vec4 fragColor;

void main() {
  vec2 texel = 1.0 / max(u_resolution, vec2(1.0));
  float rad = radians(u_angle);
  vec2 direction = vec2(cos(rad), sin(rad));
  vec2 offset = direction * texel * u_amount;
  vec4 src = texture(u_input, vUv);
  vec3 prism = vec3(
    texture(u_input, clamp(vUv + offset, vec2(0.0), vec2(1.0))).r,
    src.g,
    texture(u_input, clamp(vUv - offset, vec2(0.0), vec2(1.0))).b
  );
  fragColor = vec4(mix(src.rgb, prism, clamp(u_mix, 0.0, 1.0)), src.a);
}
`;

const FISHEYE_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_strength;
uniform float u_radius;
out vec4 fragColor;

void main() {
  vec2 aspect = vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);
  vec2 centered = (vUv - 0.5) * aspect;
  float distanceFromCenter = length(centered);
  float radius = max(u_radius, 0.1);
  float falloff = 1.0 - smoothstep(radius * 0.75, radius, distanceFromCenter);
  float distortion = 1.0 + u_strength * dot(centered, centered) * falloff;
  vec2 distorted = centered * distortion;
  vec2 uv = clamp(distorted / aspect + 0.5, vec2(0.0), vec2(1.0));
  vec4 src = texture(u_input, vUv);
  vec4 warped = texture(u_input, uv);
  fragColor = vec4(warped.rgb, src.a);
}
`;

const WAVE_WARP_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_amplitude;
uniform float u_frequency;
uniform float u_speed;
out vec4 fragColor;

void main() {
  float phase = vUv.y * u_frequency * 6.2831853 + u_time * u_speed;
  vec2 uv = vec2(clamp(vUv.x + sin(phase) * u_amplitude, 0.0, 1.0), vUv.y);
  vec4 warped = texture(u_input, uv);
  vec4 src = texture(u_input, vUv);
  fragColor = vec4(warped.rgb, src.a);
}
`;

const SCANLINES_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_density;
uniform float u_intensity;
uniform float u_speed;
out vec4 fragColor;

void main() {
  vec4 src = texture(u_input, vUv);
  float position = vUv.y * u_density + u_time * u_speed * 20.0;
  float line = 0.5 + 0.5 * sin(position * 3.14159265);
  float shade = 1.0 - line * clamp(u_intensity, 0.0, 1.0);
  fragColor = vec4(src.rgb * shade, src.a);
}
`;

const EDGE_GLOW_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_strength;
uniform float u_radius;
uniform vec4 u_color;
out vec4 fragColor;

float lumaAt(vec2 uv) {
  return dot(texture(u_input, clamp(uv, vec2(0.0), vec2(1.0))).rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec4 src = texture(u_input, vUv);
  vec2 texel = max(u_radius, 0.5) / max(u_resolution, vec2(1.0));
  float gx = lumaAt(vUv + vec2(texel.x, 0.0)) - lumaAt(vUv - vec2(texel.x, 0.0));
  float gy = lumaAt(vUv + vec2(0.0, texel.y)) - lumaAt(vUv - vec2(0.0, texel.y));
  float edge = clamp(length(vec2(gx, gy)) * u_strength, 0.0, 1.0);
  vec3 result = src.rgb + u_color.rgb * edge * u_color.a;
  fragColor = vec4(clamp(result, 0.0, 1.0), src.a);
}
`;

const SPEED_LINES_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_amount;
uniform float u_density;
uniform float u_speed;
out vec4 fragColor;

float speedLineHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec4 src = texture(u_input, vUv);
  float amount = clamp(u_amount, 0.0, 1.0);
  vec2 centered = vUv - vec2(0.5);
  centered.x *= u_resolution.x / max(u_resolution.y, 1.0);
  float radius = length(centered);
  float angle = atan(centered.y, centered.x);
  float lanes = max(u_density, 2.0);
  float lane = floor((angle / 6.28318530718 + 0.5) * lanes);
  float tick = floor(u_time * max(u_speed, 0.01) * 5.0);
  float laneNoise = speedLineHash(vec2(lane, tick));
  float streak = step(1.0 - amount * 0.55, laneNoise);
  float taper = smoothstep(0.12, 0.45, radius) * (1.0 - smoothstep(0.72, 1.05, radius));
  float line = streak * taper * amount;
  vec3 result = clamp(src.rgb + vec3(line), 0.0, 1.0);
  fragColor = vec4(result, src.a);
}
`;

const GLITCH_BLOCKS_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_amount;
uniform float u_blockSize;
uniform float u_rgbSplit;
uniform float u_speed;
out vec4 fragColor;

float blockHash(float n) {
  return fract(sin(n * 12.9898) * 43758.5453123);
}

void main() {
  float amount = clamp(u_amount, 0.0, 1.0);
  float slice = max(u_blockSize, 1.0);
  float row = floor(vUv.y * u_resolution.y / slice);
  float tick = floor(u_time * max(u_speed, 0.01));
  float seed = blockHash(row + tick * 91.7);
  float active = step(1.0 - amount * 0.6, seed);
  float shift = (blockHash(row * 3.1 + tick * 17.3) - 0.5) * 0.3 * amount * active;
  vec2 uv = vec2(clamp(vUv.x + shift, 0.0, 1.0), vUv.y);
  float split = u_rgbSplit * amount * 14.0 / max(u_resolution.x, 1.0);
  float r = texture(u_input, vec2(clamp(uv.x + split, 0.0, 1.0), uv.y)).r;
  vec4 mid = texture(u_input, uv);
  float b = texture(u_input, vec2(clamp(uv.x - split, 0.0, 1.0), uv.y)).b;
  vec3 color = vec3(r, mid.g, b);
  float dropout = step(0.94, seed) * active * amount;
  color = mix(color, vec3(1.0) - color, dropout);
  fragColor = vec4(clamp(color, 0.0, 1.0), mid.a);
}
`;

const LIGHT_LEAK_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_intensity;
uniform float u_warmth;
uniform float u_speed;
out vec4 fragColor;

void main() {
  vec4 src = texture(u_input, vUv);
  float t = u_time * max(u_speed, 0.01);
  float intensity = clamp(u_intensity, 0.0, 1.0);
  float warmth = clamp(u_warmth, 0.0, 1.0);
  float sweep = fract(t * 0.25);
  float across = vUv.x * 0.7 + vUv.y * 0.3;
  float streak = exp(-pow((across - sweep) * 5.0, 2.0));
  float bloom = exp(-pow((vUv.x + vUv.y - 0.35) * 3.5, 2.0)) * (0.6 + 0.4 * sin(t * 1.7));
  float leak = clamp(streak * 0.8 + bloom * 0.55, 0.0, 1.0) * intensity;
  vec3 leakColor = mix(vec3(0.35, 0.62, 1.0), vec3(1.0, 0.62, 0.22), warmth);
  float gain = leak * 0.85;
  vec3 screened = 1.0 - (1.0 - clamp(src.rgb, 0.0, 1.0)) * (1.0 - leakColor * gain);
  fragColor = vec4(clamp(screened, 0.0, 1.0), src.a);
}
`;

const KALEIDOSCOPE_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_segments;
uniform float u_spin;
uniform float u_zoom;
out vec4 fragColor;

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 point = vUv - 0.5;
  point.x *= aspect;
  float segments = max(u_segments, 2.0);
  float span = 6.28318530718 / segments;
  // Spin the fold itself, so the mirror seams never sit still on a held shot.
  float angle = atan(point.y, point.x) + u_time * u_spin;
  float fold = mod(angle, span);
  float mirrored = abs(fold - span * 0.5);
  float radius = length(point);
  vec2 uv = vec2(cos(mirrored), sin(mirrored)) * radius / max(u_zoom, 0.05);
  uv.x /= max(aspect, 0.0001);
  fragColor = texture(u_input, clamp(uv + 0.5, 0.0, 1.0));
}
`;

const MIRROR_TILES_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_columns;
uniform float u_rows;
uniform float u_shift;
out vec4 fragColor;

void main() {
  vec2 grid = vec2(max(u_columns, 1.0), max(u_rows, 1.0));
  vec2 drift = vec2(u_time * u_shift * 0.08, 0.0);
  vec2 scaled = vUv * grid + drift;
  vec2 cell = floor(scaled);
  vec2 local = fract(scaled);
  // Alternate cells read the frame mirrored, so the grid stitches seamlessly
  // instead of showing a hard tile edge.
  vec2 flip = mod(cell, 2.0);
  vec2 mirrored = mix(local, 1.0 - local, flip);
  vec2 uv = (cell + mirrored) / grid;
  fragColor = texture(u_input, clamp(uv, 0.0, 1.0));
}
`;

const SWIRL_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_amount;
uniform float u_radius;
uniform float u_speed;
out vec4 fragColor;

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 point = vUv - 0.5;
  point.x *= aspect;
  float fromCenter = length(point) / max(u_radius, 0.01);
  float falloff = 1.0 - smoothstep(0.0, 1.0, clamp(fromCenter, 0.0, 1.0));
  float angle = (u_amount + u_time * u_speed) * falloff;
  float s = sin(angle);
  float c = cos(angle);
  vec2 rotated = vec2(c * point.x - s * point.y, s * point.x + c * point.y);
  rotated.x /= max(aspect, 0.0001);
  fragColor = texture(u_input, clamp(rotated + 0.5, 0.0, 1.0));
}
`;

const CRT_CURVE_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_curvature;
uniform float u_phosphor;
uniform float u_flicker;
out vec4 fragColor;

void main() {
  vec2 centered = vUv * 2.0 - 1.0;
  float bulge = 1.0 + u_curvature * dot(centered, centered) * 0.35;
  vec2 curved = centered * bulge;
  vec2 uv = curved * 0.5 + 0.5;
  // Outside the tube stays black — a smeared edge pixel would read as a bug.
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec4 src = texture(u_input, clamp(uv, 0.0, 1.0));
  vec3 tinted = src.rgb * mix(vec3(1.0), vec3(1.06, 0.98, 0.93), u_curvature);
  float raster = sin(uv.y * u_resolution.y * 3.14159265);
  float phosphor = 1.0 - u_phosphor * 0.35 * (1.0 - raster * raster);
  float flicker = 1.0 - u_flicker * 0.12 * (0.5 + 0.5 * sin(u_time * 9.0));
  float vignette = clamp(1.0 - 0.45 * u_curvature * dot(curved, curved), 0.0, 1.0);
  fragColor = vec4(tinted * phosphor * flicker * vignette * inside, src.a * inside);
}
`;

const ECHO_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_amount;
uniform float u_offset;
uniform float u_speed;
out vec4 fragColor;

void main() {
  // A trail dragged down-right: eight taps that fade as they walk away from
  // the frame, wobbling over time so the smear breathes instead of freezing.
  vec2 direction = normalize(vec2(0.86, 0.5));
  float reach = u_offset * clamp(u_amount, 0.0, 1.0);
  vec2 texel = vec2(reach) / max(u_resolution, vec2(1.0));
  vec4 base = texture(u_input, vUv);
  vec3 accumulated = base.rgb;
  float total = 1.0;
  for (int index = 1; index <= 8; index++) {
    float step01 = float(index) / 8.0;
    float wobble = 1.0 + 0.3 * sin(u_time * u_speed * 2.5 + step01 * 8.0);
    vec2 uv = vUv - direction * texel * step01 * wobble;
    float weight = 1.0 - step01 * 0.7;
    accumulated += texture(u_input, clamp(uv, 0.0, 1.0)).rgb * weight;
    total += weight;
  }
  fragColor = vec4(accumulated / total, base.a);
}
`;

export const EFFECT_SHADERS: readonly MotionShaderDef[] = [
  {
    id: "dither",
    name: "Dither",
    category: "effect",
    glsl: DITHER_GLSL,
    params: [
      { name: "levels", label: "Levels", type: "number", default: 4, min: 2, max: 16, step: 1 },
      { name: "scale", label: "Scale", type: "number", default: 1, min: 1, max: 8, step: 1 },
    ],
  },
  {
    id: "gradient-map",
    name: "Gradient Map",
    category: "effect",
    glsl: GRADIENT_MAP_GLSL,
    params: [
      { name: "mix", label: "Mix", type: "number", default: 1, min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: "pixelate",
    name: "Pixelate",
    category: "effect",
    glsl: PIXELATE_GLSL,
    params: [
      { name: "size", label: "Size", type: "number", default: 8, min: 1, max: 64, step: 1 },
    ],
  },
  {
    id: "halftone",
    name: "Halftone",
    category: "effect",
    glsl: HALFTONE_GLSL,
    params: [
      { name: "dotSize", label: "Dot Size", type: "number", default: 8, min: 2, max: 32, step: 1 },
      { name: "angle", label: "Angle", type: "number", default: 15, min: 0, max: 90, step: 1 },
    ],
  },
  {
    id: "vhs",
    name: "VHS",
    category: "effect",
    glsl: VHS_GLSL,
    params: [
      { name: "intensity", label: "Intensity", type: "number", default: 0.75, min: 0, max: 1, step: 0.01 },
      { name: "scanlines", label: "Scanlines", type: "number", default: 0.4, min: 0, max: 1, step: 0.01 },
      { name: "jitter", label: "Jitter", type: "number", default: 0.45, min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: "posterize",
    name: "Posterize",
    category: "effect",
    glsl: POSTERIZE_GLSL,
    params: [
      { name: "levels", label: "Levels", type: "number", default: 5, min: 2, max: 16, step: 1 },
      { name: "mix", label: "Mix", type: "number", default: 1, min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: "duotone",
    name: "Duotone",
    category: "effect",
    glsl: DUOTONE_GLSL,
    params: [
      { name: "shadowColor", label: "Shadow", type: "color", default: "#11133f", min: 0, max: 1, step: 0.01 },
      { name: "highlightColor", label: "Highlight", type: "color", default: "#ffca6b", min: 0, max: 1, step: 0.01 },
      { name: "mix", label: "Mix", type: "number", default: 0.9, min: 0, max: 1, step: 0.01 },
      { name: "contrast", label: "Contrast", type: "number", default: 1.15, min: 0.25, max: 2.5, step: 0.05 },
    ],
  },
  {
    id: "prism",
    name: "Prism Split",
    category: "effect",
    glsl: PRISM_GLSL,
    params: [
      { name: "amount", label: "Offset", type: "number", default: 8, min: 0, max: 40, step: 0.5 },
      { name: "angle", label: "Angle", type: "number", default: 0, min: 0, max: 360, step: 1 },
      { name: "mix", label: "Mix", type: "number", default: 1, min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: "fisheye",
    name: "Fisheye",
    category: "effect",
    glsl: FISHEYE_GLSL,
    params: [
      { name: "strength", label: "Strength", type: "number", default: 0.55, min: -1, max: 1.5, step: 0.05 },
      { name: "radius", label: "Radius", type: "number", default: 0.8, min: 0.2, max: 1.5, step: 0.05 },
    ],
  },
  {
    id: "wave-warp",
    name: "Wave Warp",
    category: "effect",
    glsl: WAVE_WARP_GLSL,
    params: [
      { name: "amplitude", label: "Amplitude", type: "number", default: 0.025, min: 0, max: 0.15, step: 0.005 },
      { name: "frequency", label: "Frequency", type: "number", default: 5, min: 1, max: 20, step: 0.5 },
      { name: "speed", label: "Speed", type: "number", default: 1.5, min: 0, max: 8, step: 0.1 },
    ],
  },
  {
    id: "scanlines",
    name: "Scanlines",
    category: "effect",
    glsl: SCANLINES_GLSL,
    params: [
      { name: "density", label: "Density", type: "number", default: 360, min: 40, max: 1200, step: 10 },
      { name: "intensity", label: "Intensity", type: "number", default: 0.3, min: 0, max: 1, step: 0.01 },
      { name: "speed", label: "Speed", type: "number", default: 0.2, min: 0, max: 4, step: 0.05 },
    ],
  },
  {
    id: "edge-glow",
    name: "Edge Glow",
    category: "effect",
    glsl: EDGE_GLOW_GLSL,
    params: [
      { name: "strength", label: "Strength", type: "number", default: 4, min: 0, max: 12, step: 0.25 },
      { name: "radius", label: "Radius", type: "number", default: 1.5, min: 0.5, max: 6, step: 0.25 },
      { name: "color", label: "Glow Color", type: "color", default: "#4de8ff", min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: "speed-lines",
    name: "Speed Lines",
    category: "effect",
    glsl: SPEED_LINES_GLSL,
    params: [
      { name: "amount", label: "Amount", type: "number", default: 0.6, min: 0, max: 1, step: 0.01 },
      { name: "density", label: "Density", type: "number", default: 48, min: 8, max: 120, step: 1 },
      { name: "speed", label: "Speed", type: "number", default: 2, min: 0, max: 4, step: 0.05 },
    ],
  },
  {
    id: "glitch-blocks",
    name: "Glitch Blocks",
    category: "effect",
    glsl: GLITCH_BLOCKS_GLSL,
    params: [
      { name: "amount", label: "Amount", type: "number", default: 0.5, min: 0, max: 1, step: 0.01 },
      { name: "blockSize", label: "Block Size", type: "number", default: 24, min: 4, max: 64, step: 1 },
      { name: "rgbSplit", label: "RGB Split", type: "number", default: 0.5, min: 0, max: 1, step: 0.01 },
      { name: "speed", label: "Speed", type: "number", default: 3, min: 0, max: 8, step: 0.1 },
    ],
  },
  {
    id: "light-leak",
    name: "Light Leak",
    category: "effect",
    glsl: LIGHT_LEAK_GLSL,
    params: [
      { name: "intensity", label: "Intensity", type: "number", default: 0.5, min: 0, max: 1, step: 0.01 },
      { name: "warmth", label: "Warmth", type: "number", default: 0.7, min: 0, max: 1, step: 0.01 },
      { name: "speed", label: "Speed", type: "number", default: 1, min: 0, max: 4, step: 0.05 },
    ],
  },
  {
    id: "kaleidoscope",
    name: "Kaleidoscope",
    category: "effect",
    glsl: KALEIDOSCOPE_GLSL,
    params: [
      { name: "segments", label: "Segments", type: "number", default: 6, min: 2, max: 16, step: 1 },
      { name: "spin", label: "Spin", type: "number", default: 0.35, min: 0, max: 2, step: 0.05 },
      { name: "zoom", label: "Zoom", type: "number", default: 1, min: 0.5, max: 2, step: 0.05 },
    ],
  },
  {
    id: "mirror-tiles",
    name: "Mirror Tiles",
    category: "effect",
    glsl: MIRROR_TILES_GLSL,
    params: [
      { name: "columns", label: "Columns", type: "number", default: 4, min: 2, max: 12, step: 1 },
      { name: "rows", label: "Rows", type: "number", default: 3, min: 1, max: 8, step: 1 },
      { name: "shift", label: "Drift", type: "number", default: 0.5, min: 0, max: 2, step: 0.05 },
    ],
  },
  {
    id: "swirl",
    name: "Swirl",
    category: "effect",
    glsl: SWIRL_GLSL,
    params: [
      { name: "amount", label: "Twist", type: "number", default: 1.6, min: 0, max: 6, step: 0.1 },
      { name: "radius", label: "Radius", type: "number", default: 0.75, min: 0.1, max: 1.2, step: 0.05 },
      { name: "speed", label: "Speed", type: "number", default: 1.2, min: 0, max: 4, step: 0.1 },
    ],
  },
  {
    id: "crt-curve",
    name: "CRT Curve",
    category: "effect",
    glsl: CRT_CURVE_GLSL,
    params: [
      { name: "curvature", label: "Curvature", type: "number", default: 0.35, min: 0, max: 1, step: 0.01 },
      { name: "phosphor", label: "Phosphor", type: "number", default: 0.35, min: 0, max: 1, step: 0.01 },
      { name: "flicker", label: "Flicker", type: "number", default: 0.15, min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: "echo",
    name: "Echo Trail",
    category: "effect",
    glsl: ECHO_GLSL,
    params: [
      { name: "amount", label: "Amount", type: "number", default: 0.6, min: 0, max: 1, step: 0.01 },
      { name: "offset", label: "Distance", type: "number", default: 18, min: 0, max: 48, step: 1 },
      { name: "speed", label: "Speed", type: "number", default: 1.5, min: 0, max: 6, step: 0.1 },
    ],
  },
];
