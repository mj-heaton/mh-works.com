/* ==========================================================================
   MH Works — hero particle field

   A dependency-free WebGL2 rewrite of the three.js "interactive particles"
   sketch the site used to ship (Bruno Imbrizi, MIT). Same idea — one billboard
   per source pixel, scattered on load, rippling under the cursor — but:

     · no three.js / gsap / webpack: ~1MB of bundle becomes this file
     · the source image is resampled to a fixed grid, so particle count is a
       budget (~100k) instead of whatever the image happens to be (chain2.png
       is 1324x820, i.e. over a million quads)
     · particles are soft round sprites, not hard squares
     · the jet colour map is remapped, in-shader, onto the brand gradient:
       hue → scalar → deep teal ▸ cyan ▸ violet ▸ magenta. Structure kept,
       1990s contour-plot palette gone
     · depth fade, cursor parallax and a slow idle drift, so it is alive
       without the mouse
     · honours prefers-reduced-motion, pauses on hidden tabs, survives context
       loss, and degrades to the CSS aurora when WebGL2 is missing

   Simplex noise below is Ashima Arts / Stefan Gustavson (MIT).
   ========================================================================== */

(function () {
	'use strict';

	var CONFIG = {
		src: 'images/chain2.png',
		// The grid is sized so one cell lands roughly this many CSS pixels apart
		// on screen. That, not a fixed cell count, is what decides whether the
		// result reads as grains or as a continuous smear: chain2.png at its
		// native 1324x820 puts several cells inside one pixel, which is why the
		// old build rendered a million quads to look like a blurry photo.
		spacing: { desktop: 2.15, touch: 3.0 },
		// How far toward the brand ramp the jet colour map is pushed. Dial down
		// for more of the original plot, up for more brand.
		recolour: 0.45,
		maxCols: 720,
		minCols: 160,
		fov: 50,
		camZ: 300,
		alphaCut: 24, // source alpha below this is background
		lumaCut: 0.05, // and so is anything this dark
		// size is in grid cells: a shade over 1.0 keeps grains touching without
		// dissolving into a solid mass.
		settled: { random: 0.5, depth: 4.0, size: 0.6 },
		scattered: { random: 6.0, depth: 48.0 },
		introDuration: 1.9
	};

	var mount = document.querySelector('.field');
	if (!mount) return;

	var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	var canvas = document.createElement('canvas');
	// premultipliedAlpha stays true (the default): the canvas is composited over
	// the CSS aurora, and straight alpha would get multiplied a second time by
	// the compositor, darkening every particle.
	var gl = canvas.getContext('webgl2', {
		alpha: true,
		antialias: false,
		depth: false,
		stencil: false,
		powerPreference: 'high-performance'
	});

	// No WebGL2 (or it failed to initialise): leave the container empty and let
	// the CSS aurora and dot grid carry the page.
	if (!gl) return;

	mount.appendChild(canvas);

	/* --- shaders ---------------------------------------------------------- */

	var VERT = [
		'#version 300 es',
		'precision highp float;',
		'',
		'in vec3 aCorner;',
		'in vec2 aUv;',
		'in vec2 aOffset;', // cell coordinates within the grid
		'in float aAngle;',
		'in float aSeed;',
		'',
		'uniform mat4 uProjection;',
		'uniform mat4 uModelView;',
		'uniform sampler2D uTexture;',
		'uniform sampler2D uTouch;',
		'uniform vec2 uGrid;',
		'uniform float uTime;',
		'uniform float uRandom;',
		'uniform float uDepth;',
		'uniform float uSize;',
		'uniform float uScale;', // world units per cell
		'uniform float uRecolour;', // 0 = the plot as rendered, 1 = pure brand ramp
		'uniform float uUnit;', // keeps displacement consistent across grid sizes
		'uniform float uCamZ;',
		'',
		'out vec2 vUv;',
		'out vec4 vColor;',
		'out float vFade;',
		'out float vGlow;',
		'',
		// --- simplex noise (Ashima Arts, MIT) ---
		'vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
		'vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
		'vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }',
		'float snoise(vec2 v) {',
		'	const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);',
		'	vec2 i  = floor(v + dot(v, C.yy));',
		'	vec2 x0 = v - i + dot(i, C.xx);',
		'	vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);',
		'	vec4 x12 = x0.xyxy + C.xxzz;',
		'	x12.xy -= i1;',
		'	i = mod289(i);',
		'	vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));',
		'	vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);',
		'	m = m * m; m = m * m;',
		'	vec3 x = 2.0 * fract(p * C.www) - 1.0;',
		'	vec3 h = abs(x) - 0.5;',
		'	vec3 ox = floor(x + 0.5);',
		'	vec3 a0 = x - ox;',
		'	m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);',
		'	vec3 g;',
		'	g.x  = a0.x  * x0.x  + h.x  * x0.y;',
		'	g.yz = a0.yz * x12.xz + h.yz * x12.yw;',
		'	return 130.0 * dot(m, g);',
		'}',
		'',
		'float random(float n) { return fract(sin(n) * 43758.5453123); }',
		'',
		'vec3 rgb2hsv(vec3 c) {',
		'	vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);',
		'	vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));',
		'	vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));',
		'	float d = q.x - min(q.w, q.y);',
		'	return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1.0e-10)), d / (q.x + 1.0e-10), q.x);',
		'}',
		'',
		// The source is an FEA contour plot in the jet colour map, so hue *is*
		// the scalar field: blue (low) → cyan → green → yellow → red (high).
		// Recover that scalar, then re-render it in the brand gradient.
		// Seven stops walking the brand hue arc (teal → cyan → azure → violet →
		// magenta → hot pink) with no gaps between the smoothstep windows. The
		// earlier three-stop version left a flat plateau across 0.30–0.45, which
		// is exactly where this plot's large green mid-range lands — so most of
		// the surface came out one undifferentiated colour.
		'vec3 brandRamp(float t) {',
		'	vec3 c0 = vec3(0.039, 0.353, 0.400);', // deep teal
		'	vec3 c1 = vec3(0.071, 0.710, 0.788);', // teal-cyan
		'	vec3 c2 = vec3(0.184, 0.890, 1.000);', // cyan
		'	vec3 c3 = vec3(0.290, 0.659, 1.000);', // azure
		'	vec3 c4 = vec3(0.545, 0.361, 0.965);', // violet
		'	vec3 c5 = vec3(0.914, 0.208, 0.878);', // magenta
		'	vec3 c6 = vec3(1.000, 0.420, 0.880);', // hot pink
		'	vec3 c = c0;',
		'	c = mix(c, c1, smoothstep(0.00, 0.20, t));',
		'	c = mix(c, c2, smoothstep(0.20, 0.40, t));',
		'	c = mix(c, c3, smoothstep(0.40, 0.58, t));',
		'	c = mix(c, c4, smoothstep(0.58, 0.76, t));',
		'	c = mix(c, c5, smoothstep(0.76, 0.90, t));',
		'	c = mix(c, c6, smoothstep(0.90, 1.00, t));',
		'	return c;',
		'}',
		'',
		'void main() {',
		'	vUv = aUv;',
		'',
		'	vec2 puv = (aOffset + 0.5) / uGrid;',
		'	vec4 src = texture(uTexture, puv);',
		'	vec3 hsv = rgb2hsv(src.rgb);',
		'	float scalar = clamp((0.666667 - hsv.x) / 0.666667, 0.0, 1.0);',
		'	vec3 brand = brandRamp(scalar);',
		// Push away from grey. Resampling averages neighbouring contour bands,
		// and those averages are what carry the plot's structure, so they need
		// to stay saturated rather than drift toward mud.
		'	float luma = dot(brand, vec3(0.2126, 0.7152, 0.0722));',
		'	brand = clamp(mix(vec3(luma), brand, 1.5), 0.0, 1.0);',
		// Keep a share of the plot's own colour. A total hue replacement folds
		// jet's five bands into two brand families, which is how the part ended
		// up reading as one pink-and-blue blob.
		'	vec3 tint = mix(src.rgb, brand, uRecolour);',
		// The source's value is the shading — highlights along the rods, dark
		// creases where the two links cross. Throwing it away is what flattened
		// the form; scalar then only leans on the stress concentrations.
		'	tint *= (0.5 + 0.85 * hsv.z) * (0.85 + 0.35 * scalar);',
		// Antialiased edges of the plot are desaturated; fading them removes the
		// grey haze around the silhouette. Gated gently — too hard a gate also
		// eats the contour boundaries, which is where the contrast lives.
		'	float edge = smoothstep(0.10, 0.40, hsv.y);',
		'	vColor = vec4(tint, src.a * mix(0.25, 1.0, edge));',
		// High-stress particles hold their colour but give up alpha, so they
		// accumulate additively and bloom where the field is dense.
		'	vGlow = smoothstep(0.60, 1.0, scalar) * 0.45;',
		'',
		'	vec3 displaced = vec3(aOffset, 0.0);',
		'	displaced.xy += vec2(random(aSeed) - 0.5, random(aSeed + 1.7) - 0.5) * uRandom * uUnit;',
		'	float rndz = random(aSeed) + snoise(vec2(aSeed * 0.1, uTime * 0.1));',
		'	displaced.z += rndz * (random(aSeed) * 2.0 * uDepth * uUnit);',
		'	displaced.xy -= uGrid * 0.5;',
		'',
		'	float touch = texture(uTouch, puv).r;',
		'	displaced.z += touch * 22.0 * rndz * uUnit;',
		'	displaced.x += cos(aAngle) * touch * 22.0 * rndz * uUnit;',
		'	displaced.y += sin(aAngle) * touch * 22.0 * rndz * uUnit;',
		'',
		'	float psize = (snoise(vec2(uTime * 0.6, aSeed) * 0.5) + 2.0) * uSize;',
		// Bright (high-scalar) particles read a touch larger, so the stress
		// concentrations carry the eye.
		'	psize *= 0.85 + 0.45 * scalar;',
		'',
		'	vec4 mv = uModelView * vec4(displaced, 1.0);',
		'	mv.xyz += aCorner * psize * uScale;',
		'',
		'	float dist = -mv.z;',
		'	vFade = mix(0.28, 1.0, clamp((uCamZ * 1.65 - dist) / (uCamZ * 1.15), 0.0, 1.0));',
		'',
		'	gl_Position = uProjection * mv;',
		'}'
	].join('\n');

	var FRAG = [
		'#version 300 es',
		'precision highp float;',
		'',
		'in vec2 vUv;',
		'in vec4 vColor;',
		'in float vFade;',
		'in float vGlow;',
		'',
		'out vec4 fragColor;',
		'',
		'void main() {',
		'	float d = distance(vUv, vec2(0.5));',
		'	float a = smoothstep(0.5, 0.16, d);',
		'	float alpha = vColor.a * a * vFade;',
		'	if (alpha < 0.004) discard;',
		// Premultiplied. Holding rgb while dropping the written alpha turns the
		// bright end of the ramp additive against blendFunc(ONE, 1-SRC_ALPHA).
		'	fragColor = vec4(vColor.rgb * alpha, alpha * (1.0 - vGlow));',
		'}'
	].join('\n');

	function compile(type, source) {
		var shader = gl.createShader(type);
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			console.error(gl.getShaderInfoLog(shader));
			gl.deleteShader(shader);
			return null;
		}
		return shader;
	}

	function link(vertSource, fragSource) {
		var vert = compile(gl.VERTEX_SHADER, vertSource);
		var frag = compile(gl.FRAGMENT_SHADER, fragSource);
		if (!vert || !frag) return null;
		var prog = gl.createProgram();
		gl.attachShader(prog, vert);
		gl.attachShader(prog, frag);
		gl.linkProgram(prog);
		gl.deleteShader(vert);
		gl.deleteShader(frag);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
			console.error(gl.getProgramInfoLog(prog));
			return null;
		}
		return prog;
	}

	/* --- maths ------------------------------------------------------------ */

	function perspective(out, fovyRad, aspect, near, far) {
		var f = 1.0 / Math.tan(fovyRad / 2);
		var nf = 1 / (near - far);
		out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
		out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
		out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
		out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
		return out;
	}

	// modelView = translate(0,0,-camZ) · translate(t) · rotateY(theta) · scale(s)
	function modelView(out, tx, ty, tz, theta, s, camZ) {
		var c = Math.cos(theta);
		var sn = Math.sin(theta);
		out[0] = s * c; out[1] = 0; out[2] = -s * sn; out[3] = 0;
		out[4] = 0; out[5] = s; out[6] = 0; out[7] = 0;
		out[8] = s * sn; out[9] = 0; out[10] = s * c; out[11] = 0;
		out[12] = tx; out[13] = ty; out[14] = tz - camZ; out[15] = 1;
		return out;
	}

	function easeOutCubic(t) {
		return 1 - Math.pow(1 - t, 3);
	}
	function easeOutSine(t) {
		return Math.sin((t * Math.PI) / 2);
	}

	/* --- cursor ripple texture -------------------------------------------- */
	/* A 64x64 canvas of white blobs that age out; the vertex shader reads it as
	   a displacement mask, so the field ripples where the cursor has been. */

	function TouchTexture() {
		this.size = 64;
		this.maxAge = 110;
		this.radius = 0.16;
		this.trail = [];
		this.canvas = document.createElement('canvas');
		this.canvas.width = this.canvas.height = this.size;
		this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
		this.clear();
		this.dirty = true;
	}
	TouchTexture.prototype.clear = function () {
		this.ctx.fillStyle = 'black';
		this.ctx.fillRect(0, 0, this.size, this.size);
	};
	TouchTexture.prototype.add = function (x, y) {
		var force = 0;
		var last = this.trail[this.trail.length - 1];
		if (last) {
			var dx = last.x - x;
			var dy = last.y - y;
			force = Math.min((dx * dx + dy * dy) * 10000, 1);
		}
		this.trail.push({ x: x, y: y, age: 0, force: force });
		this.dirty = true;
	};
	TouchTexture.prototype.update = function () {
		if (!this.trail.length && !this.dirty) return false;
		this.clear();
		for (var i = this.trail.length - 1; i >= 0; i--) {
			this.trail[i].age++;
			if (this.trail[i].age > this.maxAge) this.trail.splice(i, 1);
		}
		for (var j = 0; j < this.trail.length; j++) this.draw(this.trail[j]);
		this.dirty = this.trail.length > 0;
		return true;
	};
	TouchTexture.prototype.draw = function (point) {
		var x = point.x * this.size;
		// Not (1 - y): this canvas is uploaded with UNPACK_FLIP_Y off, so its top
		// row is texture v=0 — the same row the grid's row 0 lands on. three.js
		// flipped canvas textures for you, which is where the inverted original
		// came from.
		var y = point.y * this.size;
		var ramp = this.maxAge * 0.3;
		var intensity =
			point.age < ramp
				? easeOutSine(point.age / ramp)
				: easeOutSine(1 - (point.age - ramp) / (this.maxAge - ramp));
		intensity *= point.force;

		var radius = this.size * this.radius * intensity;
		if (radius <= 0.01) return;
		var grd = this.ctx.createRadialGradient(x, y, radius * 0.25, x, y, radius);
		grd.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
		grd.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
		this.ctx.fillStyle = grd;
		this.ctx.beginPath();
		this.ctx.arc(x, y, radius, 0, Math.PI * 2);
		this.ctx.fill();
	};

	/* --- resample the source image onto a fixed grid ----------------------- */

	function resample(img, gw) {
		var aspect = img.width / img.height;
		var gh = Math.max(2, Math.round(gw / aspect));

		var c = document.createElement('canvas');
		c.width = gw;
		c.height = gh;
		var ctx = c.getContext('2d', { willReadFrequently: true });
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		// Flip vertically: grid row 0 becomes the bottom of the image, which is
		// also where world +y starts.
		ctx.translate(0, gh);
		ctx.scale(1, -1);
		ctx.drawImage(img, 0, 0, gw, gh);

		return { canvas: c, data: ctx.getImageData(0, 0, gw, gh).data, gw: gw, gh: gh };
	}

	/* --- build ------------------------------------------------------------ */

	var program = link(VERT, FRAG);
	if (!program) return;

	var U = {};
	[
		'uProjection', 'uModelView', 'uTexture', 'uTouch', 'uGrid', 'uTime',
		'uRandom', 'uDepth', 'uSize', 'uScale', 'uUnit', 'uCamZ', 'uRecolour'
	].forEach(function (name) {
		U[name] = gl.getUniformLocation(program, name);
	});

	var state = {
		count: 0,
		gw: 0,
		gh: 0,
		unit: 1,
		scale: 1,
		baseTx: 0,
		baseTy: 0,
		tx: 0,
		ty: 0,
		tz: 0,
		theta: 0,
		time: 0,
		intro: 0,
		pointer: { x: 0, y: 0 },
		pointerTarget: { x: 0, y: 0 },
		running: false,
		ready: false,
		lost: false,
		config: CONFIG
	};

	var projection = new Float32Array(16);
	var modelview = new Float32Array(16);
	var touch = new TouchTexture();
	var vao = null;
	var srcTexture = null;
	var touchTexture = null;

	var image = new Image();
	image.decoding = 'async';
	image.onload = build;
	image.onerror = function () {
		/* Aurora-only fallback; nothing to clean up. */
	};
	image.src = CONFIG.src;

	function build() {
		var coarse = window.matchMedia('(pointer: coarse)').matches;
		var spacing = coarse ? CONFIG.spacing.touch : CONFIG.spacing.desktop;
		// How wide the field will be on screen, in CSS pixels, at the viewport
		// it loaded into. Resizing later rescales the same grid rather than
		// rebuilding it, so the grain shifts a little on a big window change.
		var fieldPx = (window.innerWidth >= 900 ? 0.56 : 0.94) * window.innerWidth;
		var cols = Math.round(fieldPx / spacing);
		cols = Math.max(CONFIG.minCols, Math.min(CONFIG.maxCols, cols));

		var grid = resample(image, cols);
		state.gw = grid.gw;
		state.gh = grid.gh;
		state.unit = grid.gh / 320;

		var data = grid.data;
		var total = grid.gw * grid.gh;
		var lumaCut = CONFIG.lumaCut * 255;

		// Two passes: count survivors, then fill exact-sized arrays.
		var visible = 0;
		var i;
		for (i = 0; i < total; i++) {
			if (data[i * 4 + 3] < CONFIG.alphaCut) continue;
			if (
				data[i * 4] * 0.21 + data[i * 4 + 1] * 0.71 + data[i * 4 + 2] * 0.07 <
				lumaCut
			) {
				continue;
			}
			visible++;
		}
		if (!visible) return;

		var offsets = new Float32Array(visible * 2);
		var angles = new Float32Array(visible);
		var seeds = new Float32Array(visible);

		for (i = 0, visible = 0; i < total; i++) {
			if (data[i * 4 + 3] < CONFIG.alphaCut) continue;
			if (
				data[i * 4] * 0.21 + data[i * 4 + 1] * 0.71 + data[i * 4 + 2] * 0.07 <
				lumaCut
			) {
				continue;
			}
			offsets[visible * 2] = i % grid.gw;
			offsets[visible * 2 + 1] = Math.floor(i / grid.gw);
			angles[visible] = Math.random() * Math.PI * 2;
			seeds[visible] = i * 0.017 + Math.random();
			visible++;
		}
		state.count = visible;

		// --- geometry: one instanced quad ---
		vao = gl.createVertexArray();
		gl.bindVertexArray(vao);

		var corners = new Float32Array([
			-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0
		]);
		var uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

		bindAttrib('aCorner', corners, 3, 0);
		bindAttrib('aUv', uvs, 2, 0);
		bindAttrib('aOffset', offsets, 2, 1);
		bindAttrib('aAngle', angles, 1, 1);
		bindAttrib('aSeed', seeds, 1, 1);

		var indexBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
		gl.bufferData(
			gl.ELEMENT_ARRAY_BUFFER,
			new Uint16Array([0, 2, 1, 2, 3, 1]),
			gl.STATIC_DRAW
		);

		gl.bindVertexArray(null);

		// --- textures ---
		srcTexture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, srcTexture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, grid.canvas);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

		touchTexture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, touchTexture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, touch.canvas);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

		gl.useProgram(program);
		gl.uniform1i(U.uTexture, 0);
		gl.uniform1i(U.uTouch, 1);
		gl.uniform2f(U.uGrid, state.gw, state.gh);
		gl.uniform1f(U.uUnit, state.unit);
		gl.uniform1f(U.uCamZ, CONFIG.camZ);

		gl.disable(gl.DEPTH_TEST);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // source is premultiplied

		state.ready = true;
		window.mhHero = state; // handy when tuning; costs nothing

		resize();
		addListeners();

		if (reduceMotion) {
			// Settled, still, single frame.
			state.intro = 1;
			draw();
		} else {
			start();
		}
	}

	function bindAttrib(name, array, size, divisor) {
		var loc = gl.getAttribLocation(program, name);
		if (loc < 0) return;
		var buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
		gl.vertexAttribDivisor(loc, divisor);
	}

	/* --- layout ----------------------------------------------------------- */

	function resize() {
		if (!state.ready) return;

		var w = window.innerWidth;
		var h = window.innerHeight;
		var dpr = Math.min(window.devicePixelRatio || 1, 2);

		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		canvas.style.width = w + 'px';
		canvas.style.height = h + 'px';
		gl.viewport(0, 0, canvas.width, canvas.height);

		var aspect = w / h;
		var fovRad = (CONFIG.fov * Math.PI) / 180;
		perspective(projection, fovRad, aspect, 1, 10000);

		state.aspect = aspect;
		state.tanHalf = Math.tan(fovRad / 2);
		state.fovHeight = 2 * state.tanHalf * CONFIG.camZ;
		state.fovWidth = state.fovHeight * aspect;

		// Wide screens: the field sits right of the copy, mirroring voxelflow.io.
		// Between 900 and 1200 the hero column takes most of the width, so the
		// field shrinks and shifts further right rather than sitting on top of
		// the lead paragraph. Narrow screens: centred behind the copy, under a
		// top-down scrim.
		var wide = w >= 900;
		var mid = wide && w < 1200;
		var fillW = wide ? (mid ? 0.5 : 0.56) : 0.94;
		var fillH = wide ? (mid ? 0.66 : 0.76) : 0.5;
		state.scale = Math.min(
			(state.fovWidth * fillW) / state.gw,
			(state.fovHeight * fillH) / state.gh
		);
		state.baseTx = wide ? state.fovWidth * (mid ? 0.2 : 0.155) : 0;
		state.baseTy = wide ? 0 : -state.fovHeight * 0.04;
		state.tx = state.baseTx;
		state.ty = state.baseTy;

		if (reduceMotion) draw();
	}

	/* --- pointer ---------------------------------------------------------- */

	// Ray-cast the cursor onto the field's plane to get the cell UV the ripple
	// should be stamped at. The transform is affine, so inverting it by hand is
	// cheaper (and shorter) than carrying a matrix library.
	function pointerToUv(px, py) {
		var ndcX = (px / window.innerWidth) * 2 - 1;
		var ndcY = 1 - (py / window.innerHeight) * 2;

		var dx = ndcX * state.tanHalf * state.aspect;
		var dy = ndcY * state.tanHalf;
		var dz = -1;

		var ox = -state.tx;
		var oy = -state.ty;
		var oz = CONFIG.camZ - state.tz;

		var c = Math.cos(-state.theta);
		var s = Math.sin(-state.theta);

		var omx = (c * ox + s * oz) / state.scale;
		var omy = oy / state.scale;
		var omz = (-s * ox + c * oz) / state.scale;

		var dmx = (c * dx + s * dz) / state.scale;
		var dmy = dy / state.scale;
		var dmz = (-s * dx + c * dz) / state.scale;

		if (Math.abs(dmz) < 1e-6) return null;
		var t = -omz / dmz;
		if (t <= 0) return null;

		var u = (omx + dmx * t + state.gw * 0.5) / state.gw;
		var v = (omy + dmy * t + state.gh * 0.5) / state.gh;
		if (u < 0 || u > 1 || v < 0 || v > 1) return null;
		return { u: u, v: v };
	}

	function onPointerMove(e) {
		var px = e.clientX;
		var py = e.clientY;

		state.pointerTarget.x = (px / window.innerWidth) * 2 - 1;
		state.pointerTarget.y = 1 - (py / window.innerHeight) * 2;

		var uv = pointerToUv(px, py);
		if (uv) touch.add(uv.u, uv.v);
	}

	function addListeners() {
		window.addEventListener('resize', onResize);
		canvas.addEventListener(
			'webglcontextlost',
			function (e) {
				e.preventDefault();
				state.lost = true;
				stop();
			},
			false
		);
		if (reduceMotion) return;

		window.addEventListener('pointermove', onPointerMove, { passive: true });
		document.addEventListener('visibilitychange', function () {
			if (document.hidden) stop();
			else start();
		});
	}

	var resizePending = false;
	function onResize() {
		if (resizePending) return;
		resizePending = true;
		requestAnimationFrame(function () {
			resizePending = false;
			resize();
		});
	}

	/* --- loop ------------------------------------------------------------- */

	var raf = 0;
	var last = 0;

	function start() {
		if (state.running || state.lost || !state.ready) return;
		state.running = true;
		last = performance.now();
		raf = requestAnimationFrame(tick);
	}

	function stop() {
		state.running = false;
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	}

	function tick(now) {
		if (!state.running) return;
		// Clamp: a backgrounded tab returning shouldn't jump the animation.
		var delta = Math.min((now - last) / 1000, 0.05);
		last = now;

		state.time += delta;
		state.intro = Math.min(state.intro + delta / CONFIG.introDuration, 1);

		state.pointer.x += (state.pointerTarget.x - state.pointer.x) * Math.min(delta * 3, 1);
		state.pointer.y += (state.pointerTarget.y - state.pointer.y) * Math.min(delta * 3, 1);

		if (touch.update()) {
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, touchTexture);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, touch.canvas);
		}

		draw();
		raf = requestAnimationFrame(tick);
	}

	function draw() {
		if (state.lost) return;

		var p = easeOutCubic(state.intro);
		var random =
			CONFIG.scattered.random + (CONFIG.settled.random - CONFIG.scattered.random) * p;
		var depth = CONFIG.scattered.depth + (CONFIG.settled.depth - CONFIG.scattered.depth) * p;
		var size = CONFIG.settled.size * easeOutCubic(Math.min(state.intro * 1.4, 1));

		// Idle drift plus a little cursor parallax: enough to feel alive, not
		// enough to fight the copy for attention.
		state.theta = Math.sin(state.time * 0.12) * 0.09 + state.pointer.x * 0.05;
		state.tx = state.baseTx + state.pointer.x * state.fovWidth * 0.012;
		state.ty = state.baseTy + state.pointer.y * state.fovHeight * 0.012;
		state.tz = Math.sin(state.time * 0.17) * 6;

		modelView(modelview, state.tx, state.ty, state.tz, state.theta, state.scale, CONFIG.camZ);

		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.useProgram(program);
		gl.bindVertexArray(vao);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, srcTexture);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, touchTexture);

		gl.uniformMatrix4fv(U.uProjection, false, projection);
		gl.uniformMatrix4fv(U.uModelView, false, modelview);
		gl.uniform1f(U.uTime, state.time);
		gl.uniform1f(U.uRandom, random);
		gl.uniform1f(U.uDepth, depth);
		gl.uniform1f(U.uSize, size);
		gl.uniform1f(U.uScale, state.scale);
		// Per-frame so it can be dialled live: window.mhHero.config.recolour = 0.5
		gl.uniform1f(U.uRecolour, CONFIG.recolour);

		gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, state.count);
		gl.bindVertexArray(null);
	}
})();
