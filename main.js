/* WebGL Boxes App */

const PIXEL_SCALE = 8; // Chunky pixel size
const LONG_PRESS_MS = 600;
const CORNER_HIT_PX = 4; // In FBO pixels
const MIN_BOX_SIZE = 6; // In local units

const canvas = document.getElementById('glcanvas');
const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
let gl = null;

// GL resources
let rectProgram = null;
let blitProgram = null;
let rectVAO = null;
let blitVAO = null;
let offscreen = null; // { fbo, tex, width, height }

// Scene state
let nextBoxId = 1;
const boxesById = new Map();
let rootBox = null;

// Interaction state
const interaction = {
  isDown: false,
  isRightButton: false,
  mode: 'none', // 'none' | 'drag-move' | 'drag-resize'
  targetId: null,
  corner: null, // 'tl'|'tr'|'bl'|'br'
  startPointerFbo: { x: 0, y: 0 },
  lastPointerFbo: { x: 0, y: 0 },
  startLocal: { x: 0, y: 0, w: 0, h: 0 },
  parentWorldScaleAtStart: 1,
  childWorldScaleAtStart: 1,
  longPressTimer: null,
  longPressFired: false,
  movedBeyondTap: false,
};

class Box {
  constructor({ id, parentId = null, x = 0, y = 0, w = 40, h = 40, color = [0.2, 0.6, 1.0] }) {
    this.id = id;
    this.parentId = parentId;
    this.children = [];
    this.localX = x; // top-left in parent local units
    this.localY = y;
    this.localW = w;
    this.localH = h;
    this.zoom = 1; // 1=closed, 8=open
    this.isOpen = false;
    this.color = color;
  }
}

function addBox({ parent = null, x = 0, y = 0, w = 20, h = 20, color = null }) {
  const id = nextBoxId++;
  const c = color || randomColorForDepth(parent ? depthOf(parent) + 1 : 0);
  const box = new Box({ id, parentId: parent ? parent.id : null, x, y, w, h, color: c });
  boxesById.set(id, box);
  if (parent) parent.children.push(id);
  return box;
}

function depthOf(box) {
  let d = 0;
  let cur = box;
  while (cur && cur.parentId != null) {
    cur = boxesById.get(cur.parentId);
    d++;
  }
  return d;
}

function randomColorForDepth(depth) {
  const hues = [200, 20, 140, 80, 0, 260];
  const h = hues[depth % hues.length];
  const s = 60;
  const l = 55 - Math.min(depth, 3) * 7;
  const [r, g, b] = hslToRgb(h / 360, s / 100, l / 100);
  return [r, g, b];
}

function hslToRgb(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [r, g, b];
}

function initGL() {
  gl = canvas.getContext('webgl2', { antialias: false, alpha: false, desynchronized: true, preserveDrawingBuffer: false });
  if (!gl) {
    alert('WebGL2 not supported in this browser.');
    throw new Error('WebGL2 unsupported');
  }
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);

  rectProgram = createProgram(
    `#version 300 es\n\nprecision mediump float;\n\nlayout(location=0) in vec2 a_pos;\n\nuniform vec2 u_resolution;\nuniform vec2 u_translation;\nuniform vec2 u_size;\n\nout vec2 v_local;\n\nvoid main() {\n  vec2 pos = a_pos * u_size + u_translation;\n  vec2 zeroToOne = pos / u_resolution;\n  vec2 clip = zeroToOne * 2.0 - 1.0;\n  gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);\n  v_local = a_pos;\n}`,
    `#version 300 es\n\nprecision mediump float;\n\nin vec2 v_local;\nuniform vec4 u_color;\nuniform vec2 u_size;\nuniform float u_border;\n\nout vec4 outColor;\n\nvoid main() {\n  float bx = u_border / max(u_size.x, 1.0);\n  float by = u_border / max(u_size.y, 1.0);\n  bool onBorder = v_local.x < bx || v_local.x > 1.0 - bx || v_local.y < by || v_local.y > 1.0 - by;\n  vec3 color = mix(u_color.rgb, u_color.rgb * 0.5, onBorder ? 1.0 : 0.0);\n  outColor = vec4(color, 1.0);\n}`
  );

  blitProgram = createProgram(
    `#version 300 es\n\nprecision mediump float;\nlayout(location=0) in vec2 a_pos;\nout vec2 v_uv;\nvoid main(){\n  v_uv = a_pos * 0.5 + 0.5;\n  gl_Position = vec4(a_pos, 0.0, 1.0);\n}`,
    `#version 300 es\n\nprecision mediump float;\nin vec2 v_uv;\nuniform sampler2D u_tex;\nout vec4 outColor;\nvoid main(){\n  outColor = texture(u_tex, v_uv);\n}`
  );

  // Unit quad for rects (two triangles), in local space [0,1]^2
  rectVAO = gl.createVertexArray();
  gl.bindVertexArray(rectVAO);
  const rectVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, rectVbo);
  const rectVertices = new Float32Array([
    0, 0,  1, 0,  0, 1,
    0, 1,  1, 0,  1, 1,
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, rectVertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Fullscreen quad
  blitVAO = gl.createVertexArray();
  gl.bindVertexArray(blitVAO);
  const blitVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, blitVbo);
  const blitVerts = new Float32Array([
    -1, -1,   1, -1,   -1, 1,
    -1,  1,   1, -1,    1, 1,
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, blitVerts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
}

function createProgram(vsSource, fsSource) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vsSource);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(vs);
    gl.deleteShader(vs);
    throw new Error('Vertex shader compile error: ' + info);
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fsSource);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error('Fragment shader compile error: ' + info);
  }

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error('Program link error: ' + info);
  }

  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

