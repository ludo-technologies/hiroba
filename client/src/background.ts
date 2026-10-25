/**
 * background.ts — Camera background effects: blur the room, or replace it
 * with a picture the user chose.
 *
 * A person-segmentation model (MediaPipe's landscape selfie segmenter,
 * Apache-2.0, bundled in assets/ — nothing is fetched from outside) marks
 * which pixels are the user; WebGL keeps those and paints the rest from a
 * blurred copy of the frame or from the picture. The result leaves as a
 * canvas capture track that stands in for the raw camera in the call.
 *
 * @mediapipe/tasks-vision is pinned to 0.10.35 on purpose: from 1.0.0 every
 * task reports usage to Google (odml.pa.googleapis.com) once a minute.
 *
 * audio.ts loads this module with a dynamic import the first time an effect
 * is used, so the model and its ~11 MB WASM runtime cost nothing for anyone
 * who never turns one on.
 *
 * Frames are paced by a worker's timer (background-tick.ts), not by
 * requestAnimationFrame: the window stops painting while it is hidden or
 * covered, and the other end of the call must not freeze because the user
 * looked at another app.
 */

import { ImageSegmenter, type MPMask } from "@mediapipe/tasks-vision";
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";
import modelAssetPath from "./assets/selfie_segmenter_landscape.tflite?url";

/** What goes behind the user. `image` is an already-decoded picture. */
export type CameraBackground =
  | { kind: "none" }
  | { kind: "blur" }
  | { kind: "image"; image: HTMLImageElement };

/** A background that needs this module (anything but `none`). */
export type BackgroundEffectKind = Exclude<CameraBackground, { kind: "none" }>;

/** The blurred room is rendered at this width (height follows the frame).
 *  Blurring a small copy is cheap, and the bilinear upscale back to full size
 *  softens it further. */
const BLUR_WIDTH = 128;

/** Mask confidence below LO is room, above HI is the user; the band between
 *  is the soft edge. Narrower than the raw ramp, so hair and shoulders don't
 *  turn into a translucent halo. */
const EDGE_LO = 0.3;
const EDGE_HI = 0.7;

