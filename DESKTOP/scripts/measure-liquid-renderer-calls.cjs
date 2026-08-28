const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
const start = html.indexOf('function compileLiquidShader(');
const end = html.indexOf('function mountLiquidViewportFloat(', start);
if (start < 0 || end < 0) throw new Error('liquid renderer source boundary not found');
const rendererSource = html.slice(start, end);

const counts = {
  canvases: 0,
  contexts: 0,
  shaderCompiles: 0,
  programLinks: 0,
  buffers: 0,
  textures: 0,
  textureUploads: 0,
  uniformLookups: 0,
  canvasResizes: 0,
  draws: 0,
};

function createGl() {
  counts.contexts += 1;
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TEXTURE_2D: 8,
    TEXTURE_MIN_FILTER: 9, TEXTURE_MAG_FILTER: 10, LINEAR: 11,
    TEXTURE_WRAP_S: 12, TEXTURE_WRAP_T: 13, CLAMP_TO_EDGE: 14,
    UNPACK_FLIP_Y_WEBGL: 15, RGBA: 16, UNSIGNED_BYTE: 17, TRIANGLES: 18,
    COLOR_BUFFER_BIT: 19,
    createShader: () => ({}), shaderSource: () => {},
    compileShader: () => { counts.shaderCompiles += 1; },
    getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader: () => {},
    createProgram: () => ({}), attachShader: () => {},
    linkProgram: () => { counts.programLinks += 1; },
    getProgramParameter: () => true, getProgramInfoLog: () => '',
    createBuffer: () => { counts.buffers += 1; return {}; },
    bindBuffer: () => {}, bufferData: () => {}, getAttribLocation: () => 0,
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    createTexture: () => { counts.textures += 1; return {}; },
    bindTexture: () => {}, texParameteri: () => {}, pixelStorei: () => {},
    texImage2D: () => { counts.textureUploads += 1; },
    viewport: () => {}, useProgram: () => {},
    getUniformLocation: () => { counts.uniformLookups += 1; return {}; },
    uniform1i: () => {}, uniform1f: () => {}, uniform2f: () => {}, uniform4f: () => {},
    clearColor: () => {}, clear: () => {},
    drawArrays: () => { counts.draws += 1; },
  };
  return gl;
}

function createCanvas() {
  counts.canvases += 1;
  let gl = null;
  let width = 0;
  let height = 0;
  return {
    className: '', parentNode: null, style: {},
    getContext: kind => {
      if (kind === 'webgl2') {
        if (!gl) gl = createGl();
        return gl;
      }
      if (kind === '2d') return { clearRect: () => {}, drawImage: () => {} };
      return null;
    },
    addEventListener: () => {},
    remove: function() { this.parentNode = null; },
    get width() { return width; },
    set width(value) { counts.canvasResizes += 1; width = value; },
    get height() { return height; },
    set height(value) { counts.canvasResizes += 1; height = value; },
  };
}

let nextFrameId = 1;
const frameCallbacks = new Map();
function flushAnimationFrame() {
  const callbacks = Array.from(frameCallbacks.values());
  frameCallbacks.clear();
  callbacks.forEach(callback => callback());
}

const context = {
  console,
  Float32Array,
  window: { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 },
  document: { createElement: tag => {
    if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
    return createCanvas();
  } },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: callback => {
    const id = nextFrameId++;
    frameCallbacks.set(id, callback);
    return id;
  },
  cancelAnimationFrame: id => { frameCallbacks.delete(id); },
};
vm.createContext(context);
vm.runInContext(rendererSource, context);

for (let interaction = 0; interaction < 10; interaction += 1) {
  const float = {
    dataset: {}, style: {}, isConnected: true,
    appendChild(canvas) { canvas.parentNode = this; this.canvas = canvas; },
    getBoundingClientRect() { return { left: 100, top: 100, width: 180, height: 54 }; },
  };
  context.attachKyantLiquidRenderer(float, { id: `frame-${interaction}`, bitmap: {} });
  for (let frame = 0; frame < 20; frame += 1) {
    float._renderKyantGlass({ left: 100 + frame, top: 100, width: 180, height: 54 });
    flushAnimationFrame();
  }
  if (float._releaseKyantGlass) float._releaseKyantGlass();
  float.isConnected = false;
}

if (counts.textureUploads !== 10) throw new Error(`every interaction must upload a fresh backdrop: ${JSON.stringify(counts)}`);
if (counts.draws !== 200) throw new Error(`visual frame coverage changed: ${JSON.stringify(counts)}`);
if (counts.contexts > 2 || counts.shaderCompiles > 4 || counts.programLinks > 2) {
  throw new Error(`WebGL program resources are being rebuilt per interaction: ${JSON.stringify(counts)}`);
}
if (counts.uniformLookups > 18) throw new Error(`uniform locations are not cached: ${JSON.stringify(counts)}`);
// The pooled WebGL buffer allocates once, while every interaction deliberately
// receives a fresh visible 2D canvas to avoid stale Chromium layer bounds.
if (counts.canvasResizes !== 22) throw new Error(`drawing buffer lifecycle changed: ${JSON.stringify(counts)}`);
process.stdout.write(`${JSON.stringify(counts)}\n`);