function createOffscreen(width, height) {
  if (offscreen) {
    gl.deleteTexture(offscreen.tex);
    gl.deleteFramebuffer(offscreen.fbo);
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('Framebuffer incomplete: ' + status.toString());
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  offscreen = { fbo, tex, width, height };
}

function resize() {
  const cssW = Math.floor(canvas.clientWidth);
  const cssH = Math.floor(canvas.clientHeight);
  const desiredW = Math.max(1, Math.floor(cssW * dpr));
  const desiredH = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== desiredW || canvas.height !== desiredH) {
    canvas.width = desiredW;
    canvas.height = desiredH;
  }
  const fboW = Math.max(1, Math.floor(canvas.width / PIXEL_SCALE));
  const fboH = Math.max(1, Math.floor(canvas.height / PIXEL_SCALE));
  if (!offscreen || offscreen.width !== fboW || offscreen.height !== fboH) {
    createOffscreen(fboW, fboH);
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
}

function initScene() {
  rootBox = addBox({ parent: null, x: 16, y: 16, w: 64, h: 64, color: [0.3, 0.7, 1.0] });
  rootBox.isOpen = true;
  rootBox.zoom = 1; // Start at normal scale; double-click to zoom in
}

function computeWorld(box, parentWorld) {
  const parentScale = parentWorld ? parentWorld.worldScale : 1;
  const parentPos = parentWorld ? parentWorld.worldPos : { x: 0, y: 0 };
  const worldScale = parentScale * box.zoom;
  const worldPos = {
    x: parentPos.x + box.localX * parentScale,
    y: parentPos.y + box.localY * parentScale,
  };
  const worldSize = { x: box.localW * worldScale, y: box.localH * worldScale };
  return { worldPos, worldSize, worldScale, parentScale };
}

function flattenWorld(box) {
  const result = [];
  function rec(cur, parentWorld, depth) {
    const t = computeWorld(cur, parentWorld);
    result.push({ box: cur, depth, ...t });
    for (const cid of cur.children) {
      const child = boxesById.get(cid);
      if (child) rec(child, t, depth + 1);
    }
  }
  rec(box, null, 0);
  return result;
}

function render() {
  resize();

  // Render to offscreen (low-res) target
  gl.bindFramebuffer(gl.FRAMEBUFFER, offscreen.fbo);
  gl.viewport(0, 0, offscreen.width, offscreen.height);
  gl.clearColor(0.07, 0.07, 0.07, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const worldList = flattenWorld(rootBox);

  gl.useProgram(rectProgram);
  gl.bindVertexArray(rectVAO);
  const loc = {
    u_resolution: gl.getUniformLocation(rectProgram, 'u_resolution'),
    u_translation: gl.getUniformLocation(rectProgram, 'u_translation'),
    u_size: gl.getUniformLocation(rectProgram, 'u_size'),
    u_color: gl.getUniformLocation(rectProgram, 'u_color'),
    u_border: gl.getUniformLocation(rectProgram, 'u_border'),
  };
  gl.uniform2f(loc.u_resolution, offscreen.width, offscreen.height);
  gl.uniform1f(loc.u_border, 1.0);

  for (const item of worldList) {
    const { box, worldPos, worldSize } = item;
    gl.uniform2f(loc.u_translation, worldPos.x, worldPos.y);
    gl.uniform2f(loc.u_size, Math.max(1, worldSize.x), Math.max(1, worldSize.y));
    gl.uniform4f(loc.u_color, box.color[0], box.color[1], box.color[2], 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  gl.bindVertexArray(null);

  // Blit to screen (nearest upscaling)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(blitProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, offscreen.tex);
  const texLoc = gl.getUniformLocation(blitProgram, 'u_tex');
  gl.uniform1i(texLoc, 0);
  gl.bindVertexArray(blitVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindVertexArray(null);

  requestAnimationFrame(render);
}

function getCanvasRect() {
  return canvas.getBoundingClientRect();
}

function toFboCoords(clientX, clientY) {
  const rect = getCanvasRect();
  const xCss = clientX - rect.left;
  const yCss = clientY - rect.top;
  const xDb = xCss * dpr;
  const yDb = yCss * dpr;
  const xFbo = xDb * (offscreen.width / canvas.width);
  const yFbo = yDb * (offscreen.height / canvas.height);
  return { x: xFbo, y: yFbo };
}

function pickTopmostBoxAt(fboX, fboY) {
  const worldList = flattenWorld(rootBox);
  // iterate back-to-front to get topmost (children last)
  for (let i = worldList.length - 1; i >= 0; i--) {
    const { box, worldPos, worldSize } = worldList[i];
    if (fboX >= worldPos.x && fboX <= worldPos.x + worldSize.x &&
        fboY >= worldPos.y && fboY <= worldPos.y + worldSize.y) {
      return { item: worldList[i], index: i, list: worldList };
    }
  }
  return null;
}

function cornerHitFor(item, fboX, fboY) {
  if (!item.box.isOpen) return null;
  const { worldPos, worldSize } = item;
  const corners = {
    tl: { x: worldPos.x, y: worldPos.y },
    tr: { x: worldPos.x + worldSize.x, y: worldPos.y },
    bl: { x: worldPos.x, y: worldPos.y + worldSize.y },
    br: { x: worldPos.x + worldSize.x, y: worldPos.y + worldSize.y },
  };
  for (const [key, c] of Object.entries(corners)) {
    if (Math.abs(fboX - c.x) <= CORNER_HIT_PX && Math.abs(fboY - c.y) <= CORNER_HIT_PX) {
      return key;
    }
  }
  return null;
}

function pickOpenCornerAt(fboX, fboY) {
  const worldList = flattenWorld(rootBox);
  for (let i = worldList.length - 1; i >= 0; i--) {
    const item = worldList[i];
    const corner = cornerHitFor(item, fboX, fboY);
    if (corner) {
      return { item, corner };
    }
  }
  return null;
}

function startLongPress(item, fboX, fboY) {
  clearLongPress();
  if (!item || !item.box.isOpen) return;
  interaction.longPressFired = false;
  interaction.longPressTimer = setTimeout(() => {
    // Create child box at pointer position within parent local space
    const parentItem = item; // The open box under pointer
    const parent = parentItem.box;
    const parentScale = parentItem.worldScale; // includes parent zoom and ancestors
    const localX = (fboX - parentItem.worldPos.x) / parentScale;
    const localY = (fboY - parentItem.worldPos.y) / parentScale;
    const childW = 16;
    const childH = 12;
    const childX = Math.max(0, Math.min(parent.localW - childW, localX - childW * 0.5));
    const childY = Math.max(0, Math.min(parent.localH - childH, localY - childH * 0.5));
    addBox({ parent, x: childX, y: childY, w: childW, h: childH });
    interaction.longPressFired = true;
  }, LONG_PRESS_MS);
}

function clearLongPress() {
  if (interaction.longPressTimer) {
    clearTimeout(interaction.longPressTimer);
    interaction.longPressTimer = null;
  }
}

function onPointerDown(e) {
  canvas.setPointerCapture(e.pointerId);
  interaction.isDown = true;
  interaction.isRightButton = e.button === 2 || e.buttons === 2;
  interaction.movedBeyondTap = false;

  const p = toFboCoords(e.clientX, e.clientY);
  interaction.startPointerFbo = { x: p.x, y: p.y };
  interaction.lastPointerFbo = { x: p.x, y: p.y };

  // Corner resize: prefer any open box's corner under the pointer, even if overlapped by children
  const cornerPick = pickOpenCornerAt(p.x, p.y);
  if (cornerPick) {
    const { item, corner } = cornerPick;
    interaction.targetId = item.box.id;
    interaction.mode = 'drag-resize';
    interaction.corner = corner;
    interaction.startLocal = { x: item.box.localX, y: item.box.localY, w: item.box.localW, h: item.box.localH };
    interaction.parentWorldScaleAtStart = item.parentScale; // For translating pos deltas
    interaction.childWorldScaleAtStart = item.worldScale; // For size deltas
    clearLongPress();
    return;
  }

  const pick = pickTopmostBoxAt(p.x, p.y);
  if (!pick) {
    interaction.mode = 'none';
    interaction.targetId = null;
    clearLongPress();
    return;
  }

  const { item } = pick;
  interaction.targetId = item.box.id;

  // Right-button: handled on contextmenu separately for close action.

  // Otherwise prepare to move
  interaction.mode = 'none'; // becomes drag-move after small threshold
  interaction.corner = null;
  interaction.startLocal = { x: item.box.localX, y: item.box.localY, w: item.box.localW, h: item.box.localH };
  interaction.parentWorldScaleAtStart = item.parentScale;
  interaction.childWorldScaleAtStart = item.worldScale;

  // Start long-press creation if the target box is open and left button
  if (!interaction.isRightButton && item.box.isOpen) {
    startLongPress(item, p.x, p.y);
  } else {
    clearLongPress();
  }
}

function onPointerMove(e) {
  if (!interaction.isDown) return;
  const p = toFboCoords(e.clientX, e.clientY);
  const dx = p.x - interaction.lastPointerFbo.x;
  const dy = p.y - interaction.lastPointerFbo.y;
  const dist2 = (p.x - interaction.startPointerFbo.x) ** 2 + (p.y - interaction.startPointerFbo.y) ** 2;
  interaction.lastPointerFbo = { x: p.x, y: p.y };

  if (dist2 > 4) interaction.movedBeyondTap = true;

  const target = interaction.targetId != null ? boxesById.get(interaction.targetId) : null;
  if (!target) return;

  if (interaction.mode === 'drag-resize') {
    clearLongPress();
    const scaleForSize = interaction.childWorldScaleAtStart;
    const scaleForPos = interaction.parentWorldScaleAtStart;
    let dLocalX = (p.x - interaction.startPointerFbo.x) / scaleForSize;
    let dLocalY = (p.y - interaction.startPointerFbo.y) / scaleForSize;
    let dLocalPosX = (p.x - interaction.startPointerFbo.x) / scaleForPos;
    let dLocalPosY = (p.y - interaction.startPointerFbo.y) / scaleForPos;

    // Start from initial values
    let x = interaction.startLocal.x;
    let y = interaction.startLocal.y;
    let w = interaction.startLocal.w;
    let h = interaction.startLocal.h;

    if (interaction.corner === 'tl') {
      x = x + dLocalPosX;
      y = y + dLocalPosY;
      w = w - dLocalX;
      h = h - dLocalY;
    } else if (interaction.corner === 'tr') {
      y = y + dLocalPosY;
      w = w + dLocalX;
      h = h - dLocalY;
    } else if (interaction.corner === 'bl') {
      x = x + dLocalPosX;
      w = w - dLocalX;
      h = h + dLocalY;
    } else if (interaction.corner === 'br') {
      w = w + dLocalX;
      h = h + dLocalY;
    }

    // Enforce minimum size
    if (w < MIN_BOX_SIZE) {
      if (interaction.corner === 'tl' || interaction.corner === 'bl') {
        x += w - MIN_BOX_SIZE; // move opposite to keep corner under cursor
      }
      w = MIN_BOX_SIZE;
    }
    if (h < MIN_BOX_SIZE) {
      if (interaction.corner === 'tl' || interaction.corner === 'tr') {
        y += h - MIN_BOX_SIZE;
      }
      h = MIN_BOX_SIZE;
    }

    target.localX = x;
    target.localY = y;
    target.localW = w;
    target.localH = h;
    return;
  }

  // Movement: once exceeded a tiny threshold, enter move mode
  if (interaction.mode === 'none') {
    const threshold2 = 4; // 2px
    if (dist2 > threshold2) {
      interaction.mode = 'drag-move';
      clearLongPress();
    }
  }

  if (interaction.mode === 'drag-move') {
    clearLongPress();
    const parentScale = interaction.parentWorldScaleAtStart;
    const dLocalX = (p.x - interaction.startPointerFbo.x) / parentScale;
    const dLocalY = (p.y - interaction.startPointerFbo.y) / parentScale;

    target.localX = interaction.startLocal.x + dLocalX;
    target.localY = interaction.startLocal.y + dLocalY;
  }
}

function onPointerUp(e) {
  if (!interaction.isDown) return;
  canvas.releasePointerCapture(e.pointerId);
  interaction.isDown = false;

  // If long-press fired, do nothing else
  if (interaction.longPressFired) {
    clearLongPress();
    interaction.mode = 'none';
    return;
  }

  clearLongPress();
  interaction.mode = 'none';
}

function onDblClick(e) {
  const p = toFboCoords(e.clientX, e.clientY);
  const pick = pickTopmostBoxAt(p.x, p.y);
  if (pick) {
    const b = pick.item.box;
    b.isOpen = true;
    b.zoom = 8; // zoom in
  }
}

function onContextMenu(e) {
  e.preventDefault();
  const p = toFboCoords(e.clientX, e.clientY);
  const pick = pickTopmostBoxAt(p.x, p.y);
  if (pick) {
    const b = pick.item.box;
    b.isOpen = false;
    b.zoom = 1; // zoom out
  }
}

function initEvents() {
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('resize', resize);
}

function main() {
  initGL();
  initScene();
  initEvents();
  resize();
  requestAnimationFrame(render);
}

// Kick off when DOM is ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  main();
} else {
  window.addEventListener('DOMContentLoaded', main);
}