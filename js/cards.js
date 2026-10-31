// Trailz character cards, rebuilt from the game's Unity UI prefab (BasicCharacterCardItem).
// Each canvas draws one card in a single pass, in linear colour like the game:
//   Background (holo, no sprite) → Background_Pattern (holo, tiled character pattern) → CardImage
//   → CardFrame_back (holo, frame sprite) → CardRarity strip + type text → BottomBar (shine) → AmountText.
// The holo layers are a port of Lootheads/GoldenCardFrameShader; each rarity is that shader with its own
// gradient and parameters (Subdomains/Cards/Materials).
// The text is pre-rendered from the game's Calps font (digits.png, driver.png).
// The card sways ±10° on Y like FloatingCard_idle, and the world normal of that turn slides the foil.
(function () {
  const canvases = [...document.querySelectorAll('canvas[data-card]')];
  if (!canvases.length) return;
  const base = canvases[0].dataset.base;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // material values per rarity: [noiseScale, noiseScale2, rotateEffect, secondLayer, parallax1, parallax2],
  // and the strip colour from CardRarityUtils.GetRarityColor
  const RARITY = {
    common:    { bg: [0.73, 0.33, 5.62, 2.0, 0.01, 0.01], frame: [1.5, 0.27, 2.49, 10.16, 0.22, 1.2], color: [2, 252, 102] },
    rare:      { bg: [0.73, 0.66, 5.62, 2.0, 0.01, 0.01], frame: [1.17, 1.29, 2.81, 9.0, 0.22, 1.2], color: [13, 233, 253] },
    epic:      { bg: [0.73, 0.43, 5.62, 1.5, 0.01, 0.01], frame: [1.5, 1.52, 2.64, 3.0, 0.22, 1.2], color: [253, 91, 231] },
    legendary: { bg: [0.5, 0.37, 1.88, 1.68, 0.22, 1.2], frame: [1.01, 1.09, 5.0, 5.0, 0.01, 0.01], color: [253, 145, 48] },
    mythical:  { bg: [0.81, 0.44, 2.16, 1.32, 0.05, 0.05], frame: [0.78, 0.54, 2.4, 3.84, 0.01, 0.01], color: [255, 206, 28] },
  };
  // digits.png: ten 200×255 cells, glyph origin at (20, 20), face ink centred 108.5px down; 200px = one em
  const DIGIT = { w: 200, h: 255, origin: 20, inkMid: 108.5, adv: [89, 61, 78, 81, 83, 83, 83, 68, 82, 83] };
  const AMOUNT_EM = 87.15;              // AmountText font size, in card units
  const DIGIT_GAP = 8;                // extra px between digits: the outlines eat the font's own spacing
  const AMOUNT_C = [138.2, 74.0];       // AmountText box centre inside its margins

  const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
  // layout in prefab units (card 280×390, origin bottom left), from the RectTransforms
  const FRAG = `
precision highp float;
uniform vec2 res;
uniform float angle;
uniform vec4 bgA, frameA;   // noiseScale, noiseScale2, rotateEffect, secondLayer
uniform vec2 bgB, frameB;   // parallax1, parallax2
uniform vec3 rarityColor;
uniform vec4 amountRect;    // centre, size
uniform sampler2D gradTex, patternTex, frameTex, charTex, amountTex, typeTex;

const vec2 VIEW_MIN = vec2(-8.0, -8.0), VIEW_MAX = vec2(288.0, 398.0);
const vec2 CARD_C = vec2(140.0, 195.0);
const float CAM = 1400.0;
const vec2 BG_C = vec2(140.578, 193.944),   BG_S = vec2(266.512, 373.613);
const vec2 PAT_C = vec2(140.578, 195.093),  PAT_S = vec2(266.512, 372.307);
const float PAT_TILE = 512.0 / 3.14;        // sprite px / Image pixelsPerUnitMultiplier
const vec2 FRM_C = vec2(139.618, 195.419),  FRM_S = vec2(276.292, 385.569);
const vec2 ILL_C = vec2(174.806, 219.575),  ILL_S = vec2(324.378, 425.30);
const vec2 STRIP_C = vec2(38.2, 219.7),     STRIP_S = vec2(51.16, 312.97);
const vec2 TYPE_C = vec2(37.95, 308.6),     TYPE_S = vec2(34.4, 116.3);   // rotated 90°, right aligned
const vec2 BAR_C = vec2(140.85, 38.19),     BAR_S = vec2(256.46, 50.07);

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
// textures are uploaded premultiplied so their edges filter cleanly
vec4 tex(sampler2D s, vec2 uv) {
  vec4 c = texture2D(s, uv);
  return vec4(toLinear(c.rgb / max(c.a, 1e-4)), c.a);
}

// Unity's gradient noise; HLSL fmod keeps the sign, GLSL mod doesn't
float fmod(float x, float y) { float q = x / y; return x - y * (q < 0.0 ? ceil(q) : floor(q)); }
vec2 noiseDir(vec2 p) {
  p = vec2(fmod(p.x, 289.0), fmod(p.y, 289.0));
  float x = fmod((34.0 * p.x + 1.0) * p.x, 289.0) + p.y;
  x = fmod((34.0 * x + 1.0) * x, 289.0);
  x = fract(x / 41.0) * 2.0 - 1.0;
  return normalize(vec2(x - floor(x + 0.5), abs(x) - 0.5));
}
float gradientNoise(vec2 p) {
  vec2 ip = floor(p), fp = fract(p);
  float d00 = dot(noiseDir(ip), fp);
  float d01 = dot(noiseDir(ip + vec2(0.0, 1.0)), fp - vec2(0.0, 1.0));
  float d10 = dot(noiseDir(ip + vec2(1.0, 0.0)), fp - vec2(1.0, 0.0));
  float d11 = dot(noiseDir(ip + vec2(1.0, 1.0)), fp - vec2(1.0, 1.0));
  fp = fp * fp * fp * (fp * (fp * 6.0 - 15.0) + 10.0);
  return mix(mix(d00, d01, fp.y), mix(d10, d11, fp.y), fp.x) + 0.5;
}
vec4 softLight(vec4 a, vec4 b) { return (1.0 - 2.0 * b) * a * a + 2.0 * b * a; }

// GoldenCardFrameShader, _IS_SPECIAL_CARD on
vec4 holo(vec2 uv, vec4 mainTex, vec3 n, vec4 A, vec2 B) {
  float s = sin(A.z), c = cos(A.z);
  uv -= 0.5;
  uv = vec2(uv.x * c + uv.y * s, -uv.x * s + uv.y * c) + 0.5;
  uv *= A.x;
  float n1 = gradientNoise((vec2(uv.x, uv.y * 0.01) + n.xy * B.x) * A.x);
  float n2 = gradientNoise((vec2(uv.x) + n.xy * B.y) * A.y);
  n1 = abs(n1 - (n.x + 0.1));
  n2 = abs(n2 - (n.x + 0.1));
  vec4 g = tex(gradTex, vec2(n1));
  vec4 g2 = tex(gradTex, vec2(n2));
  g = softLight(g, mainTex);
  g = softLight(g, g2 * A.w);
  return vec4(clamp(g.rgb, 0.0, 1.0), mainTex.a);
}

// the bottom bar: black with one soft diagonal sheen that slides across as the card turns
vec4 barShine(vec2 uv, vec3 n) {
  float d = uv.x + (uv.y - 0.5) * 0.35 - 0.5 + n.x * 3.0;
  return vec4(vec3(0.006 + 0.006 * exp(-d * d * 18.0)), 1.0);
}

float inside(vec2 uv) { return step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0); }
vec4 over(vec4 dst, vec4 src) { return vec4(mix(dst.rgb, src.rgb, src.a), src.a + dst.a * (1.0 - src.a)); }
vec4 masked(vec4 c, float m) { return vec4(c.rgb, c.a * m); }

void main() {
  // cast the pixel's ray onto the card plane, turned by angle around its vertical centre line
  vec2 q = mix(VIEW_MIN, VIEW_MAX, gl_FragCoord.xy / res) - CARD_C;
  float s = sin(angle), c = cos(angle);
  vec3 d = vec3(q, -CAM);
  float t = -CAM * c / (q.x * s - CAM * c);
  vec3 hit = vec3(0.0, 0.0, CAM) + t * d;
  vec2 p = vec2(hit.x * c - hit.z * s, hit.y) + CARD_C;
  vec3 n = vec3(-s, 0.0, -c);   // the UI quad's world normal

  vec2 frmUV = (p - FRM_C) / FRM_S + 0.5;
  if (inside(frmUV) == 0.0) { gl_FragColor = vec4(0.0); return; }   // nothing outside the card

  vec2 bgUV = (p - BG_C) / BG_S + 0.5;
  vec2 patTiles = (p - (PAT_C - PAT_S * 0.5)) / PAT_TILE;
  vec2 illUV = (p - ILL_C) / ILL_S + 0.5;
  vec2 stripUV = (p - STRIP_C) / STRIP_S + 0.5;
  vec2 typeUV = (p - TYPE_C) / TYPE_S + 0.5;
  vec2 barUV = 1.0 - ((p - BAR_C) / BAR_S + 0.5);   // the bar is turned 180°
  vec2 amtUV = (p - amountRect.xy) / amountRect.zw + 0.5;
  vec4 pattern = tex(patternTex, patTiles);
  vec4 frame = tex(frameTex, vec2(frmUV.x, 1.0 - frmUV.y));
  vec4 illus = tex(charTex, vec2(illUV.x, 1.0 - illUV.y));
  vec4 type = texture2D(typeTex, vec2(typeUV.y, typeUV.x));   // reads bottom to top
  vec4 amount = tex(amountTex, vec2(amtUV.x, 1.0 - amtUV.y));

  // the holo layers are the expensive part, so skip the ones that would end up hidden or empty
  // (the gradient has no mipmaps, so sampling it inside these branches is safe)
  vec4 col = vec4(0.0);
  illus.a *= inside(illUV) * inside(bgUV);
  if (illus.a < 0.999) {
    col = over(col, masked(holo(bgUV, vec4(1.0), n, bgA, bgB), inside(bgUV)));
    // a tiled Image gives every tile its own 0..1 UVs, so the pattern's foil repeats per tile
    float patIn = inside((p - PAT_C) / PAT_S + 0.5);
    if (pattern.a * patIn > 0.0) col = over(col, masked(holo(fract(patTiles), pattern, n, bgA, bgB), patIn));
  }
  // the illustration sits inside the card, tucked under the frame's border
  col = over(col, illus);
  if (frame.a > 0.0) col = over(col, holo(frmUV, frame, n, frameA, frameB));
  col = over(col, vec4(rarityColor, inside(stripUV)));
  col = over(col, vec4(0.0, 0.0, 0.0, type.a * inside(typeUV)));
  col = over(col, masked(barShine(barUV, n), inside(barUV)));
  col = over(col, masked(amount, inside(amtUV)));
  gl_FragColor = vec4(toSrgb(col.rgb) * col.a, col.a);
}`;

  const images = {};
  function load(src) {
    if (!images[src]) images[src] = new Promise((ok, fail) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = fail;
      img.src = base + src;
    });
    return images[src];
  }

  // WebGL1 only mipmaps power-of-two textures, so resample each image to one
  function upload(gl, unit, img, size, repeat, mips = true) {
    const c = document.createElement('canvas');
    c.width = size[0]; c.height = size[1];
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size[0], size[1]);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  }

  // lay the amount out from the digit cells like TMP does: advance by advance, centred on the advances
  function amountTexture(digits, text) {
    const width = text.split('').reduce((w, ch) => w + DIGIT.adv[+ch], 0) + DIGIT_GAP * (text.length - 1);
    const c = document.createElement('canvas');
    c.width = width + 2 * DIGIT.origin + 40; c.height = DIGIT.h;
    const ctx = c.getContext('2d');
    let x = 0;
    for (const ch of text) {
      ctx.drawImage(digits, +ch * DIGIT.w, 0, DIGIT.w, DIGIT.h, x, 0, DIGIT.w, DIGIT.h);
      x += DIGIT.adv[+ch] + DIGIT_GAP;
    }
    const k = AMOUNT_EM / DIGIT.w;   // card units per px
    const rect = [AMOUNT_C[0] + (c.width / 2 - DIGIT.origin - width / 2) * k,
                  AMOUNT_C[1] - (c.height / 2 - DIGIT.inkMid) * k, c.width * k, c.height * k];
    return { canvas: c, rect };
  }

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  // set a card up the first time it comes near the screen, so its textures don't compete with the page load
  function setup(card) {
    const { canvas } = card;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false });
    if (!gl) return;
    const prog = gl.createProgram();
    try {
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    } catch (e) {
      console.error('card', e.message);
      return;
    }
    gl.linkProgram(prog);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = name => gl.getUniformLocation(prog, name);
    ['gradTex', 'patternTex', 'frameTex', 'charTex', 'amountTex', 'typeTex']
      .forEach((name, unit) => gl.uniform1i(u(name), unit));
    const r = RARITY[canvas.dataset.card];
    gl.uniform4fv(u('bgA'), r.bg.slice(0, 4));
    gl.uniform2fv(u('bgB'), r.bg.slice(4));
    gl.uniform4fv(u('frameA'), r.frame.slice(0, 4));
    gl.uniform2fv(u('frameB'), r.frame.slice(4));
    // a Color32 vertex colour, so linear like everything else
    gl.uniform3fv(u('rarityColor'), r.color.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }));
    Object.assign(card, { gl, res: u('res'), angle: u('angle') });
    const { card: rarity, driver, amount = '1' } = canvas.dataset;
    Promise.all([`grad-${rarity}.png`, `pattern-${driver}.webp`, 'frame.webp', `char-${driver}.webp`, 'digits.png', 'driver.png']
      .map(load)).then(([grad, pattern, frame, illus, digits, type]) => {
        upload(gl, 0, grad, [256, 64], true, false);
        upload(gl, 1, pattern, [512, 512], true);
        upload(gl, 2, frame, [512, 1024], false);
        upload(gl, 3, illus, [1024, 1024], false);
        const text = amountTexture(digits, amount);
        upload(gl, 4, text.canvas, [512, 256], false);
        gl.uniform4fv(u('amountRect'), text.rect);
        upload(gl, 5, type, [512, 128], false);
        card.ready = true;
        draw(card, performance.now() / 1000);
      }).catch(e => console.error('card', e));
  }

  const cards = canvases.map((canvas, i) => {
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${canvas.dataset.card} ${canvas.dataset.driver} card`);
    return { canvas, phase: i * 1.3, ready: false, visible: false };
  });

  function draw(card, time) {
    if (!card.ready) return;
    const { canvas, gl } = card;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(card.res, w, h);
    // FloatingCard_idle: a slow ±10° turn; with motion off, hold each card at a fixed tilt
    const deg = still ? 7 * Math.sin(card.phase * 2 + 1) : 10 * Math.sin(time * Math.PI / 5 + card.phase);
    gl.uniform1f(card.angle, deg * Math.PI / 180);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // only animate the cards that are on screen; start loading them a screen ahead
  const cardOf = e => cards.find(c => c.canvas === e.target);
  const near = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { near.unobserve(e.target); setup(cardOf(e)); }
  }, { rootMargin: '100% 0px' });
  const onScreen = new IntersectionObserver(entries => {
    for (const e of entries) {
      const card = cardOf(e);
      card.visible = e.isIntersecting;
      if (still && card.visible) draw(card, 0);
    }
  });
  cards.forEach(card => { near.observe(card.canvas); onScreen.observe(card.canvas); });
  if (still) addEventListener('resize', () => cards.forEach(c => c.visible && draw(c, 0)));

  // the sway is slow, so 30fps looks the same as 60 for half the GPU work
  if (!still) {
    let last = 0;
    (function loop(now) {
      if (now - last > 30) {
        last = now;
        for (const card of cards) if (card.visible) draw(card, now / 1000);
      }
      requestAnimationFrame(loop);
    })(performance.now());
  }
})();