const VERTEX = `#version 300 es
in vec2 aPos;
uniform bool uFlipY;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  if (uFlipY) vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** The room alone, premultiplied by how sure we are it is room: blurring
 *  that (then dividing by alpha) keeps the user's colours from bleeding into
 *  the blur as a halo around them. */
const MATTE = `#version 300 es
precision mediump float;
uniform sampler2D uFrame;
uniform sampler2D uMask;
in vec2 vUv;
out vec4 o;
void main() {
  float room = 1.0 - texture(uMask, vUv).r;
  o = vec4(texture(uFrame, vUv).rgb * room, room);
}`;

/** One direction of a 9-tap Gaussian; run once horizontally, once vertically. */
const BLUR = `#version 300 es
precision mediump float;
uniform sampler2D uSrc;
uniform vec2 uStep;
in vec2 vUv;
out vec4 o;
const float W[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
void main() {
  vec4 c = texture(uSrc, vUv) * W[0];
  for (int i = 1; i < 5; i++) {
    c += texture(uSrc, vUv + uStep * float(i)) * W[i];
    c += texture(uSrc, vUv - uStep * float(i)) * W[i];
  }
  o = c;
}`;

const COMPOSITE = `#version 300 es
precision mediump float;
uniform sampler2D uFrame;
uniform sampler2D uMask;
uniform sampler2D uBack;
uniform bool uBlur;
/** Picture lookup: uv * xy + zw crops it to cover the frame. */
uniform vec4 uCover;
in vec2 vUv;
out vec4 o;
void main() {
  float user = smoothstep(${EDGE_LO}, ${EDGE_HI}, texture(uMask, vUv).r);
  vec3 back;
  if (uBlur) {
    vec4 b = texture(uBack, vUv);
    back = b.rgb / max(b.a, 0.001);
  } else {
    back = texture(uBack, vUv * uCover.xy + uCover.zw).rgb;
  }
  o = vec4(mix(back, texture(uFrame, vUv).rgb, user), 1.0);
}`;

/**
 * The crop that makes a `pw`×`ph` picture cover a `fw`×`fh` frame without
 * stretching, as texture-space scale (x, y) and offset (z, w): the picture's
 * overflowing sides are cut evenly.
 */
function coverCrop(pw: number, ph: number, fw: number, fh: number): [number, number, number, number] {
  const picture = pw / ph;
  const frame = fw / fh;
  if (picture > frame) {
    const sx = frame / picture;
    return [sx, 1, (1 - sx) / 2, 0];
  }
  const sy = picture / frame;
  return [1, sy, 0, (1 - sy) / 2];
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

/**
 * A running effect on one camera stream. `stream`/`track` carry the result;
 * the source stream is only read, never stopped — it belongs to the caller.
 */
export class BackgroundEffect {
  /** The composited video, to send in place of the camera. */
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;

  private readonly canvas = document.createElement("canvas");
  private readonly gl: WebGL2RenderingContext;
  private readonly ticker: Worker;
  private readonly matte: WebGLProgram;
  private readonly blur: WebGLProgram;
  private readonly composite: WebGLProgram;
  private readonly frameTex: WebGLTexture;
  private readonly maskTex: WebGLTexture;
  private readonly pictureTex: WebGLTexture;
  /** Ping-pong targets for the small blurred room; sized with the frame. */
  private blurA: Target | null = null;
  private blurB: Target | null = null;
  private mask = new Uint8ClampedArray(0);
  private background: BackgroundEffectKind;
  private cover: [number, number, number, number] = [1, 1, 0, 0];
  private stopped = false;

  /**
   * Load the model and start rendering `source` over `background`.
   * `onFail` fires (once) if rendering breaks down later — the GPU context
   * lost, the segmenter throwing — after the effect has already stopped
   * itself; the caller must not keep sending its frozen last frame.
   */
  static async create(
    source: MediaStream,
    background: BackgroundEffectKind,
    onFail: (err: unknown) => void,
  ): Promise<BackgroundEffect> {
    const segmenter = await ImageSegmenter.createFromOptions(
      { wasmLoaderPath, wasmBinaryPath },
      {
        baseOptions: { modelAssetPath, delegate: "CPU" },
        runningMode: "VIDEO",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      },
    );
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = source;
    try {
      await video.play();
      return new BackgroundEffect(segmenter, video, background, onFail);
    } catch (err) {
      video.srcObject = null;
      segmenter.close();
      throw err;
    }
  }

  private constructor(
    private readonly segmenter: ImageSegmenter,
    private readonly video: HTMLVideoElement,
    background: BackgroundEffectKind,
    private readonly onFail: (err: unknown) => void,
  ) {
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error("WebGL2 is unavailable");
    this.gl = gl;
    this.canvas.addEventListener("webglcontextlost", () => this._fail(new Error("WebGL context lost")));

    this.matte = program(gl, MATTE);
    this.blur = program(gl, BLUR);
    this.composite = program(gl, COMPOSITE);
    // One full-screen triangle; every pass draws it.
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    // The frame is mipmapped so the small blur pass averages it down
    // instead of skipping pixels (which shimmers as the user moves).
    this.frameTex = texture(gl, gl.LINEAR_MIPMAP_LINEAR);
    this.maskTex = texture(gl, gl.LINEAR);
    this.pictureTex = texture(gl, gl.LINEAR);

    this.background = background;
    this._resize(video.videoWidth, video.videoHeight);
    this.setBackground(background);

    this.stream = this.canvas.captureStream();
    const [track] = this.stream.getVideoTracks();
    if (!track) throw new Error("canvas capture produced no video track");
    this.track = track;

    this.ticker = new Worker(new URL("./background-tick.ts", import.meta.url), { type: "module" });
    this.ticker.onmessage = () => this._frame();
  }

  /** Switch what goes behind the user; takes effect on the next frame. */
  setBackground(background: BackgroundEffectKind): void {
    this.background = background;
    if (background.kind !== "image") return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.pictureTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, background.image);
    this._fitPicture();
  }

  /** Stop rendering and release the GPU and the model. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ticker.terminate();
    this.track.stop();
    this.video.pause();
    this.video.srcObject = null;
    this.segmenter.close();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  private _fail(err: unknown): void {
    if (this.stopped) return;
    this.stop();
    this.onFail(err);
  }

  private _frame(): void {
    if (this.stopped || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    try {
      const { videoWidth: w, videoHeight: h } = this.video;
      if (w !== this.canvas.width || h !== this.canvas.height) this._resize(w, h);
      this.segmenter.segmentForVideo(this.video, performance.now(), (result) => {
        const mask = result.confidenceMasks?.[0];
        if (!mask) throw new Error("segmenter returned no confidence mask");
        this._uploadMask(mask);
      });
      this._render();
    } catch (err) {
      this._fail(err);
    }
  }

  private _resize(w: number, h: number): void {
    if (w === 0 || h === 0) throw new Error("camera frame has no size");
    const gl = this.gl;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const t of [this.blurA, this.blurB]) {
      if (!t) continue;
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    const bh = Math.max(1, Math.round((BLUR_WIDTH * h) / w));
    this.blurA = target(gl, BLUR_WIDTH, bh);
    this.blurB = target(gl, BLUR_WIDTH, bh);
    this._fitPicture();
  }

  private _fitPicture(): void {
    if (this.background.kind !== "image") return;
    const { naturalWidth, naturalHeight } = this.background.image;
    this.cover = coverCrop(naturalWidth, naturalHeight, this.canvas.width, this.canvas.height);
  }

  private _uploadMask(mask: MPMask): void {
    const confidence = mask.getAsFloat32Array();
    if (this.mask.length !== confidence.length) this.mask = new Uint8ClampedArray(confidence.length);
    for (let i = 0; i < confidence.length; i++) this.mask[i] = confidence[i] * 255;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.width, mask.height, 0, gl.RED, gl.UNSIGNED_BYTE, this.mask);
  }

  private _render(): void {
    const gl = this.gl;
    const blur = this.background.kind === "blur";

    bindTexture(gl, 0, this.frameTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    gl.generateMipmap(gl.TEXTURE_2D);
    bindTexture(gl, 1, this.maskTex);

    if (blur) {
      const a = this.blurA!;
      const b = this.blurB!;
      const bh = Math.round((BLUR_WIDTH * this.canvas.height) / this.canvas.width);
      gl.viewport(0, 0, BLUR_WIDTH, bh);
      pass(gl, this.matte, a.fbo, { uFrame: 0, uMask: 1 });
      // Stepping two texels per tap widens the kernel; bilinear filtering
      // fills the gaps.
      bindTexture(gl, 2, a.tex);
      pass(gl, this.blur, b.fbo, { uSrc: 2 }, { uStep: [2 / BLUR_WIDTH, 0] });
      bindTexture(gl, 2, b.tex);
      pass(gl, this.blur, a.fbo, { uSrc: 2 }, { uStep: [0, 2 / bh] });
      bindTexture(gl, 2, a.tex);
    } else {
      bindTexture(gl, 2, this.pictureTex);
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    pass(gl, this.composite, null, { uFrame: 0, uMask: 1, uBack: 2, uBlur: blur ? 1 : 0 }, {}, this.cover);
  }
}

// ---------------------------------------------------------------------------
// WebGL helpers
// ---------------------------------------------------------------------------

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const p = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const s = gl.createShader(type);
    if (!s) throw new Error("createShader failed");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function texture(gl: WebGL2RenderingContext, minFilter: number): WebGLTexture {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function target(gl: WebGL2RenderingContext, w: number, h: number): Target {
  const tex = texture(gl, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("blur framebuffer incomplete");
  }
  return { tex, fbo };
}

function bindTexture(gl: WebGL2RenderingContext, unit: number, tex: WebGLTexture): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
}

/** Draw the full-screen triangle with `p` into `fbo` (null: the canvas,
 *  flipped upright — textures here are stored top row first). */
function pass(
  gl: WebGL2RenderingContext,
  p: WebGLProgram,
  fbo: WebGLFramebuffer | null,
  ints: Record<string, number>,
  vec2s: Record<string, [number, number]> = {},
  cover?: [number, number, number, number],
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.useProgram(p);
  gl.uniform1i(gl.getUniformLocation(p, "uFlipY"), fbo === null ? 1 : 0);
  for (const [name, v] of Object.entries(ints)) gl.uniform1i(gl.getUniformLocation(p, name), v);
  for (const [name, v] of Object.entries(vec2s)) gl.uniform2f(gl.getUniformLocation(p, name), v[0], v[1]);
  if (cover) gl.uniform4f(gl.getUniformLocation(p, "uCover"), ...cover);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
