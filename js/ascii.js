// Site background: tiny ASCII characters, invisible until you move or click.
// A cheap fake of water, all on the GPU in three passes per frame. The first two run on a
// coarse grid (one texel per 10 CSS px, upsampled for free by bilinear filtering):
//   1. velocity — advected by itself, a little viscous blur, a slow curl-noise swirl, and
//                 dragged toward the pointer's velocity along its path (no pressure solve:
//                 it isn't needed to read as fluid at this size)
//   2. dye      — stirred into the flow where the pointer moves fast, carried by the velocity
//   3. draw     — clicks are drawn as analytic ripples (expanding wave packets, which look
//                 cleaner than a simulated pond and cost nothing); the ripples refract the dye,
//                 and every screen pixel picks a glyph for its cell from both
// The page's content is land: links, text and media are drawn into a mask texture, the water
// bounces off its edges and never shows on it, and foam gathers along the shore.
// The colour comes from --ascii in style.css; add ?tune to any URL for a live colour picker.
// The pointer path comes from coalesced events, so fast swipes stay continuous. The loop
// stops a few seconds after the last input.
(function () {
  const canvas = document.querySelector('canvas.ascii');
  if (!canvas) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !matchMedia('(pointer: fine)').matches) return;
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl || !(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) return;

  const CHARS = ' .·:-=+*%#';
  const CELL_W = 9, CELL_H = 13, FONT = 10;   // character cell, CSS px
  const SIM = 10;                             // CSS px per simulation texel (square, so ripples stay round)
  const MASK = 5;                             // CSS px per land-mask texel (divides SIM, so both line up)
  const MAX_PTS = 16, MAX_RINGS = 8;
  const RING_LIFE = 3;                        // seconds a ripple lasts
  const LAND = 'a, button, input, select, textarea, h1, h2, p, figcaption, dt, dd, li, img, video, canvas[data-glsl]';
  const SHORE = 10;                           // CSS px of soft beach around each piece of land
  const IDLE = 6000;                          // ms to keep running after the last input

  const HEAD = `precision highp float;
    varying vec2 uv;
    uniform vec2 texel, size;
    uniform vec2 pts[${MAX_PTS}], vels[${MAX_PTS}];
    uniform int count;
    uniform sampler2D land;
    float seg(vec2 p, vec2 a, vec2 b) {
      vec2 ab = b - a;
      float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
      return length(p - a - ab * h);
    }
    // closest approach to the pointer path: x = weight, yz = pointer velocity there
    vec3 path(vec2 c, float r) {
      vec3 best = vec3(0.0);
      for (int i = 0; i < ${MAX_PTS - 1}; i++) {
        if (i >= count - 1) break;
        float d = seg(c, pts[i], pts[i + 1]);
        float w = exp(-d * d / (r * r));
        if (w > best.x) best = vec3(w, vels[i]);
      }
      return best;
    }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
  `;
  const VERT = 'attribute vec2 p; varying vec2 uv; void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';

  const VELOCITY = HEAD + `
    uniform sampler2D vel;
    uniform float dt, t;
    void main() {
      vec2 back = uv - dt * texture2D(vel, uv).xy * texel;
      vec2 v = texture2D(vel, back).xy;
      vec2 nb = 0.25 * (texture2D(vel, back + vec2(texel.x, 0.0)).xy + texture2D(vel, back - vec2(texel.x, 0.0)).xy +
                        texture2D(vel, back + vec2(0.0, texel.y)).xy + texture2D(vel, back - vec2(0.0, texel.y)).xy);
      v = mix(v, nb, 0.25);
      // curl of slow noise: swirls with no sinks, so stirred dye curls instead of sliding straight
      vec2 q = uv * size * 0.07 + vec2(t * 0.05, -t * 0.04);
      vec2 curl = vec2(vnoise(q + vec2(0.0, 0.1)) - vnoise(q - vec2(0.0, 0.1)), vnoise(q - vec2(0.1, 0.0)) - vnoise(q + vec2(0.1, 0.0))) * 5.0;
      v += curl * 60.0 * dt;
      v /= 1.0 + 1.4 * dt;
      // drag the water along with the pointer, like a hand pushed through it
      vec3 p = path(uv * size, 2.6);
      v = mix(v, p.yz, p.x * 0.55);
      // shore: water heading into land bounces back off it, and land itself holds no flow
      vec2 n = vec2(texture2D(land, uv + vec2(texel.x, 0.0)).r - texture2D(land, uv - vec2(texel.x, 0.0)).r,
                    texture2D(land, uv + vec2(0.0, texel.y)).r - texture2D(land, uv - vec2(0.0, texel.y)).r);
      if (dot(n, n) > 1e-4) {
        n = normalize(n);
        float into = dot(v, n);
        if (into > 0.0) v -= 1.6 * into * n;
      }
      v *= 1.0 - texture2D(land, uv).r;
      gl_FragColor = vec4(clamp(v, -600.0, 600.0), 0.0, 1.0);
    }`;

  const DYE = HEAD + `
    uniform sampler2D vel, dye;
    uniform float dt;
    void main() {
      float d = texture2D(dye, uv - dt * texture2D(vel, uv).xy * texel).r / (1.0 + 0.8 * dt);
      // stir in dye only where the pointer moves quickly, so hovering in place stays quiet
      vec3 p = path(uv * size, 2.2);
      d += p.x * clamp(length(p.yz) / 90.0, 0.0, 1.0) * 30.0 * dt;
      d *= 1.0 - texture2D(land, uv).r;
      gl_FragColor = vec4(min(d, 1.5), 0.0, 0.0, 1.0);
    }`;

  const DRAW = `precision highp float;
    uniform sampler2D dye, atlas, land;
    uniform vec2 cell, simCss;
    uniform float glyphs, dpr;
    uniform vec3 color;
    uniform vec4 rings[${MAX_RINGS}];   // centre x, y (CSS px, y up), age (s), unused
    uniform int nRings;
    uniform vec4 front;                 // theme wave: centre x, y, radius, soft edge (CSS px)
    uniform vec3 inkOut, inkIn;         // the new and the old background colour
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    // height of all click ripples at p: each is a short train of crests riding outward,
    // widening and fading like a stone dropped in a pond
    float ripples(vec2 p) {
      float h = 0.0;
      for (int i = 0; i < ${MAX_RINGS}; i++) {
        if (i >= nRings) break;
        float age = rings[i].z, r = age * 230.0, x = length(p - rings[i].xy) - r;
        float width = 26.0 + age * 22.0;
        float env = exp(-x * x / (width * width)) * exp(-age * 1.4) * min(age * 10.0, 1.0);
        h += cos(x * 0.19) * env / (1.0 + r / 350.0);
      }
      return h;
    }
    void main() {
      vec2 ci = floor(gl_FragCoord.xy / cell);
      vec2 local = (gl_FragCoord.xy - ci * cell) / cell;
      vec2 p = (ci + 0.5) * cell / dpr;
      // theme switch: while the view transition runs this canvas sits above the page, and a
      // ragged band of glyphs hides the fade between themes. Ahead of it the new colour eats
      // into the old page; behind it flecks of the old colour linger on the new one
      if (front.z > 0.0) {
        float x = length(p - front.xy) - (front.z - front.w * 0.5) + (hash(ci + 3.1) - 0.5) * front.w * 0.6;
        float k = 1.0 - abs(x) / front.w;
        if (k > 0.0) {
          float g = floor(clamp(k * 0.9 + hash(ci) * 0.15, 0.0, 0.999) * glyphs);
          float a = texture2D(atlas, vec2((g + local.x) / glyphs, 1.0 - local.y)).a * (0.35 + 0.65 * k);
          gl_FragColor = vec4((x > 0.0 ? inkOut : inkIn) * a, a);
          return;
        }
      }
      vec2 muv = p / simCss;
      float m = texture2D(land, muv).r;
      // how close the nearest land is: foam gathers in this band
      vec2 o = ${(SHORE * 1.6).toFixed(1)} / simCss;
      float near = max(max(texture2D(land, muv + vec2(o.x, 0.0)).r, texture2D(land, muv - vec2(o.x, 0.0)).r),
                       max(texture2D(land, muv + vec2(0.0, o.y)).r, texture2D(land, muv - vec2(0.0, o.y)).r));
      float coast = smoothstep(0.05, 0.6, max(near, m * 2.0));
      float h = ripples(p);
      // the ripple slope bends the dye underneath, like light refracting through water
      vec2 slope = vec2(ripples(p + vec2(4.0, 0.0)) - h, ripples(p + vec2(0.0, 4.0)) - h);
      float d = texture2D(dye, (p + slope * 40.0) / simCss).r;
      // crests read strongest, troughs faintly; anything reaching the shore breaks into foam
      float wave = smoothstep(0.02, 0.3, h) + smoothstep(0.02, 0.3, -h) * 0.3;
      float v = clamp(d * 1.1 + wave + coast * (d * 1.6 + abs(h) * 2.5), 0.0, 1.0);
      // fade out gradually as the beach rises into land, rather than stopping at a hard line
      v *= 1.0 - smoothstep(0.1, 0.75, m);
      if (v < 0.05) { gl_FragColor = vec4(0.0); return; }
      float g = floor(clamp(v * 0.85 + hash(ci) * 0.2, 0.0, 0.999) * glyphs);
      float a = texture2D(atlas, vec2((g + local.x) / glyphs, 1.0 - local.y)).a * (0.2 + 0.7 * v);
      gl_FragColor = vec4(color * a, a);
    }`;

  function program(fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    const cache = {};
    return { p, u: name => name in cache ? cache[name] : (cache[name] = gl.getUniformLocation(p, name)) };
  }
  let velP, dyeP, drawP;
  try { velP = program(VELOCITY); dyeP = program(DYE); drawP = program(DRAW); }
  catch (err) { console.warn('ascii background:', err.message); return; }

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function texture(filter) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  // a pair of half-float targets to read from one while writing the other
  function pingpong(w, h) {
    const make = () => {
      const tex = texture(gl.LINEAR), fb = gl.createFramebuffer();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb };
    };
    const pair = { read: make(), write: make() };
    pair.swap = () => { [pair.read, pair.write] = [pair.write, pair.read]; };
    pair.free = () => { for (const s of [pair.read, pair.write]) { gl.deleteTexture(s.tex); gl.deleteFramebuffer(s.fb); } };
    return pair;
  }

  // land mask: page content in document space, redrawn into a small canvas as the page scrolls
  const maskCanvas = document.createElement('canvas');
  const mc = maskCanvas.getContext('2d');
  const landTex = texture(gl.LINEAR);
  let landRects = [], layoutDirty = true, maskDirty = true;
  function measureLand() {
    landRects = [];
    const sx = scrollX, sy = scrollY;
    for (const el of document.querySelectorAll(LAND)) {
      let rects;
      if (/^(IMG|VIDEO|CANVAS)$/.test(el.tagName)) rects = [el.getBoundingClientRect()];
      else {
        // text hugs its lines rather than its full-width box
        const r = document.createRange();
        r.selectNodeContents(el);
        rects = r.getClientRects();
      }
      // the sticky header stays put on screen, so its land is kept in viewport space
      const pinned = !!el.closest('.top');
      for (const b of rects) if (b.width > 1 && b.height > 1) landRects.push([b.left + (pinned ? 0 : sx), b.top + (pinned ? 0 : sy), b.width, b.height, pinned]);
    }
    layoutDirty = false;
    maskDirty = true;
  }
  function drawMask() {
    const s = 1 / MASK, pad = SHORE * s;
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    mc.fillStyle = '#fff';
    mc.filter = `blur(${(SHORE / MASK * 0.8).toFixed(1)}px)`;   // a soft coastline instead of hard boxes
    mc.beginPath();
    for (const [x, y, w, h, pinned] of landRects) {
      const top = pinned ? y : y - scrollY;
      if (top > innerHeight || top + h < 0) continue;
      const rx = (pinned ? x : x - scrollX) * s - pad, ry = top * s - pad, rw = w * s + pad * 2, rh = h * s + pad * 2;
      if (mc.roundRect) mc.roundRect(rx, ry, rw, rh, pad); else mc.rect(rx, ry, rw, rh);
    }
    mc.fill();
    gl.bindTexture(gl.TEXTURE_2D, landTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);   // the mask is drawn y-down; the sim is y-up
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    maskDirty = false;
  }

  let W, H, dpr, cw, ch, simW, simH, vel, dye, atlas;
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = canvas.width = Math.round(innerWidth * dpr);
    H = canvas.height = Math.round(innerHeight * dpr);
    cw = Math.round(CELL_W * dpr);
    ch = Math.round(CELL_H * dpr);
    simW = Math.ceil(innerWidth / SIM);
    simH = Math.ceil(innerHeight / SIM);
    for (const s of [vel, dye]) if (s) s.free();
    vel = pingpong(simW, simH);
    dye = pingpong(simW, simH);
    maskCanvas.width = simW * SIM / MASK;
    maskCanvas.height = simH * SIM / MASK;
    layoutDirty = true;

    // glyph atlas: one cell-sized slot per character, drawn at the exact device pixel size
    const a = document.createElement('canvas');
    a.width = CHARS.length * cw;
    a.height = ch;
    const c2 = a.getContext('2d');
    c2.font = `${Math.round(FONT * dpr)}px ui-monospace, Menlo, Consolas, monospace`;
    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    c2.fillStyle = '#fff';
    [...CHARS].forEach((g, i) => c2.fillText(g, i * cw + cw / 2, ch / 2));
    if (atlas) gl.deleteTexture(atlas);
    atlas = texture(gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    last = null;
  }

  // run one full-screen pass of `prog` into `target` (null = the canvas)
  function pass(prog, target, textures, set) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? simW : W, target ? simH : H);
    gl.useProgram(prog.p);
    Object.entries({ ...textures, land: landTex }).forEach(([name, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(prog.u(name), i);
    });
    gl.uniform2f(prog.u('texel'), 1 / simW, 1 / simH);
    gl.uniform2f(prog.u('size'), simW, simH);
    gl.uniform2fv(prog.u('pts'), flatPts);
    gl.uniform2fv(prog.u('vels'), flatVels);
    gl.uniform1i(prog.u('count'), nPts);
    if (set) set(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // pointer positions in sim texels, y up, with event time for velocity
  const toSim = e => ({ x: e.clientX / SIM, y: (innerHeight - e.clientY) / SIM, t: e.timeStamp });
  const flatPts = new Float32Array(MAX_PTS * 2), flatVels = new Float32Array(MAX_PTS * 2), flatRings = new Float32Array(MAX_RINGS * 4);
  let color = [0, 0, 0], wave = null, pending = [], rings = [], last = null, nPts = 0, lastInput = 0, running = false, prevT = 0;

  function frame(now) {
    const dt = Math.min(Math.max(now - prevT, 0) / 1000, 1 / 30);
    prevT = now;
    if (layoutDirty) measureLand();
    if (maskDirty) drawMask();

    let pts = pending.length ? (last ? [last, ...pending] : pending) : [];
    if (pending.length) last = pending[pending.length - 1];
    pending = [];
    if (pts.length > MAX_PTS) pts = Array.from({ length: MAX_PTS }, (_, i) => pts[Math.round(i * (pts.length - 1) / (MAX_PTS - 1))]);
    nPts = pts.length;
    pts.forEach((p, i) => {
      flatPts[i * 2] = p.x; flatPts[i * 2 + 1] = p.y;
      const q = pts[i + 1];
      if (!q) return;
      const s = Math.max((q.t - p.t) / 1000, 0.004);   // texels per second along this segment
      flatVels[i * 2] = Math.max(-500, Math.min(500, (q.x - p.x) / s));
      flatVels[i * 2 + 1] = Math.max(-500, Math.min(500, (q.y - p.y) / s));
    });

    pass(velP, vel.write, { vel: vel.read.tex }, p => { gl.uniform1f(p.u('dt'), dt); gl.uniform1f(p.u('t'), now / 1000); });
    vel.swap();
    pass(dyeP, dye.write, { vel: vel.read.tex, dye: dye.read.tex }, p => gl.uniform1f(p.u('dt'), dt));
    dye.swap();

    // the theme wave follows its animation's eased progress, so the glyphs stay on the CSS edge
    let waveT = 0;
    if (wave) {
      const t = wave.anim.effect.getComputedTiming().progress;
      if (t == null || wave.anim.playState === 'finished') wave = null; else waveT = t;
    }

    rings = rings.filter(r => now - r.t0 < RING_LIFE * 1000);
    rings.forEach((r, i) => flatRings.set([r.x, r.y, (now - r.t0) / 1000, 0], i * 4));

    pass(drawP, null, { dye: dye.read.tex, atlas }, p => {
      gl.uniform2f(p.u('cell'), cw, ch);
      gl.uniform2f(p.u('simCss'), simW * SIM, simH * SIM);
      gl.uniform1f(p.u('glyphs'), CHARS.length);
      gl.uniform3fv(p.u('color'), color);
      gl.uniform1f(p.u('dpr'), dpr);
      gl.uniform4fv(p.u('rings'), flatRings);
      gl.uniform1i(p.u('nRings'), rings.length);
      gl.uniform4f(p.u('front'), wave ? wave.x : 0, wave ? innerHeight - wave.y : 0, wave ? wave.R * waveT : 0, wave ? wave.soft : 0);
      if (wave) { gl.uniform3fv(p.u('inkOut'), wave.to); gl.uniform3fv(p.u('inkIn'), wave.from); }
    });

    if (now - lastInput < IDLE) requestAnimationFrame(frame);
    else { running = false; last = null; gl.clear(gl.COLOR_BUFFER_BIT); }  // nothing left frozen on screen
  }

  function wake() {
    lastInput = performance.now();
    if (!running) { running = true; prevT = lastInput; requestAnimationFrame(frame); }
  }
  addEventListener('pointermove', e => {
    // coalesced events carry every position the pointer passed through since the last frame
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e]) pending.push(toSim(ev));
    wake();
  }, { passive: true });
  addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    rings.push({ x: e.clientX, y: innerHeight - e.clientY, t0: performance.now() });
    if (rings.length > MAX_RINGS) rings.shift();
    saveRings();
    wake();
  }, { passive: true });
  // the land moves with the page: scrolling just shifts it, layout changes re-measure it
  addEventListener('scroll', () => { maskDirty = true; }, { passive: true });
  addEventListener('load', () => { layoutDirty = true; });
  new ResizeObserver(() => { layoutDirty = true; }).observe(document.body);
  if (document.fonts) document.fonts.ready.then(() => { layoutDirty = true; });

  // colour: the --ascii custom property, re-read whenever the tuning picker changes it
  const rgb = hex => { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  function readColor() {
    color = rgb(getComputedStyle(document.documentElement).getPropertyValue('--ascii').trim() || '#a8ff5c');
  }
  readColor();
  addEventListener('themechange', readColor);
  // the night mode button's wave (js/theme.js)
  addEventListener('themewave', e => {
    const d = e.detail;
    wave = { x: d.x, y: d.y, R: d.R, soft: d.soft, anim: d.anim, from: rgb(d.from), to: rgb(d.to) };
    wake();
  });
  if (new URLSearchParams(location.search).has('tune')) {
    const pick = document.createElement('input');
    pick.type = 'color';
    pick.value = getComputedStyle(document.documentElement).getPropertyValue('--ascii').trim();
    pick.title = 'Background colour (copy the value into --ascii in style.css)';
    pick.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:10;width:44px;height:44px;border:0;padding:0;background:none;cursor:pointer';
    pick.addEventListener('input', () => {
      document.documentElement.style.setProperty('--ascii', pick.value);
      readColor();
      console.log('--ascii:', pick.value);
    });
    document.body.append(pick);
  }
  // clicking a link loads a new page, which would cut its ripple short; keep the rings in
  // session storage with wall-clock times and pick them up again on the next page
  function saveRings() {
    const off = Date.now() - performance.now();
    try { sessionStorage.setItem('ascii-rings', JSON.stringify(rings.map(r => [r.x, r.y, r.t0 + off]))); } catch (e) {}
  }
  try {
    const off = Date.now() - performance.now();
    for (const [x, y, wall] of JSON.parse(sessionStorage.getItem('ascii-rings') || '[]'))
      if (Date.now() - wall < RING_LIFE * 1000) rings.push({ x, y, t0: wall - off });
    if (rings.length) wake();
  } catch (e) {}
  // leaving the window breaks the path, so re-entering elsewhere doesn't draw a streak
  document.addEventListener('pointerout', e => { if (!e.relatedTarget) last = null; });
  addEventListener('resize', resize);
  resize();
})();
