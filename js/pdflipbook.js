/*!
 * pdflipbook.js — turn any PDF into an interactive page-flip book.
 * Zero dependencies to install: pdf.js is auto-loaded from CDN if not present.
 *
 * Usage (auto-init):
 *   <div data-pdflipbook="brochure.pdf" style="height:600px"></div>
 *   <script src="pdflipbook.js"></script>
 *
 * Usage (manual):
 *   const book = PDFlipbook.create(document.querySelector('#book'), { url: 'brochure.pdf' });
 *   book.next(); book.prev(); book.goTo(5);
 *   book.zoomIn(); book.zoomOut(); book.setZoom(2);
 *   book.setDisplayMode('single'|'double'|'auto');
 *   book.toggleFullscreen(); book.destroy();
 *
 * Theming via CSS variables on the container:
 *   --fb-bg, --fb-paper, --fb-control-bg, --fb-control-fg, --fb-counter-fg
 */
(function (global) {
  'use strict';

  // pdf.js 4.x (ES module build). Versions < 4.2.67 are vulnerable to
  // CVE-2024-4367 (arbitrary JS execution from a crafted PDF), so do NOT
  // downgrade. For the strongest supply-chain posture, self-host these files
  // (or pre-assign window.pdfjsLib) and pass opts.pdfjsSrc / opts.pdfWorkerSrc.
  var PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

  /* ------------------------------------------------------------------ */
  /* Styles (injected once)                                              */
  /* ------------------------------------------------------------------ */

  var CSS = [
    '.fb-root{position:relative;width:100%;height:100%;min-height:240px;display:flex;',
    '  align-items:center;justify-content:center;overflow:hidden;outline:none;',
    '  background:var(--fb-bg,transparent);-webkit-user-select:none;user-select:none;',
    '  touch-action:pan-y;font-family:inherit}',
    '.fb-root *,.fb-root *::before,.fb-root *::after{box-sizing:border-box}',

    /* fallback fullscreen for browsers without the Fullscreen API (iPhone) */
    '.fb-fake-fs{position:fixed!important;inset:0!important;width:auto!important;',
    '  height:auto!important;min-height:0!important;z-index:2147483000;',
    '  background:var(--fb-bg,#101014)}',
    '.fb-noscroll{overflow:hidden!important}',

    '.fb-stage{position:relative;perspective:2600px;transition:transform .55s cubic-bezier(.4,.1,.2,1)}',
    '.fb-stage.fb-live{transition:none}',
    '.fb-book{position:relative;transform-style:preserve-3d}',

    /* drop shadow under the visible book footprint */
    '.fb-bookshadow{position:absolute;top:0;height:100%;z-index:0;pointer-events:none;',
    '  border-radius:2px;opacity:0;',
    '  box-shadow:var(--fb-shadow,0 26px 64px rgba(0,0,0,.5),0 10px 22px rgba(0,0,0,.35));',
    '  transition:left .55s cubic-bezier(.4,.1,.2,1),width .55s cubic-bezier(.4,.1,.2,1),opacity .35s}',

    '.fb-sheet{position:absolute;top:0;left:50%;width:50%;height:100%;',
    '  transform-origin:left center;transform-style:preserve-3d;will-change:transform}',

    '.fb-face{position:absolute;inset:0;overflow:hidden;',
    '  -webkit-backface-visibility:hidden;backface-visibility:hidden;',
    '  background:var(--fb-paper,#fff)}',
    '.fb-face-back{transform:rotateY(180deg)}',
    '.fb-face canvas{position:absolute;inset:0;width:100%;height:100%;display:block}',

    /* permanent subtle gutter shading so the spread reads as a book */
    '.fb-face-front::before{content:"";position:absolute;inset:0;pointer-events:none;',
    '  background:linear-gradient(to right,rgba(0,0,0,.14),rgba(0,0,0,0) 7%)}',
    '.fb-face-back::before{content:"";position:absolute;inset:0;pointer-events:none;',
    '  background:linear-gradient(to left,rgba(0,0,0,.14),rgba(0,0,0,0) 7%)}',

    /* dynamic shade while a page is mid-flip (straight 3D flip) */
    '.fb-shade{position:absolute;inset:0;pointer-events:none;opacity:0}',
    '.fb-face-front .fb-shade{background:linear-gradient(to left,rgba(0,0,0,.28),rgba(0,0,0,.02) 60%)}',
    '.fb-face-back  .fb-shade{background:linear-gradient(to right,rgba(0,0,0,.28),rgba(0,0,0,.02) 60%)}',

    /* shadow the moving sheet casts on the page beneath it (straight flip) */
    '.fb-cast{position:absolute;top:0;height:100%;width:50%;pointer-events:none;opacity:0;left:50%}',
    '.fb-cast-fwd{background:linear-gradient(to right,rgba(0,0,0,.22),rgba(0,0,0,0) 70%)}',
    '.fb-cast-back{left:0;background:linear-gradient(to left,rgba(0,0,0,.22),rgba(0,0,0,0) 70%)}',

    /* corner-fold rig: a shadow on the revealed under-page, and the folded-',
    /* over piece of paper (back content reflected across the crease) */
    '.fb-fold-shadow{position:absolute;inset:0;pointer-events:none;display:none}',
    '.fb-fold-wrap{position:absolute;inset:0;pointer-events:none;display:none;',
    '  filter:var(--fb-fold-shadow,drop-shadow(0 10px 12px rgba(0,0,0,.3)))}',
    /* clip-path is applied AFTER filter on the same element, which would',
    /* cut the shadow off — so the clip lives on an inner element */
    '.fb-fold-clip{position:absolute;inset:0}',
    '.fb-fold-mover{position:absolute;left:0;top:0;transform-origin:0 0;',
    '  background:var(--fb-paper,#fff);overflow:hidden}',
    '.fb-fold-mover canvas{position:absolute;inset:0;width:100%;height:100%;display:block}',
    /* oversized: the folded paper can hang outside the book box, and its',
    /* crease shading must follow it rather than stopping at the book edge */
    '.fb-fold-shade{position:absolute;left:-100%;top:-100%;width:300%;height:300%;',
    '  pointer-events:none}',

    /* single-page mode: one standalone page; spread machinery hidden */
    '.fb-spane{position:absolute;inset:0;display:none}',
    '.fb-single-mode .fb-spane{display:block}',
    '.fb-single-mode .fb-sheet{visibility:hidden}',
    '.fb-single-mode .fb-cast{display:none}',

    /* edge hot-zones for grab/tap */
    '.fb-hot{position:absolute;top:0;height:100%;cursor:grab;z-index:60}',
    '.fb-hot:active{cursor:grabbing}',
    '.fb-hot[hidden]{display:none}',

    /* nav arrows */
    '.fb-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:70;',
    '  width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;',
    '  display:flex;align-items:center;justify-content:center;padding:0;',
    '  background:var(--fb-control-bg,rgba(20,20,24,.72));color:var(--fb-control-fg,#fff);',
    '  box-shadow:0 2px 10px rgba(0,0,0,.25);',
    '  transition:opacity .25s,transform .15s,background .15s}',
    '.fb-nav:hover{transform:translateY(-50%) scale(1.08)}',
    '.fb-nav:focus-visible{outline:2px solid var(--fb-control-fg,#fff);outline-offset:2px}',
    '.fb-nav[disabled]{opacity:0;pointer-events:none}',
    '.fb-nav svg{width:20px;height:20px;display:block}',
    '.fb-nav-prev{left:10px}.fb-nav-next{right:10px}',

    /* tool buttons (fullscreen, mode toggle, zoom) */
    '.fb-tools{position:absolute;display:flex;gap:8px;z-index:70}',
    '.fb-tools-tr{top:10px;right:10px}',
    '.fb-tools-br{bottom:10px;right:10px;flex-direction:column}',
    '.fb-tool{width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;',
    '  display:flex;align-items:center;justify-content:center;padding:0;',
    '  background:var(--fb-control-bg,rgba(20,20,24,.72));color:var(--fb-control-fg,#fff);',
    '  box-shadow:0 2px 8px rgba(0,0,0,.22);transition:opacity .2s,transform .15s}',
    '.fb-tool:hover{transform:scale(1.08)}',
    '.fb-tool:focus-visible{outline:2px solid var(--fb-control-fg,#fff);outline-offset:2px}',
    '.fb-tool[disabled]{opacity:.35;cursor:default;transform:none}',
    '.fb-tool svg{width:18px;height:18px;display:block}',

    /* page counter */
    '.fb-counter{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);z-index:70;',
    '  font-size:12px;letter-spacing:.06em;font-variant-numeric:tabular-nums;',
    '  color:var(--fb-counter-fg,rgba(255,255,255,.85));',
    '  background:var(--fb-control-bg,rgba(20,20,24,.55));padding:4px 12px;border-radius:999px;',
    '  pointer-events:none}',

    /* loading / error */
    '.fb-status{position:absolute;inset:0;display:flex;flex-direction:column;gap:14px;',
    '  align-items:center;justify-content:center;z-index:80;',
    '  color:var(--fb-counter-fg,rgba(255,255,255,.85));font-size:13px;letter-spacing:.04em}',
    '.fb-spinner{width:34px;height:34px;border-radius:50%;',
    '  border:3px solid rgba(128,128,128,.25);border-top-color:var(--fb-control-fg,#fff);',
    '  animation:fb-spin .8s linear infinite}',
    '@keyframes fb-spin{to{transform:rotate(360deg)}}',

    '@media (prefers-reduced-motion:reduce){',
    '  .fb-stage{transition:none}',
    '}',
    '@media (max-width:600px){',
    '  .fb-nav{width:36px;height:36px}',
    '  .fb-nav svg{width:17px;height:17px}',
    '  .fb-nav-prev{left:4px}.fb-nav-next{right:4px}',
    '  .fb-tool{width:32px;height:32px}',
    '  .fb-tool svg{width:16px;height:16px}',
    '  .fb-tools-tr{top:6px;right:6px}.fb-tools-br{bottom:6px;right:6px}',
    '}'
  ].join('\n');

  var styleInjected = false;
  function injectStyles() {
    if (styleInjected) return;
    var s = document.createElement('style');
    s.setAttribute('data-pdflipbook-css', '');
    s.textContent = CSS;
    document.head.appendChild(s);
    styleInjected = true;
  }

  /* ------------------------------------------------------------------ */
  /* pdf.js loader                                                       */
  /* ------------------------------------------------------------------ */

  var pdfjsPromise = null;
  function loadPdfJs(srcUrl, workerUrl) {
    srcUrl = srcUrl || PDFJS_SRC;
    workerUrl = workerUrl || PDFJS_WORKER;
    // a consumer may have pre-loaded pdf.js (e.g. self-hosted with SRI)
    if (global.pdfjsLib && typeof global.pdfjsLib.getDocument === 'function') {
      if (!global.pdfjsLib.GlobalWorkerOptions.workerSrc) {
        global.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      return Promise.resolve(global.pdfjsLib);
    }
    if (pdfjsPromise) return pdfjsPromise;
    // pdf.js 4.x ships as an ES module; load it via dynamic import
    pdfjsPromise = Promise.resolve().then(function () {
      return import(/* webpackIgnore: true */ /* @vite-ignore */ srcUrl);
    }).then(function (lib) {
      // unwrap a possible default-namespace and validate it really is pdf.js,
      // so a tampered/empty CDN response surfaces as an error instead of
      // hanging forever on the loading spinner
      if (lib && lib.default && typeof lib.default.getDocument === 'function') lib = lib.default;
      if (!lib || typeof lib.getDocument !== 'function') {
        throw new Error('pdf.js loaded but did not expose getDocument');
      }
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      global.pdfjsLib = lib;
      return lib;
    }).catch(function (err) {
      pdfjsPromise = null;   // let a later instance retry the load
      throw new Error('Could not load pdf.js — ' +
        (err && err.message ? err.message : String(err)));
    });
    return pdfjsPromise;
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  var ICONS = {
    left: '<path d="M15 5 L8 12 L15 19"/>',
    right: '<path d="M9 5 L16 12 L9 19"/>',
    expand: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
    compress: '<path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/>',
    zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4M11 8.5v5M8.5 11h5"/>',
    zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4M8.5 11h5"/>',
    single: '<rect x="7.5" y="4" width="9" height="16" rx="1.2"/>',
    double: '<rect x="3.5" y="4" width="8" height="16" rx="1.2"/><rect x="12.5" y="4" width="8" height="16" rx="1.2"/>'
  };
  function svgIcon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  // pull a point inside a circle (the paper can't stretch)
  function clampCircle(p, cx, cy, r) {
    var dx = p[0] - cx, dy = p[1] - cy;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d <= r || d === 0) return p;
    var s = r / d;
    return [cx + dx * s, cy + dy * s];
  }

  // clip the rect [0,W]x[0,H] to the half-plane sign((q-M)·d) >= 0
  function clipRectHalf(W, H, dx, dy, mx, my, keepPositive) {
    var pts = [[0, 0], [W, 0], [W, H], [0, H]];
    var out = [];
    function side(q) {
      var v = (q[0] - mx) * dx + (q[1] - my) * dy;
      return keepPositive ? v : -v;
    }
    for (var i = 0; i < 4; i++) {
      var a = pts[i], b = pts[(i + 1) % 4];
      var fa = side(a), fb = side(b);
      if (fa >= 0) out.push(a);
      if ((fa > 0 && fb < 0) || (fa < 0 && fb > 0)) {
        var t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  }

  function polyStr(pts) {
    if (!pts.length) return 'polygon(0px 0px,0px 0px,0px 0px)';
    var s = [];
    for (var i = 0; i < pts.length; i++) {
      s.push(pts[i][0].toFixed(2) + 'px ' + pts[i][1].toFixed(2) + 'px');
    }
    return 'polygon(' + s.join(',') + ')';
  }

  // a linear gradient that peaks exactly on the crease line (through point
  // M, in direction g) and fades out over fadePx, inside a boxW x boxH box
  function creaseGrad(gx, gy, Mx, My, boxW, boxH, fadePx, alpha) {
    var L = Math.abs(boxW * gx) + Math.abs(boxH * gy);
    if (L < 1) return 'none';
    var deg = Math.atan2(gx, -gy) * 180 / Math.PI;
    var s = ((Mx - boxW / 2) * gx + (My - boxH / 2) * gy) + L / 2;
    var f = (s / L) * 100;
    var fade = (fadePx / L) * 100;
    return 'linear-gradient(' + deg.toFixed(2) + 'deg,' +
      'rgba(0,0,0,0) ' + (f - 0.6).toFixed(2) + '%,' +
      'rgba(0,0,0,' + alpha + ') ' + f.toFixed(2) + '%,' +
      'rgba(0,0,0,0) ' + (f + fade).toFixed(2) + '%)';
  }

  var prefersReduced = global.matchMedia &&
    global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------ */
  /* PDFlipbook                                                            */
  /* ------------------------------------------------------------------ */

  function PDFlipbook(container, opts) {
    this.container = container;
    this.opts = Object.assign({
      url: null,            // PDF url
      data: null,           // or raw bytes (ArrayBuffer / Uint8Array)
      startPage: 1,
      duration: prefersReduced ? 0 : 520,   // ms for a full flip
      edgeSize: 0.14,       // hot-zone width as a fraction of the book width
      cornerFold: true,     // corner drags fold the paper along a crease
      shadow: 'fullscreen', // 'none' | 'normal' | 'fullscreen' | 'always' (true/false ok)
      displayMode: 'auto',  // 'auto' | 'double' | 'single'
      zoomSteps: [1, 1.5, 2, 3],
      pageNumbers: true,
      arrows: true,
      controls: true,       // fullscreen / mode / zoom buttons
      maxScale: 2,          // cap on devicePixelRatio for rendering
      padding: 16,          // breathing room inside the container (px)
      fullscreenPadding: null, // px in fullscreen (null = ~7% of screen)
      pdfjsSrc: null,       // override the pdf.js module URL (self-hosting)
      pdfWorkerSrc: null    // override the pdf.js worker URL
    }, opts || {});
    if (this.opts.shadow === true) this.opts.shadow = 'always';
    if (this.opts.shadow === false) this.opts.shadow = 'none';
    // a non-numeric startPage (e.g. a bad data-start-page attribute) would
    // poison every page/sheet computation with NaN — coerce it to a sane int
    var sp = parseInt(this.opts.startPage, 10);
    this.opts.startPage = (isFinite(sp) && sp > 0) ? sp : 1;

    this.pdf = null;
    this.numPages = 0;
    this.numSheets = 0;
    this.current = 0;        // sheets flipped so far (0..numSheets)
    this.sheets = [];
    this.pageW = 0;
    this.pageH = 0;
    this.aspect = 0.707;     // h/w fallback (A-series portrait)
    this.anim = null;
    this.drag = null;
    this.fold = null;
    this.rig = null;
    this.destroyed = false;

    // view state
    this.mode = 'double';
    this.modeOverride = this.opts.displayMode === 'auto' ? null : this.opts.displayMode;
    this.viewPage = clamp(this.opts.startPage, 1, 9999); // single-mode page
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.fsFake = false;
    this.pointers = {};      // active pointers on the root (pan / pinch)
    this.pinch = null;
    this.pan = null;

    this._build();
    this._load();
  }

  /* ---------- DOM ---------- */

  PDFlipbook.prototype._build = function () {
    injectStyles();
    var c = this.container;
    c.classList.add('fb-root');
    c.setAttribute('tabindex', '0');
    c.setAttribute('role', 'region');
    c.setAttribute('aria-label', 'PDF flipbook');

    this.stage = document.createElement('div');
    this.stage.className = 'fb-stage';
    this.book = document.createElement('div');
    this.book.className = 'fb-book';
    this.stage.appendChild(this.book);
    c.appendChild(this.stage);

    this.shadowEl = document.createElement('div');
    this.shadowEl.className = 'fb-bookshadow';
    this.book.appendChild(this.shadowEl);

    this.castFwd = document.createElement('div');
    this.castFwd.className = 'fb-cast fb-cast-fwd';
    this.castBack = document.createElement('div');
    this.castBack.className = 'fb-cast fb-cast-back';
    this.book.appendChild(this.castFwd);
    this.book.appendChild(this.castBack);

    this.hotL = document.createElement('div');
    this.hotL.className = 'fb-hot fb-hot-left';
    this.hotR = document.createElement('div');
    this.hotR.className = 'fb-hot fb-hot-right';
    this.book.appendChild(this.hotL);
    this.book.appendChild(this.hotR);

    if (this.opts.arrows) {
      this.btnPrev = this._mkBtn('fb-nav fb-nav-prev', 'Previous page', 'left');
      this.btnNext = this._mkBtn('fb-nav fb-nav-next', 'Next page', 'right');
      c.appendChild(this.btnPrev);
      c.appendChild(this.btnNext);
    }

    if (this.opts.controls) {
      var tr = document.createElement('div');
      tr.className = 'fb-tools fb-tools-tr';
      this.btnMode = this._mkBtn('fb-tool', 'Single page view', 'single');
      this.btnFs = this._mkBtn('fb-tool', 'Fullscreen', 'expand');
      tr.appendChild(this.btnMode);
      tr.appendChild(this.btnFs);
      c.appendChild(tr);

      var br = document.createElement('div');
      br.className = 'fb-tools fb-tools-br';
      this.btnZoomIn = this._mkBtn('fb-tool', 'Zoom in', 'zoomIn');
      this.btnZoomOut = this._mkBtn('fb-tool', 'Zoom out', 'zoomOut');
      br.appendChild(this.btnZoomIn);
      br.appendChild(this.btnZoomOut);
      c.appendChild(br);
    }

    if (this.opts.pageNumbers) {
      this.counter = document.createElement('div');
      this.counter.className = 'fb-counter';
      this.counter.setAttribute('aria-live', 'polite');
      c.appendChild(this.counter);
    }

    this.status = document.createElement('div');
    this.status.className = 'fb-status';
    this.status.innerHTML = '<div class="fb-spinner"></div><div class="fb-status-text">Loading…</div>';
    c.appendChild(this.status);

    this._bind();
  };

  PDFlipbook.prototype._mkBtn = function (cls, label, icon) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = svgIcon(icon);
    return b;
  };

  PDFlipbook.prototype._statusText = function (t) {
    var el = this.status.querySelector('.fb-status-text');
    if (el) el.textContent = t;
  };

  /* ---------- Loading ---------- */

  PDFlipbook.prototype._load = function () {
    var self = this;
    if (!this.opts.data && !this.opts.url) {
      this._statusText('Could not load PDF — no url or data provided');
      this._emit('error', { error: new Error('no url or data provided') });
      return;
    }
    loadPdfJs(this.opts.pdfjsSrc, this.opts.pdfWorkerSrc).then(function (pdfjsLib) {
      if (self.destroyed) return;
      // isEvalSupported:false is defense-in-depth against font-handling
      // exploits in untrusted PDFs (see CVE-2024-4367)
      var src = { isEvalSupported: false };
      if (self.opts.data) src.data = self.opts.data; else src.url = self.opts.url;
      var task = pdfjsLib.getDocument(src);
      task.onProgress = function (p) {
        if (p.total) {
          self._statusText('Loading… ' + Math.round((p.loaded / p.total) * 100) + '%');
        }
      };
      return task.promise;
    }).then(function (pdf) {
      if (self.destroyed) return;
      self.pdf = pdf;
      self.numPages = pdf.numPages;
      self.numSheets = Math.ceil(pdf.numPages / 2);
      return pdf.getPage(1);
    }).then(function (page) {
      if (self.destroyed || !page) return;
      var vp = page.getViewport({ scale: 1 });
      self.aspect = vp.height / vp.width;
      self._buildSheets();
      self.status.remove();
      self.viewPage = clamp(self.opts.startPage, 1, self.numPages);
      self.current = self._sheetForPage(self.viewPage);
      self._layout();
      self._applyResting();
      self._updateChrome();
      self._renderWindow();
      self._observeResize();
      self._emit('ready', { pages: self.numPages });
    }).catch(function (err) {
      if (self.destroyed) return;
      self.status.innerHTML = '<div class="fb-status-text"></div>';
      self._statusText('Could not load PDF — ' + (err && err.message ? err.message : 'unknown error'));
      self._emit('error', { error: err });
    });
  };

  PDFlipbook.prototype._buildSheets = function () {
    for (var k = 0; k < this.numSheets; k++) {
      var sheet = document.createElement('div');
      sheet.className = 'fb-sheet';

      var front = document.createElement('div');
      front.className = 'fb-face fb-face-front';
      var fc = document.createElement('canvas');
      front.appendChild(fc);
      var fs = document.createElement('div');
      fs.className = 'fb-shade';
      front.appendChild(fs);

      var back = document.createElement('div');
      back.className = 'fb-face fb-face-back';
      var bc = document.createElement('canvas');
      back.appendChild(bc);
      var bs = document.createElement('div');
      bs.className = 'fb-shade';
      back.appendChild(bs);

      sheet.appendChild(front);
      sheet.appendChild(back);
      // keep hot-zones & casts above sheets in DOM order; insert sheets before them
      this.book.insertBefore(sheet, this.castFwd);

      this.sheets.push({
        el: sheet,
        frontFace: front,
        backFace: back,
        frontPage: 2 * k + 1,
        backPage: 2 * k + 2 <= this.numPages ? 2 * k + 2 : null,
        frontCanvas: fc,
        backCanvas: bc,
        frontShade: fs,
        backShade: bs,
        angle: 0
      });
    }
  };

  /* ---------- View geometry: mode, layout, camera ---------- */

  PDFlipbook.prototype._bookW = function () {
    return this.mode === 'single' ? this.pageW : this.pageW * 2;
  };
  PDFlipbook.prototype._spineX = function () {
    // single mode: a lone page whose binding is its left edge
    return this.mode === 'single' ? 0 : this.pageW;
  };

  // sheets flipped when `page` is in view: a right (odd) page sits on the
  // unflipped stack, a left (even) page means its sheet is already flipped
  PDFlipbook.prototype._sheetForPage = function (page) {
    return page % 2 === 1 ? (page - 1) / 2 : page / 2;
  };

  PDFlipbook.prototype._autoMode = function () {
    var pad = this.opts.padding;
    var cw = Math.max(this.container.clientWidth - pad * 2, 50);
    var ch = Math.max(this.container.clientHeight - pad * 2, 50);
    var doubleW = Math.min(cw / 2, ch / this.aspect);
    var singleW = Math.min(cw, ch / this.aspect);
    // go single when one page can be drawn much larger than half a spread
    // (i.e. the container is portrait-ish relative to the spread)
    return singleW > doubleW * 1.45 ? 'single' : 'double';
  };

  PDFlipbook.prototype._layout = function () {
    var wanted = this.modeOverride || this._autoMode();
    if (wanted !== this.mode) {
      this.mode = wanted;
      if (this.mode === 'single') {
        // keep showing the first page of the open spread
        this.viewPage = clamp(this._firstVisiblePage(), 1, this.numPages);
      }
      this._emit('modechange', { mode: this.mode });
    }

    var pad = this.opts.padding;
    if (this._isFullscreen()) {
      // let the book float in space rather than touching the screen edges
      var fp = this.opts.fullscreenPadding;
      pad = Math.max(pad, fp != null ? fp :
        Math.round(Math.min(this.container.clientWidth, this.container.clientHeight) * 0.07));
    }
    var cw = Math.max(this.container.clientWidth - pad * 2, 50);
    var ch = Math.max(this.container.clientHeight - pad * 2, 50);

    var pageW = this.mode === 'single'
      ? Math.min(cw, ch / this.aspect)            // fit ONE page
      : Math.min(cw / 2, ch / this.aspect);       // fit the spread

    this.pageW = Math.floor(pageW);
    this.pageH = Math.floor(pageW * this.aspect);

    this.book.style.width = this._bookW() + 'px';
    this.book.style.height = this.pageH + 'px';
    this.book.classList.toggle('fb-single-mode', this.mode === 'single');
    if (this.mode === 'single') {
      this._buildSingle();
      this._renderSingle();
    }

    this._placeHotZones();
    this._applyStage();
    this._updateChrome();
  };

  PDFlipbook.prototype._buildSingle = function () {
    if (this.spane) return;
    var pane = document.createElement('div');
    pane.className = 'fb-spane';
    var under = document.createElement('div');
    under.className = 'fb-face';
    this.underC = document.createElement('canvas');
    under.appendChild(this.underC);
    var base = document.createElement('div');
    base.className = 'fb-face';
    this.baseC = document.createElement('canvas');
    base.appendChild(this.baseC);
    under.style.zIndex = 1;
    base.style.zIndex = 2;
    pane.appendChild(under);
    pane.appendChild(base);
    this.baseFaceEl = base;
    this.spane = pane;
    // offscreen prefetch canvases for the neighbouring pages
    this.nextC = document.createElement('canvas');
    this.prevC = document.createElement('canvas');
    this.book.insertBefore(pane, this.castFwd);
  };

  PDFlipbook.prototype._renderSingle = function () {
    if (!this.spane || this.mode !== 'single') return;
    var vp = this.viewPage;
    this._renderPage(vp, this.baseC);
    if (vp < this.numPages) this._renderPage(vp + 1, this.nextC);
    if (vp > 1) this._renderPage(vp - 1, this.prevC);
  };

  PDFlipbook.prototype._placeHotZones = function () {
    var hot = Math.round(this.pageW * 2 * this.opts.edgeSize);
    this.hotL.style.width = hot + 'px';
    this.hotR.style.width = hot + 'px';
    this.hotL.style.left = '0';
    this.hotR.style.left = '';
    this.hotR.style.right = '0';
  };

  // where the stage should sit to centre the current view (camera x, px)
  PDFlipbook.prototype._shiftFor = function () {
    if (this.mode === 'single') return 0;
    if (this.current === 0) return -this.pageW / 2;
    if (this.current === this.numSheets) return this.pageW / 2;
    return 0;
  };

  // compose the full stage transform: camera shift + user pan + zoom
  PDFlipbook.prototype._applyStage = function (shiftOverride) {
    var shift = (shiftOverride !== undefined) ? shiftOverride : this._shiftFor();
    this._clampPan();
    this.stage.style.transform =
      'translate(' + (shift * this.zoom + this.panX).toFixed(2) + 'px,' + this.panY.toFixed(2) + 'px)' +
      ' scale(' + this.zoom + ')';
  };

  PDFlipbook.prototype._clampPan = function () {
    var visW = this._bookW() * this.zoom;
    var visH = this.pageH * this.zoom;
    var maxX = Math.max(0, (visW - this.container.clientWidth) / 2 + 24);
    var maxY = Math.max(0, (visH - this.container.clientHeight) / 2 + 24);
    this.panX = clamp(this.panX, -maxX, maxX);
    this.panY = clamp(this.panY, -maxY, maxY);
  };

  PDFlipbook.prototype._firstVisiblePage = function () {
    if (this.current === 0) return 1;
    return Math.min(this.current * 2, this.numPages);
  };

  PDFlipbook.prototype._observeResize = function () {
    var self = this;
    this.ro = new ResizeObserver(function () {
      if (self.destroyed) return;
      self._layout();
      clearTimeout(self._roT);
      self._roT = setTimeout(function () {
        if (self.destroyed) return;   // guard: destroy() may land in the gap
        self._renderWindow();
      }, 180);
    });
    this.ro.observe(this.container);
  };

  /* ---------- Rendering ---------- */

  PDFlipbook.prototype._renderWindow = function (force) {
    if (this.mode === 'single') { this._renderSingle(); return; }
    var lo = Math.max(0, this.current - 2);
    var hi = Math.min(this.numSheets - 1, this.current + 1);
    for (var k = 0; k < this.numSheets; k++) {
      var s = this.sheets[k];
      if (k >= lo && k <= hi) {
        this._renderPage(s.frontPage, s.frontCanvas, force);
        if (s.backPage) this._renderPage(s.backPage, s.backCanvas, force);
      } else {
        this._freeCanvas(s.frontCanvas);
        this._freeCanvas(s.backCanvas);
      }
    }
  };

  PDFlipbook.prototype._freeCanvas = function (canvas) {
    // bump the token so any pending render for this canvas is discarded
    canvas.__req = (canvas.__req || 0) + 1;
    if (canvas.__task) { canvas.__task.cancel(); canvas.__task = null; }
    if (!canvas.width) return;
    canvas.width = canvas.height = 0;
    canvas.__renderW = canvas.__page = null;
  };

  PDFlipbook.prototype._renderPage = function (pageNum, canvas, force) {
    if (!this.pdf || !pageNum) return;
    var dpr = Math.min(global.devicePixelRatio || 1, this.opts.maxScale);
    // render sharper while zoomed in (bounded so memory stays sane)
    var eff = Math.min(dpr * clamp(this.zoom, 1, 2.5), 4);
    var targetW = Math.round(this.pageW * eff);
    if (!force && canvas.__renderW === targetW && canvas.__page === pageNum) return;
    if (canvas.__task) { canvas.__task.cancel(); canvas.__task = null; }
    // stamp a request token synchronously: getPage() is async, so without
    // this two overlapping renders for the same canvas could both proceed
    // and clobber each other's pixels and bookkeeping
    var reqId = (canvas.__req = (canvas.__req || 0) + 1);

    var self = this;
    this.pdf.getPage(pageNum).then(function (page) {
      if (self.destroyed || canvas.__req !== reqId) return;
      var vp1 = page.getViewport({ scale: 1 });
      // fit page into the book page box, centred (handles mixed page sizes)
      var scale = Math.min(targetW / vp1.width, (self.pageH * eff) / vp1.height);
      var vp = page.getViewport({ scale: scale });

      canvas.width = targetW;
      canvas.height = Math.round(self.pageH * eff);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      var ox = (canvas.width - vp.width) / 2;
      var oy = (canvas.height - vp.height) / 2;
      ctx.translate(ox, oy);

      var task = page.render({ canvasContext: ctx, viewport: vp });
      canvas.__task = task;
      task.promise.then(function () {
        if (canvas.__req !== reqId) return;
        canvas.__task = null;
        canvas.__renderW = targetW;
        canvas.__page = pageNum;
      }).catch(function () { /* cancelled */ });
    }).catch(function () { /* getPage failed (e.g. corrupt page) — leave blank */ });
  };

  /* ---------- Stacking & resting transforms ---------- */

  PDFlipbook.prototype._applyResting = function () {
    for (var k = 0; k < this.numSheets; k++) {
      var s = this.sheets[k];
      s.angle = k < this.current ? -180 : 0;
      this._setSheet(k, s.angle, false);
    }
  };

  PDFlipbook.prototype._setSheet = function (k, angle, lifting) {
    var s = this.sheets[k];
    s.angle = angle;
    s.el.style.transform = 'rotateY(' + angle + 'deg)';

    var z;
    if (lifting) z = this.numSheets + 5;
    else if (angle <= -90) z = k + 1;                  // settled on the left stack
    else z = this.numSheets - k;                       // settled on the right stack
    s.el.style.zIndex = z;

    // mid-flip shading on the moving sheet
    var p = clamp(-angle / 180, 0, 1);
    var glow = Math.sin(p * Math.PI);                  // 0 at rest, 1 at 90°
    s.frontShade.style.opacity = (glow * 0.9).toFixed(3);
    s.backShade.style.opacity = (glow * 0.9).toFixed(3);
  };

  PDFlipbook.prototype._setCast = function (dir, strength) {
    this.castFwd.style.opacity = dir === 'fwd' ? strength.toFixed(3) : 0;
    this.castBack.style.opacity = dir === 'back' ? strength.toFixed(3) : 0;
    var zTop = this.numSheets + 4;
    this.castFwd.style.zIndex = zTop;
    this.castBack.style.zIndex = zTop;
  };

  /* ---------- Flipping (shared) ---------- */

  PDFlipbook.prototype._beginFlip = function (dir) {
    if (this.anim) this._finishAnim(true);
    var k = dir === 'fwd' ? this.current : this.current - 1;
    if (k < 0 || k >= this.numSheets) return null;
    var peek = dir === 'fwd' ? this.current + 1 : this.current - 2;
    if (peek >= 0 && peek < this.numSheets) {
      var s = this.sheets[peek];
      this._renderPage(s.frontPage, s.frontCanvas);
      if (s.backPage) this._renderPage(s.backPage, s.backCanvas);
    }
    return k;
  };

  PDFlipbook.prototype._lerpStage = function (p) {
    p = clamp(p, 0, 1);
    var s = this.shLerp;
    if (s) {
      // A side losing its last paper recedes to the spine with the page.
      // A side gaining its FIRST paper stays unshadowed for the whole turn —
      // the moving page carries its own silhouette shadow, and a flat
      // rectangle can't follow its angled edge — then the book shadow
      // extends out smoothly once the turn commits.
      var shrink = 1 - p;
      var l, r;
      if (s.dir === 'fwd') {               // sheet leaves the right side
        l = s.lu ? 1 : 0;
        r = s.ru ? 1 : shrink;
      } else {                             // sheet leaves the left side
        l = s.lu ? 1 : shrink;
        r = s.ru ? 1 : 0;
      }
      this._setShadowExtents(l, r);
    }
  };

  PDFlipbook.prototype._commit = function (dir, completed) {
    if (completed) this.current += dir === 'fwd' ? 1 : -1;
    if (completed) this.viewPage = this._firstVisiblePage();
    if (this.shLerp) {
      this.shLerp = null;
      this.shadowEl.style.transition = '';
    }
    this._placeHotZones();
    this._applyStage();
    this._updateChrome();
    this._renderWindow();
    this._setCast(dir, 0);
    if (completed) {
      this._emit('pagechange', { page: this.currentPage(), pages: this.numPages });
    }
  };

  PDFlipbook.prototype._animateTo = function (k, target, dir, onDone) {
    var self = this;
    var s = this.sheets[k];
    var from = s.angle;
    var span = Math.abs(target - from);
    var dur = Math.max(1, this.opts.duration * (span / 180));
    var t0 = performance.now();

    function frame(now) {
      if (self.destroyed) return;
      var t = clamp((now - t0) / dur, 0, 1);
      var e = easeOutCubic(t);
      var angle = from + (target - from) * e;
      self._setSheet(k, angle, t < 1);
      var p = clamp(-angle / 180, 0, 1);
      if (dir === 'back') self._lerpStage(1 - p); else self._lerpStage(p);
      self._setCast(dir, Math.sin(p * Math.PI) * 0.85);
      if (t < 1) {
        self.anim.raf = requestAnimationFrame(frame);
      } else {
        self._setSheet(k, target, false);
        self.anim = null;
        onDone();
      }
    }
    this.anim = { k: k, target: target, dir: dir, onDone: onDone, raf: requestAnimationFrame(frame) };
  };

  PDFlipbook.prototype._finishAnim = function (instant) {
    if (!this.anim) return;
    cancelAnimationFrame(this.anim.raf);
    var a = this.anim;
    this.anim = null;
    if (instant) {
      if (!a.fold && !a.slide && a.k !== undefined) this._setSheet(a.k, a.target, false);
      a.onDone();
    }
  };

  PDFlipbook.prototype.next = function () {
    if (this.anim || this.drag || this.pinch) return;
    if (this.mode === 'single') {
      if (this.viewPage >= this.numPages) return;
      return this._singleTurn('fwd');
    }
    if (this.current >= this.numSheets) return;
    this._pageTurn('fwd');
  };

  PDFlipbook.prototype.prev = function () {
    if (this.anim || this.drag || this.pinch) return;
    if (this.mode === 'single') {
      if (this.viewPage <= 1) return;
      return this._singleTurn('back');
    }
    if (this.current <= 0) return;
    this._pageTurn('back');
  };

  PDFlipbook.prototype._pageTurn = function (dir) {
    var k = this._beginFlip(dir);
    if (k === null) return;
    var self = this;
    this._beginShadowLerp(dir);
    this._animateTo(k, dir === 'fwd' ? -180 : 0, dir, function () { self._commit(dir, true); });
  };

  // single mode: an animated peel of the lone page (button / key / tap)
  PDFlipbook.prototype._singleTurn = function (dir) {
    if (this.anim) this._finishAnim(true);
    this._foldStart(dir, null, true);
    this._foldRender(this.pageW, this.pageH);
    this._foldAnimate(true);
  };

  PDFlipbook.prototype.goTo = function (page) {
    page = clamp(page, 1, this.numPages);
    var sheet = this._sheetForPage(page);
    if (this.mode === 'single') {
      this.current = sheet;
      this.viewPage = page;
      this._applyResting();
      this._renderSingle();
      this._updateChrome();
      this._emit('pagechange', { page: page, pages: this.numPages });
      return;
    }
    if (sheet === this.current) return;
    if (Math.abs(sheet - this.current) === 1) {
      return sheet > this.current ? this.next() : this.prev();
    }
    this.current = sheet;
    this._applyResting();
    this._applyStage();
    this._updateChrome();
    this._renderWindow();
    this._emit('pagechange', { page: this.currentPage(), pages: this.numPages });
  };

  PDFlipbook.prototype.currentPage = function () {
    if (this.mode === 'single') return this.viewPage;
    return this._firstVisiblePage();
  };

  /* ------------------------------------------------------------------ */
  /* Corner fold — true 2D peel geometry                                  */
  /* (page stays locked at the spine; the corner folds along a crease)    */
  /* ------------------------------------------------------------------ */

  PDFlipbook.prototype._foldRig = function () {
    if (this.rig) return this.rig;
    var shadow = document.createElement('div');
    shadow.className = 'fb-fold-shadow';
    var wrap = document.createElement('div');
    wrap.className = 'fb-fold-wrap';
    var clip = document.createElement('div');
    clip.className = 'fb-fold-clip';
    var mover = document.createElement('div');
    mover.className = 'fb-fold-mover';
    var canvas = document.createElement('canvas');
    mover.appendChild(canvas);
    var shade = document.createElement('div');
    shade.className = 'fb-fold-shade';
    clip.appendChild(mover);
    clip.appendChild(shade);
    wrap.appendChild(clip);
    this.book.appendChild(shadow);
    this.book.appendChild(wrap);
    this.rig = { shadow: shadow, wrap: wrap, clip: clip, mover: mover, canvas: canvas, shade: shade };
    return this.rig;
  };

  function copyCanvas(src, dst, W, H) {
    dst.width = src.width || Math.round(W);
    dst.height = src.height || Math.round(H);
    var ctx = dst.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, dst.width, dst.height);
    if (src.width) ctx.drawImage(src, 0, 0);
    dst.__renderW = src.__renderW;
    dst.__page = src.__page;
  }

  PDFlipbook.prototype._foldStart = function (dir, k, bottomCorner) {
    var rig = this._foldRig();
    var side = dir === 'fwd' ? 1 : -1;
    var W = this.pageW, H = this.pageH;
    var single = this.mode === 'single';
    var face = null;

    if (single) {
      if (dir === 'fwd') {
        // the lone page peels off over its left edge: its underside is a
        // faint mirrored ghost (thin paper), revealing the next page beneath
        copyCanvas(this.nextC, this.underC, W, H);
        rig.canvas.width = this.baseC.width || Math.round(W);
        rig.canvas.height = this.baseC.height || Math.round(H);
        var gx = rig.canvas.getContext('2d');
        gx.fillStyle = '#fff';
        gx.fillRect(0, 0, rig.canvas.width, rig.canvas.height);
        if (this.baseC.width) {
          gx.globalAlpha = 0.09;
          gx.drawImage(this.baseC, 0, 0);
          gx.globalAlpha = 1;
        }
        rig.canvas.style.transform = 'scaleX(-1)';
        face = this.baseFaceEl;
      } else {
        // the previous page sweeps back in from the left, landing on top
        copyCanvas(this.prevC, rig.canvas, W, H);
        rig.canvas.style.transform = '';
      }
    } else {
      var s = this.sheets[k];
      var srcCanvas = dir === 'fwd' ? s.backCanvas : s.frontCanvas;
      copyCanvas(srcCanvas, rig.canvas, W, H);
      rig.canvas.style.transform = side > 0 ? 'scaleX(-1)' : '';
      face = dir === 'fwd' ? s.frontFace : s.backFace;
    }

    rig.mover.style.width = W + 'px';
    rig.mover.style.height = H + 'px';
    var z = this.numSheets + 8;
    rig.shadow.style.zIndex = z;
    rig.wrap.style.zIndex = z + 1;
    rig.shadow.style.display = 'block';
    rig.wrap.style.display = 'block';

    this.fold = {
      dir: dir, side: side, k: k, single: single,
      spine: this._spineX(), bookW: this._bookW(),
      vc: bottomCorner ? H : 0,
      face: face,
      pu: W, pv: bottomCorner ? H : 0
    };
  };

  PDFlipbook.prototype._foldRender = function (pu, pv) {
    var f = this.fold;
    if (!f) return;
    var W = this.pageW, H = this.pageH;
    var vc = f.vc;

    var diag = Math.sqrt(W * W + H * H);
    var p = clampCircle([pu, pv], 0, vc, W);
    p = clampCircle(p, 0, H - vc, diag);
    p = clampCircle(p, 0, vc, W);
    f.pu = p[0]; f.pv = p[1];

    this._lerpStage(this._foldProgress());

    var dx = W - f.pu, dy = vc - f.pv;
    var len = Math.sqrt(dx * dx + dy * dy);
    var rig = this.rig;
    if (len < 0.75) {
      if (f.face) f.face.style.clipPath = '';
      rig.shadow.style.clipPath = rig.clip.style.clipPath = polyStr([]);
      return;
    }
    var ddx = dx / len, ddy = dy / len;
    var mx = (W + f.pu) / 2, my = (vc + f.pv) / 2;

    var src = clipRectHalf(W, H, ddx, ddy, mx, my, true);
    var vis = clipRectHalf(W, H, ddx, ddy, mx, my, false);

    var dst = [];
    for (var i = 0; i < src.length; i++) {
      var q = src[i];
      var t = 2 * ((q[0] - mx) * ddx + (q[1] - my) * ddy);
      dst.push([q[0] - t * ddx, q[1] - t * ddy]);
    }

    var side = f.side;
    var spine = f.spine;
    function toBook(q) { return [spine + side * q[0], q[1]]; }

    if (f.face) {
      var faceClip = [];
      for (i = 0; i < vis.length; i++) {
        faceClip.push(side > 0 ? vis[i] : [W - vis[i][0], vis[i][1]]);
      }
      f.face.style.clipPath = polyStr(faceClip);
    }

    var srcBook = [];
    for (i = 0; i < src.length; i++) srcBook.push(toBook(src[i]));
    rig.shadow.style.clipPath = polyStr(srcBook);

    var dstBook = [];
    for (i = 0; i < dst.length; i++) dstBook.push(toBook(dst[i]));
    rig.clip.style.clipPath = polyStr(dstBook);

    var A11 = 1 - 2 * ddx * ddx, A12 = -2 * ddx * ddy, A22 = 1 - 2 * ddy * ddy;
    var md = mx * ddx + my * ddy;
    var tx = 2 * md * ddx, ty = 2 * md * ddy;
    rig.mover.style.transform = 'matrix(' +
      (side * A11).toFixed(5) + ',' + A12.toFixed(5) + ',' +
      (side * A12).toFixed(5) + ',' + A22.toFixed(5) + ',' +
      (spine + side * tx).toFixed(2) + ',' + ty.toFixed(2) + ')';

    var Mb = toBook([mx, my]);
    var bw = f.bookW;
    var gbx = side * ddx, gby = ddy;
    var fade = clamp(len * 0.22, 10, Math.max(40, W * 0.3));
    // shade lives in an oversized box (one book-size margin on every edge)
    rig.shade.style.background =
      creaseGrad(-gbx, -gby, Mb[0] + bw, Mb[1] + H, 3 * bw, 3 * H, fade, 0.26);
    rig.shadow.style.background =
      creaseGrad(gbx, gby, Mb[0], Mb[1], bw, H, fade * 1.4, 0.22);
  };

  PDFlipbook.prototype._foldProgress = function () {
    return clamp((this.pageW - this.fold.pu) / (2 * this.pageW), 0, 1);
  };

  PDFlipbook.prototype._foldAnimate = function (completed) {
    var self = this;
    var f = this.fold;
    var W = this.pageW, H = this.pageH;
    var u0 = f.pu, v0 = f.pv;
    var u1 = completed ? -W : W;
    var v1 = f.vc;
    var dist = Math.abs(u1 - u0) + Math.abs(v1 - v0);
    var dur = Math.max(1, this.opts.duration * (dist / (2 * W)));
    var lift = (f.vc === 0 ? 1 : -1) * H * 0.05;
    var t0 = performance.now();

    function frame(now) {
      if (self.destroyed) return;
      var t = clamp((now - t0) / dur, 0, 1);
      var e = easeOutCubic(t);
      var u = u0 + (u1 - u0) * e;
      var v = v0 + (v1 - v0) * e + lift * Math.sin(e * Math.PI);
      self._foldRender(u, v);
      if (t < 1) {
        self.anim.raf = requestAnimationFrame(frame);
      } else {
        self.anim = null;
        self._foldEnd(completed);
      }
    }
    this.anim = {
      fold: true, k: f.k, dir: f.dir,
      onDone: function () { self._foldEnd(completed); },
      raf: requestAnimationFrame(frame)
    };
  };

  PDFlipbook.prototype._foldEnd = function (completed) {
    var f = this.fold;
    if (!f) return;
    this.fold = null;

    if (f.single && completed) {
      // swap the base page to the freshly-landed one BEFORE removing the
      // rig, so the handoff is pixel-seamless
      copyCanvas(f.dir === 'fwd' ? this.nextC : this.prevC,
                 this.baseC, this.pageW, this.pageH);
      this.viewPage = clamp(this.viewPage + (f.dir === 'fwd' ? 1 : -1), 1, this.numPages);
      this.current = this._sheetForPage(this.viewPage);
      this._applyResting();
    }

    if (f.face) f.face.style.clipPath = '';
    var rig = this.rig;
    rig.shadow.style.display = 'none';
    rig.wrap.style.display = 'none';
    rig.shadow.style.clipPath = rig.clip.style.clipPath = '';

    if (f.single) {
      this._renderSingle();
      this._updateChrome();
      this._setCast(f.dir, 0);
      if (completed) {
        this._emit('pagechange', { page: this.viewPage, pages: this.numPages });
      }
      return;
    }

    if (completed) this._setSheet(f.k, f.dir === 'fwd' ? -180 : 0, false);
    this._commit(f.dir, completed);
  };

  /* ---------- Pointer interaction: flip / fold / slide ---------- */

  PDFlipbook.prototype._bind = function () {
    var self = this;

    this._onDown = function (e) { self._pointerDown(e); };
    this._onMove = function (e) { self._pointerMove(e); };
    this._onUp = function (e) { self._pointerUp(e); };
    this.hotL.addEventListener('pointerdown', this._onDown);
    this.hotR.addEventListener('pointerdown', this._onDown);

    // root-level pointer tracking for pinch zoom & panning while zoomed
    this._onRootDown = function (e) { self._rootDown(e); };
    this._onRootMove = function (e) { self._rootMove(e); };
    this._onRootUp = function (e) { self._rootUp(e); };
    this.container.addEventListener('pointerdown', this._onRootDown, true);
    this.container.addEventListener('pointermove', this._onRootMove, true);
    this.container.addEventListener('pointerup', this._onRootUp, true);
    this.container.addEventListener('pointercancel', this._onRootUp, true);

    this._onKey = function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); self.next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); self.prev(); }
      else if (e.key === '+' || e.key === '=') { self.zoomIn(); }
      else if (e.key === '-') { self.zoomOut(); }
      else if (e.key === 'f' || e.key === 'F') { self.toggleFullscreen(); }
      else if (e.key === 'Escape' && self.fsFake) { self.toggleFullscreen(); }
    };
    this.container.addEventListener('keydown', this._onKey);

    this._onFsChange = function () { self._fsChanged(); };
    document.addEventListener('fullscreenchange', this._onFsChange);
    document.addEventListener('webkitfullscreenchange', this._onFsChange);

    if (this.btnNext) {
      this._onNext = function () { self.next(); };
      this._onPrev = function () { self.prev(); };
      this.btnNext.addEventListener('click', this._onNext);
      this.btnPrev.addEventListener('click', this._onPrev);
    }
    if (this.btnFs) {
      this.btnFs.addEventListener('click', function () { self.toggleFullscreen(); });
      this.btnMode.addEventListener('click', function () {
        self.setDisplayMode(self.mode === 'single' ? 'double' : 'single');
      });
      this.btnZoomIn.addEventListener('click', function () { self.zoomIn(); });
      this.btnZoomOut.addEventListener('click', function () { self.zoomOut(); });
    }
  };

  // -1 (top corner) .. 0 (mid edge) .. +1 (bottom corner)
  PDFlipbook.prototype._cornerFrom = function (clientY, midY, halfH) {
    if (!halfH) return 0;
    var f = clamp((clientY - midY) / halfH, -1, 1);
    var dead = 0.25;
    if (Math.abs(f) < dead) return 0;
    return f > 0 ? 1 : -1;
  };

  PDFlipbook.prototype._pointerDown = function (e) {
    if (this.anim || this.drag || this.pinch || this.zoom > 1.02 || e.button > 0) return;
    var zone = e.currentTarget === this.hotR ? 'R' : 'L';
    var dir = zone === 'R' ? 'fwd' : 'back';
    var single = this.mode === 'single';

    if (single) {
      if (dir === 'fwd' && this.viewPage >= this.numPages) return;
      if (dir === 'back' && this.viewPage <= 1) return;
    } else {
      if (dir === 'fwd' && this.current >= this.numSheets) return;
      if (dir === 'back' && this.current <= 0) return;
    }

    var k = null;
    if (!single) {
      k = this._beginFlip(dir);
      if (k === null) return;
    } else if (this.anim) {
      this._finishAnim(true);
    }

    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);

    var rect = this.book.getBoundingClientRect();
    var scale = rect.width / this._bookW() || 1;   // host/zoom scaling in effect
    var corner = this.opts.cornerFold
      ? this._cornerFrom(e.clientY, rect.top + rect.height / 2, rect.height / 2)
      : 0;
    // single mode peels for every grab; mid-edge anchors to the nearer corner
    var mode = (single || corner !== 0) ? 'fold' : 'flip';
    var bottom = corner !== 0
      ? corner > 0
      : e.clientY > rect.top + rect.height / 2;

    this.drag = {
      dir: dir, k: k, id: e.pointerId, mode: mode, rect: rect, scale: scale,
      startX: e.clientX, lastX: e.clientX,
      lastT: performance.now(), vx: 0,
      moved: false, zone: e.currentTarget
    };

    if (!single) this._beginShadowLerp(dir);
    if (mode === 'fold') {
      this._foldStart(dir, k, bottom);
      this._foldRender(this._toLocalU(e.clientX), (e.clientY - rect.top) / scale);
    }

    e.currentTarget.addEventListener('pointermove', this._onMove);
    e.currentTarget.addEventListener('pointerup', this._onUp);
    e.currentTarget.addEventListener('pointercancel', this._onUp);
  };

  PDFlipbook.prototype._toLocalU = function (clientX) {
    var d = this.drag;
    var spineScreen = d.rect.left + this._spineX() * d.scale;
    return (d.dir === 'fwd' ? 1 : -1) * (clientX - spineScreen) / d.scale;
  };

  PDFlipbook.prototype._pointerMove = function (e) {
    var d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    var now = performance.now();
    var dt = now - d.lastT;
    if (dt > 0) d.vx = (e.clientX - d.lastX) / dt;
    d.lastX = e.clientX;
    d.lastT = now;

    var dx = (e.clientX - d.startX) / d.scale;
    if (Math.abs(e.clientX - d.startX) > 6) d.moved = true;

    if (d.mode === 'fold') {
      this._foldRender(this._toLocalU(e.clientX), (e.clientY - d.rect.top) / d.scale);
      d.p = this._foldProgress();
      return;
    }

    var w = this.pageW * 2;
    var p = d.dir === 'fwd' ? clamp(-dx / w, 0, 1) : clamp(dx / w, 0, 1);
    var angle = d.dir === 'fwd' ? -180 * p : -180 + 180 * p;
    this._setSheet(d.k, angle, true);
    this._lerpStage(p);
    this._setCast(d.dir, Math.sin(p * Math.PI) * 0.85);
    d.p = p;
  };

  PDFlipbook.prototype._pointerUp = function (e) {
    var d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    d.zone.removeEventListener('pointermove', this._onMove);
    d.zone.removeEventListener('pointerup', this._onUp);
    d.zone.removeEventListener('pointercancel', this._onUp);
    this.drag = null;

    // a fling only counts if the pointer was still moving at release
    if (performance.now() - d.lastT > 120) d.vx = 0;

    var self = this;
    var fling = d.dir === 'fwd' ? d.vx < -0.4 : d.vx > 0.4;
    var flingBack = d.dir === 'fwd' ? d.vx > 0.4 : d.vx < -0.4;
    var complete = !d.moved || ((d.p || 0) > 0.5 && !flingBack) || fling;

    if (d.mode === 'fold') {
      this._foldAnimate(complete);
      return;
    }

    var t = d.dir === 'fwd' ? (complete ? -180 : 0) : (complete ? 0 : -180);
    this._animateTo(d.k, t, d.dir, function () {
      self._commit(d.dir, complete);
    });
  };

  /* ---------- Zoom & pan & pinch ---------- */

  PDFlipbook.prototype.setZoom = function (z) {
    z = clamp(z, 1, this.opts.zoomSteps[this.opts.zoomSteps.length - 1]);
    if (Math.abs(z - this.zoom) < 0.001) return;
    this.zoom = z;
    if (z <= 1.02) { this.zoom = 1; this.panX = 0; this.panY = 0; }
    this._applyStage();
    this._updateChrome();
    var self = this;
    clearTimeout(this._zoomT);
    this._zoomT = setTimeout(function () {
      if (!self.destroyed) self._renderWindow();   // re-render sharper
    }, 220);
    this._emit('zoomchange', { zoom: this.zoom });
  };

  PDFlipbook.prototype.zoomIn = function () {
    var steps = this.opts.zoomSteps;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] > this.zoom + 0.01) return this.setZoom(steps[i]);
    }
  };

  PDFlipbook.prototype.zoomOut = function () {
    var steps = this.opts.zoomSteps;
    for (var i = steps.length - 1; i >= 0; i--) {
      if (steps[i] < this.zoom - 0.01) return this.setZoom(steps[i]);
    }
  };

  PDFlipbook.prototype._rootDown = function (e) {
    if (e.target.closest && e.target.closest('.fb-nav,.fb-tool')) return;
    this.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(this.pointers);

    if (ids.length === 2) {
      // second finger: abort any flip in progress and start a pinch
      if (this.drag) {
        var d = this.drag;
        d.zone.removeEventListener('pointermove', this._onMove);
        d.zone.removeEventListener('pointerup', this._onUp);
        d.zone.removeEventListener('pointercancel', this._onUp);
        this.drag = null;
        if (d.mode === 'fold') this._foldAnimate(false);
        else this._animateTo(d.k, d.dir === 'fwd' ? 0 : -180, d.dir, this._commit.bind(this, d.dir, false));
      }
      var a = this.pointers[ids[0]], b = this.pointers[ids[1]];
      this.pinch = {
        baseDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        baseZoom: this.zoom
      };
      this.pan = null;
      this.stage.classList.add('fb-live');
    } else if (ids.length === 1 && this.zoom > 1.02 && !this.drag) {
      this.pan = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
      this.stage.classList.add('fb-live');
      // capture so a mouse-up released outside the container still reaches us
      // (otherwise pan state and the fb-live class get stuck)
      try { this.container.setPointerCapture(e.pointerId); } catch (e2) {}
      e.preventDefault();
    }
  };

  PDFlipbook.prototype._rootMove = function (e) {
    var pt = this.pointers[e.pointerId];
    if (!pt) return;
    pt.x = e.clientX; pt.y = e.clientY;

    if (this.pinch) {
      var ids = Object.keys(this.pointers);
      if (ids.length >= 2) {
        var a = this.pointers[ids[0]], b = this.pointers[ids[1]];
        var dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        var z = clamp(this.pinch.baseZoom * dist / this.pinch.baseDist,
          1, this.opts.zoomSteps[this.opts.zoomSteps.length - 1]);
        this.zoom = z <= 1.02 ? 1 : z;
        if (this.zoom === 1) { this.panX = 0; this.panY = 0; }
        this._applyStage();
        this._updateChrome();
      }
      return;
    }
    if (this.pan) {
      this.panX = this.pan.px + (e.clientX - this.pan.x);
      this.panY = this.pan.py + (e.clientY - this.pan.y);
      this._applyStage();
    }
  };

  PDFlipbook.prototype._rootUp = function (e) {
    delete this.pointers[e.pointerId];
    var n = Object.keys(this.pointers).length;
    if (this.pinch && n < 2) {
      this.pinch = null;
      this.stage.classList.remove('fb-live');
      var self = this;
      clearTimeout(this._zoomT);
      this._zoomT = setTimeout(function () {
        if (!self.destroyed) self._renderWindow();
      }, 220);
      this._emit('zoomchange', { zoom: this.zoom });
    }
    if (this.pan && n === 0) {
      this.pan = null;
      this.stage.classList.remove('fb-live');
    }
  };

  /* ---------- Display mode & fullscreen ---------- */

  PDFlipbook.prototype.setDisplayMode = function (mode) {
    this.modeOverride = mode === 'auto' ? null : mode;
    this.setZoom(1);
    this._layout();
    this._applyResting();
    this._renderWindow();
  };

  PDFlipbook.prototype.toggleFullscreen = function () {
    var c = this.container;
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl === c) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        var ep = exit.call(document);
        if (ep && ep.catch) ep.catch(function () {});
      }
      return;
    }
    if (this.fsFake) { this._setFakeFs(false); return; }

    var req = c.requestFullscreen || c.webkitRequestFullscreen;
    if (req) {
      var self = this;
      var p = req.call(c);
      if (p && p.catch) p.catch(function () { self._setFakeFs(true); });
    } else {
      this._setFakeFs(true);   // iPhone Safari
    }
  };

  PDFlipbook.prototype._setFakeFs = function (on) {
    this.fsFake = on;
    this.container.classList.toggle('fb-fake-fs', on);
    document.documentElement.classList.toggle('fb-noscroll', on);
    document.body.classList.toggle('fb-noscroll', on);
    this._fsChanged();
  };

  PDFlipbook.prototype._fsChanged = function () {
    var active = this.fsFake ||
      (document.fullscreenElement || document.webkitFullscreenElement) === this.container;
    if (this.btnFs) {
      this.btnFs.innerHTML = svgIcon(active ? 'compress' : 'expand');
      var label = active ? 'Exit fullscreen' : 'Fullscreen';
      this.btnFs.setAttribute('aria-label', label);
      this.btnFs.title = label;
    }
    this._updateShadow();
    // relayout now — the container may already be viewport-sized, in which
    // case the ResizeObserver won't fire, but the fullscreen padding changed
    if (this.pageW) {
      this._layout();
      var self = this;
      clearTimeout(this._fsT);
      this._fsT = setTimeout(function () {
        if (!self.destroyed) self._renderWindow();
      }, 200);
    }
  };

  /* ---------- Chrome ---------- */

  // The shadow models where paper actually lies: an extent from the spine
  // outward on each side (0..1 page widths). A side with settled sheets
  // beneath stays full through a turn; a side gaining its first paper only
  // fills as the fold lands — from the spine outward, in the second half
  // of the turn — and a side losing its last paper shrinks to the spine.
  PDFlipbook.prototype._setShadowExtents = function (leftExt, rightExt) {
    var W = this.pageW;
    this.shadowEl.style.left = (W * (1 - leftExt)).toFixed(1) + 'px';
    this.shadowEl.style.width = (Math.max(W * (leftExt + rightExt), 1)).toFixed(1) + 'px';
  };

  PDFlipbook.prototype._beginShadowLerp = function (dir) {
    if (!this.shadowEl || this.mode === 'single') return;
    var lu, ru;   // is there paper *beneath* the moving sheet on each side?
    if (dir === 'fwd') {
      lu = this.current > 0;
      ru = this.current + 1 < this.numSheets;
    } else {
      lu = this.current - 1 > 0;
      ru = this.current < this.numSheets;
    }
    if (lu && ru) return;   // paper everywhere: the shadow never moves
    this.shLerp = { dir: dir, lu: lu, ru: ru };
    this.shadowEl.style.transition = 'opacity .35s';
  };

  PDFlipbook.prototype._isFullscreen = function () {
    return this.fsFake ||
      (document.fullscreenElement || document.webkitFullscreenElement) === this.container;
  };

  // size the shadow to the *visible* footprint: one page when the cover,
  // back cover or single-page view is showing, the full spread otherwise
  PDFlipbook.prototype._updateShadow = function () {
    var pref = this.opts.shadow;
    var fs = this._isFullscreen();
    var on = pref === 'always' ||
      (pref === 'fullscreen' && fs) ||
      (pref === 'normal' && !fs);

    if (!this.shLerp) {
      this.shadowEl.style.transition = '';
      if (this.mode === 'single') {
        this.shadowEl.style.left = '0px';
        this.shadowEl.style.width = this.pageW + 'px';
      } else {
        this._setShadowExtents(this.current > 0 ? 1 : 0,
                               this.current < this.numSheets ? 1 : 0);
      }
    }
    this.shadowEl.style.opacity = on ? 1 : 0;
  };

  PDFlipbook.prototype._updateChrome = function () {
    this._updateShadow();
    var zoomed = this.zoom > 1.02;
    this.container.style.touchAction = zoomed ? 'none' : '';
    var atStart, atEnd;
    if (this.mode === 'single') {
      atStart = this.viewPage <= 1;
      atEnd = this.viewPage >= this.numPages;
    } else {
      atStart = this.current <= 0;
      atEnd = this.current >= this.numSheets;
    }

    if (this.btnPrev) {
      this.btnPrev.disabled = atStart;
      this.btnNext.disabled = atEnd;
    }
    this.hotL.hidden = atStart || zoomed;
    this.hotR.hidden = atEnd || zoomed;

    if (this.btnMode) {
      this.btnMode.innerHTML = svgIcon(this.mode === 'single' ? 'double' : 'single');
      var ml = this.mode === 'single' ? 'Two-page view' : 'Single page view';
      this.btnMode.setAttribute('aria-label', ml);
      this.btnMode.title = ml;
      var max = this.opts.zoomSteps[this.opts.zoomSteps.length - 1];
      this.btnZoomIn.disabled = this.zoom >= max - 0.01;
      this.btnZoomOut.disabled = this.zoom <= 1.01;
    }

    if (this.counter) {
      var label;
      if (this.mode === 'single') {
        label = this.viewPage + ' / ' + this.numPages;
      } else if (this.current === 0) {
        label = '1 / ' + this.numPages;
      } else if (this.current === this.numSheets && this.numPages % 2 === 0) {
        label = this.numPages + ' / ' + this.numPages;
      } else {
        var left = this.current * 2;
        var right = left + 1;
        label = right <= this.numPages ? left + '–' + right + ' / ' + this.numPages
                                       : left + ' / ' + this.numPages;
      }
      this.counter.textContent = label;
    }
  };

  PDFlipbook.prototype._emit = function (name, detail) {
    this.container.dispatchEvent(new CustomEvent('flipbook:' + name, { detail: detail, bubbles: true }));
  };

  /* ---------- Teardown ---------- */

  PDFlipbook.prototype.destroy = function () {
    if (this.destroyed) return;   // idempotent
    this.destroyed = true;
    if (this.anim) cancelAnimationFrame(this.anim.raf);
    if (this.ro) this.ro.disconnect();
    clearTimeout(this._zoomT);
    clearTimeout(this._fsT);
    clearTimeout(this._roT);
    if (this.pdf) {
      try {
        var dp = this.pdf.destroy();
        if (dp && dp.catch) dp.catch(function () {});
      } catch (e) { /* already torn down */ }
      this.pdf = null;
    }
    if (this.fsFake) this._setFakeFs(false);
    document.removeEventListener('fullscreenchange', this._onFsChange);
    document.removeEventListener('webkitfullscreenchange', this._onFsChange);
    this.container.removeEventListener('keydown', this._onKey);
    this.container.removeEventListener('pointerdown', this._onRootDown, true);
    this.container.removeEventListener('pointermove', this._onRootMove, true);
    this.container.removeEventListener('pointerup', this._onRootUp, true);
    this.container.removeEventListener('pointercancel', this._onRootUp, true);
    this.container.classList.remove('fb-root');
    this.container.innerHTML = '';
    // drop the auto-init guard so the element can be re-initialised later
    if (this.container.__pdflipbook === this) {
      try { delete this.container.__pdflipbook; }
      catch (e2) { this.container.__pdflipbook = null; }
    }
  };

  /* ------------------------------------------------------------------ */
  /* Public API & auto-init                                              */
  /* ------------------------------------------------------------------ */

  var API = {
    create: function (el, opts) { return new PDFlipbook(el, opts); }
  };

  function autoInit() {
    var nodes = document.querySelectorAll('[data-pdflipbook]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.__pdflipbook || el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
      el.__pdflipbook = new PDFlipbook(el, {
        url: el.getAttribute('data-pdflipbook'),
        startPage: parseInt(el.getAttribute('data-start-page') || '1', 10),
        displayMode: el.getAttribute('data-display-mode') || 'auto',
        shadow: el.getAttribute('data-shadow') || 'fullscreen',
        pageNumbers: el.getAttribute('data-page-numbers') !== 'false',
        arrows: el.getAttribute('data-arrows') !== 'false',
        controls: el.getAttribute('data-controls') !== 'false'
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

  global.PDFlipbook = API;
})(window);
