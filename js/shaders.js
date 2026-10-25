// Live shader breakdown: compiles the GLSL shown in each <code data-glsl> block
// (plus the shared helpers block) into the canvas next to it.
(function () {
  const helpers = document.getElementById('glsl-helpers');
  const steps = [...document.querySelectorAll('canvas[data-glsl]')];
  if (!helpers || !steps.length) return;

  const HEADER = 'precision highp float;\nuniform vec2 res;\nuniform float t;\nuniform float aspect;\n';
  const MAIN = '\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / res - 0.5;\n  gl_FragColor = vec4(frag(uv), 1.0);\n}\n';
  const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  const views = steps.map(canvas => {
    const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) return null;
    const code = document.getElementById(canvas.dataset.glsl).textContent;
    const prog = gl.createProgram();
    try {
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, HEADER + helpers.textContent + '\n' + code + MAIN));
    } catch (e) {
      console.error(canvas.dataset.glsl, e.message);
      return null;
    }
    gl.linkProgram(prog);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    return { canvas, gl, res: gl.getUniformLocation(prog, 'res'), t: gl.getUniformLocation(prog, 't'),
             aspect: gl.getUniformLocation(prog, 'aspect'), visible: false };
  }).filter(Boolean);

  function draw(v, time) {
    const { canvas, gl } = v;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(v.res, w, h);
    gl.uniform1f(v.t, time);
    gl.uniform1f(v.aspect, w / h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // only animate the canvases that are on screen
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const v = views.find(v => v.canvas === e.target);
      v.visible = e.isIntersecting;
      if (still && v.visible) draw(v, 2);
    }
  });
  views.forEach(v => io.observe(v.canvas));

  if (!still) {
    const start = performance.now();
    (function loop(now) {
      const time = (now - start) / 1000;
      for (const v of views) if (v.visible) draw(v, time);
      requestAnimationFrame(loop);
    })(start);
  }
})();
