/* ============================================================
 * hand.js — 煎蛋世界模型 · 摄像头手势输入层（可选模块）
 *
 * 这是什么：
 *   打开笔记本摄像头，用 ml5.js 1.4.0（Google MediaPipe 手部关键点）识别一只手：
 *   「拇指尖 + 食指尖 捏合」= 按下，「捏着移动」= 拖动，「张开」= 放开。
 *   它不改游戏任何规则，也不碰 index.html 的鼠标逻辑：只是把手势翻译成
 *   和鼠标一模一样的 Pointer 事件（pointerdown / pointermove / pointerup），
 *   直接发给画布 <canvas id="game">。所以游戏代码一行都不用改，
 *   鼠标和键盘 1–9 永远照常可用。
 *
 * 怎么用（三步）：
 *   1. index.html 最后一行已经有  <script src="hand.js"></script>  （换别的页面才要自己加）
 *      （ml5 库会在第一次开摄像头时自动从 CDN 下载，不用再加别的 <script>）
 *   2. 用 https 网址（GitHub Pages）或 localhost 打开页面。
 *      直接双击 file:// 打开时，浏览器会拒绝摄像头，这个文件就安静地退回鼠标。
 *   3. 在游戏控制条里点「输入：手势」（或页面右下角的「Camera on」按钮），
 *      允许浏览器使用摄像头，把手放到镜头前。
 *   页面里如果已经有 <button id="hand-toggle">，就直接用它，不另外造按钮
 *   （index.html 放了一个隐藏的，所以统一用单选框；别的页面才会看到右下角的按钮）。
 *
 * 怎么调：
 *   所有可调数字都在下面的 CONFIG 里（捏合阈值、平滑系数、模型大小……），
 *   也可以在浏览器控制台（F12）临时改：EggHand.config.PINCH_DOWN_PX = 35
 *   详细说明见同目录的《手势版说明.md》。
 *
 * 对外接口（挂在 window.EggHand 上）：
 *   EggHand.start()     -> Promise<boolean>  开启；失败只在控制台和按钮旁提示，返回 false，绝不抛错
 *   EggHand.stop()      -> true               关闭摄像头、停止识别、清掉覆盖层
 *   EggHand.isRunning() -> true / false
 *   EggHand.config      -> 可调参数对象（改了立刻生效）
 *   EggHand.lastError   -> 最近一次失败原因（中文字符串，没失败则为空）
 *
 * 依赖：只有 https://cdn.jsdelivr.net/npm/ml5@1.4.0/dist/ml5.min.js 与浏览器自带的
 *      navigator.mediaDevices.getUserMedia；不用 p5.js。
 * 已核实（对照 ml5 1.4.0 源码 src/HandPose/index.js、src/utils/p5Utils.js 与官方文档 docs/reference/handpose.md）：
 *      ml5.handPose(options) / detectStart(video, callback) / detectStop() 都存在；
 *      21 个关键点 keypoints[i].name 依次为 wrist, thumb_cmc, thumb_mcp, thumb_ip, thumb_tip(4),
 *      index_finger_mcp, index_finger_pip, index_finger_dip, index_finger_tip(8), middle_finger_*,
 *      ring_finger_*, pinky_finger_*；每只手还有快捷字段 hand.thumb_tip.x / hand.index_finger_tip.x，
 *      以及 hand.confidence、hand.handedness。页面没有 p5 时 ml5.handPose() 返回 Promise（见下面 doStart）。
 * 自测（不需要摄像头）：  node hand_test.js
 * 语法检查：            node --check hand.js
 * ============================================================ */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------
  // 可调参数（非程序员也可以改这里的数字；改完刷新页面）
  // ---------------------------------------------------------------
  var CONFIG = {
    CANVAS_ID: 'game',                 // 游戏画布的 id（index.html 里固定是 game）
    ML5_URL: 'https://cdn.jsdelivr.net/npm/ml5@1.4.0/dist/ml5.min.js',
    ML5_LOAD_TIMEOUT_MS: 60000,        // 下载 ml5 库最多等 60 秒
    MODEL_LOAD_TIMEOUT_MS: 90000,      // 下载手部模型最多等 90 秒（第一次慢，以后有缓存）
    VIDEO_WIDTH: 640,                  // 向摄像头申请的分辨率（越小越快）
    VIDEO_HEIGHT: 480,
    MAX_HANDS: 1,                      // 只认一只手
    MODEL_TYPE: 'full',                // 'full' 更准，'lite' 更快；FPS 低于 15 就改成 'lite'
    MIN_HAND_CONFIDENCE: 0.5,          // 手的置信度低于它就当没看见
    PINCH_DOWN_PX: 40,                 // 拇指尖-食指尖距离 < 40 画布像素 → 按下（捏合）
    PINCH_UP_PX: 60,                   // 距离 > 60 画布像素 → 松开。中间 40–60 保持原状态（滞回防抖）
    EMA_OLD: 0.7,                      // 光标指数平滑：新光标 = 0.7×旧 + 0.3×新；越大越稳但越滞后
    EMA_NEW: 0.3,
    LOST_HAND_RELEASE_MS: 600,         // 捏着的时候手丢失超过 0.6 秒 → 自动当作松开
    POINTER_ID: 999,                   // 合成指针事件的 id（和真鼠标区分开）
    SHOW_KEYPOINTS: true,              // 覆盖层上淡画 21 个关键点
    SHOW_FPS: true,                    // 覆盖层左上角显示识别帧率
    LOW_FPS_WARN: 15,                  // 低于这个帧率就提示「偏慢」
    RADIO_HAND_ID: 'inputHand',        // index.html 里「输入：手势」单选框的 id（页面没有就忽略）
    RADIO_MOUSE_ID: 'inputMouse',      // index.html 里「输入：鼠标」单选框的 id（页面没有就忽略）
    LOG_PREFIX: '[EggHand]'
  };

  // MediaPipe 21 个手部关键点之间的连线（画骨架用），下标顺序：
  // 0 wrist, 1-4 thumb, 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky
  var HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17]
  ];
  var IDX_THUMB_TIP = 4;
  var IDX_INDEX_TIP = 8;

  // ---------------------------------------------------------------
  // 运行时状态（不要手改）
  // ---------------------------------------------------------------
  var S = {
    running: false,
    starting: null,        // 启动中的 Promise（防止连点两次）
    lastError: '',
    canvas: null, video: null, stream: null, hp: null,
    overlay: null, octx: null, raf: 0,
    cursor: null,          // 画布坐标里的光标 {x, y}
    pinched: false,
    pinchDist: null,
    lastHandTs: 0,
    keypoints: null,       // 画布坐标里的 21 个点（画覆盖层用）
    fps: 0, fpsCount: 0, fpsTs: 0,
    status: '',
    button: null, msgBox: null, msgTimer: 0
  };

  // ---------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------
  function now() {
    try {
      if (global.performance && typeof global.performance.now === 'function') return global.performance.now();
    } catch (e) { /* 忽略 */ }
    return new Date().getTime();
  }
  function log(msg) {
    try { if (global.console && console.log) console.log(CONFIG.LOG_PREFIX + ' ' + msg); } catch (e) { /* 忽略 */ }
  }
  function warn(msg) {
    try { if (global.console && console.warn) console.warn(CONFIG.LOG_PREFIX + ' ' + msg); } catch (e) { /* 忽略 */ }
  }
  // 记录失败原因、提示用户、返回 false（start() 里统一用它收尾）
  function fail(msg) {
    S.lastError = msg;
    warn(msg + '（已退回鼠标操作）');
    showMessage(msg);
    updateButton();
    return false;
  }
  function getDoc() { return global.document || null; }
  function getCanvas() {
    var d = getDoc();
    if (!d || typeof d.getElementById !== 'function') return null;
    try { return d.getElementById(CONFIG.CANVAS_ID) || null; } catch (e) { return null; }
  }
  function withTimeout(promise, ms, msg) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; reject(new Error(msg)); } }, ms);
      Promise.resolve(promise).then(function (v) {
        if (!done) { done = true; clearTimeout(timer); resolve(v); }
      }, function (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      });
    });
  }

  // ---------------------------------------------------------------
  // 坐标映射：视频像素 → 画布像素（水平镜像：手往右，光标也往右）
  // ---------------------------------------------------------------
  function toCanvas(kp, vw, vh, cw, ch) {
    if (!(vw > 0)) vw = CONFIG.VIDEO_WIDTH;
    if (!(vh > 0)) vh = CONFIG.VIDEO_HEIGHT;
    return {
      x: (vw - kp.x) * cw / vw,   // 镜像
      y: kp.y * ch / vh
    };
  }

  // ---------------------------------------------------------------
  // 合成 Pointer 事件并发给画布（游戏就像收到真鼠标一样）
  // ---------------------------------------------------------------
  function makeEvent(type, init) {
    try {
      if (typeof global.PointerEvent === 'function') return new global.PointerEvent(type, init);
    } catch (e) { /* 继续退化 */ }
    try {
      if (typeof global.MouseEvent === 'function') {
        var ev = new global.MouseEvent(type, init);
        var extra = ['pointerId', 'pointerType', 'isPrimary', 'pressure', 'width', 'height'];
        for (var i = 0; i < extra.length; i++) {
          try { Object.defineProperty(ev, extra[i], { value: init[extra[i]], configurable: true }); } catch (e2) { /* 忽略 */ }
        }
        return ev;
      }
    } catch (e) { /* 继续退化 */ }
    try {
      var d = getDoc();
      var ev2 = d.createEvent('Event');
      ev2.initEvent(type, true, true);
      for (var k in init) { if (Object.prototype.hasOwnProperty.call(init, k)) { try { ev2[k] = init[k]; } catch (e3) { /* 忽略 */ } } }
      return ev2;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function fire(type, x, y, buttons) {
    var c = S.canvas || getCanvas();
    if (!c || typeof c.dispatchEvent !== 'function') return false;
    var cw = c.width || 960, ch = c.height || 600;
    var rect = { left: 0, top: 0, width: cw, height: ch };
    try {
      var r = c.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) rect = r;
    } catch (e) { /* 用默认 */ }
    var clientX = rect.left + x * rect.width / cw;
    var clientY = rect.top + y * rect.height / ch;
    var down = type !== 'pointerup';
    var init = {
      bubbles: true, cancelable: true, composed: true, view: global,
      clientX: clientX, clientY: clientY, screenX: clientX, screenY: clientY,
      button: 0, buttons: (buttons === undefined ? (down ? 1 : 0) : buttons),
      pointerId: CONFIG.POINTER_ID, pointerType: 'mouse', isPrimary: true,
      pressure: down ? 0.5 : 0, width: 1, height: 1
    };
    var ev = makeEvent(type, init);
    if (!ev) return false;
    try { c.dispatchEvent(ev); } catch (e) { warn('dispatchEvent 出错：' + (e && e.message)); return false; }
    return true;
  }

  // 游戏若在 pointerdown 里调用 canvas.setPointerCapture(e.pointerId)，
  // 对我们合成的 999 号指针浏览器会抛 NotFoundError。这里把 999 号的捕获变成空操作，
  // 真鼠标的捕获照旧。只装一次，不影响鼠标。
  function installCaptureGuard(c) {
    if (!c || c.__eggHandGuard) return;
    var orig = { set: c.setPointerCapture, rel: c.releasePointerCapture, has: c.hasPointerCapture };
    c.setPointerCapture = function (id) {
      if (id === CONFIG.POINTER_ID) return undefined;
      if (typeof orig.set === 'function') return orig.set.apply(this, arguments);
      return undefined;
    };
    c.releasePointerCapture = function (id) {
      if (id === CONFIG.POINTER_ID) return undefined;
      if (typeof orig.rel === 'function') return orig.rel.apply(this, arguments);
      return undefined;
    };
    c.hasPointerCapture = function (id) {
      if (id === CONFIG.POINTER_ID) return S.pinched;
      if (typeof orig.has === 'function') return orig.has.apply(this, arguments);
      return false;
    };
    c.__eggHandGuard = orig;
  }

  // ---------------------------------------------------------------
  // 核心：一帧识别结果 → 光标 + 捏合状态 → 指针事件
  // ---------------------------------------------------------------
  function pickHand(results) {
    if (!results || !results.length) return null;
    var best = null, bestC = -1;
    for (var i = 0; i < results.length; i++) {
      var h = results[i];
      if (!h) continue;
      var c = (typeof h.confidence === 'number') ? h.confidence : (typeof h.score === 'number' ? h.score : 1);
      if (c > bestC) { best = h; bestC = c; }
    }
    if (!best || bestC < CONFIG.MIN_HAND_CONFIDENCE) return null;
    return best;
  }
  function kpByName(hand, name, idx) {
    if (hand[name] && typeof hand[name].x === 'number') return hand[name];
    var kps = hand.keypoints || [];
    for (var i = 0; i < kps.length; i++) if (kps[i] && kps[i].name === name) return kps[i];
    if (kps[idx] && typeof kps[idx].x === 'number') return kps[idx];
    return null;
  }

  function processHands(results, vw, vh, t) {
    if (t === undefined) t = now();
    var c = S.canvas || getCanvas();
    if (!c) return;
    var cw = c.width || 960, ch = c.height || 600;
    if (!(vw > 0)) vw = (S.video && S.video.videoWidth) || CONFIG.VIDEO_WIDTH;
    if (!(vh > 0)) vh = (S.video && S.video.videoHeight) || CONFIG.VIDEO_HEIGHT;

    // 帧率统计（每秒刷新一次）
    S.fpsCount++;
    if (!S.fpsTs) S.fpsTs = t;
    if (t - S.fpsTs >= 1000) {
      S.fps = Math.round(S.fpsCount * 1000 / (t - S.fpsTs));
      S.fpsCount = 0; S.fpsTs = t;
    }

    var hand = pickHand(results);
    if (!hand) { S.keypoints = null; S.pinchDist = null; return; }   // 手丢失由 checkLost 处理
    var thumb = kpByName(hand, 'thumb_tip', IDX_THUMB_TIP);
    var index = kpByName(hand, 'index_finger_tip', IDX_INDEX_TIP);
    if (!thumb || !index) { S.keypoints = null; S.pinchDist = null; return; }

    var T = toCanvas(thumb, vw, vh, cw, ch);
    var I = toCanvas(index, vw, vh, cw, ch);
    var d = Math.sqrt((T.x - I.x) * (T.x - I.x) + (T.y - I.y) * (T.y - I.y));
    var m = { x: (T.x + I.x) / 2, y: (T.y + I.y) / 2 };
    if (!S.cursor) S.cursor = { x: m.x, y: m.y };
    else S.cursor = {
      x: CONFIG.EMA_OLD * S.cursor.x + CONFIG.EMA_NEW * m.x,
      y: CONFIG.EMA_OLD * S.cursor.y + CONFIG.EMA_NEW * m.y
    };
    S.lastHandTs = t;
    S.pinchDist = d;

    // 覆盖层用的 21 个点
    var kps = hand.keypoints || [];
    var mapped = [];
    for (var i = 0; i < kps.length; i++) {
      if (kps[i] && typeof kps[i].x === 'number') mapped.push(toCanvas(kps[i], vw, vh, cw, ch));
    }
    S.keypoints = mapped;

    // 和真鼠标一样：先 move（让悬停跟上），再 down / up
    fire('pointermove', S.cursor.x, S.cursor.y, S.pinched ? 1 : 0);
    if (!S.pinched && d < CONFIG.PINCH_DOWN_PX) {
      S.pinched = true;
      fire('pointerdown', S.cursor.x, S.cursor.y, 1);
    } else if (S.pinched && d > CONFIG.PINCH_UP_PX) {
      S.pinched = false;
      fire('pointerup', S.cursor.x, S.cursor.y, 0);
    }
  }

  // 捏着的时候手跑出画面太久 → 自动松开，免得游戏卡在「抓着东西」的状态
  function checkLost(t) {
    if (t === undefined) t = now();
    if (S.pinched && (t - S.lastHandTs) > CONFIG.LOST_HAND_RELEASE_MS) {
      S.pinched = false;
      if (S.cursor) fire('pointerup', S.cursor.x, S.cursor.y, 0);
      log('手离开画面，自动松开');
      return true;
    }
    return false;
  }

  function onHands(results) {
    try { processHands(results); } catch (e) { warn('处理识别结果出错：' + (e && e.message)); }
  }

  // ---------------------------------------------------------------
  // 覆盖层：淡画 21 个关键点 + 光标圆环（捏合时填实）+ FPS
  // ---------------------------------------------------------------
  function ensureOverlay() {
    var d = getDoc();
    if (S.overlay) return S.overlay;
    if (!d || typeof d.createElement !== 'function' || !d.body) return null;
    try {
      var c = S.canvas || getCanvas();
      var o = d.createElement('canvas');
      o.id = 'hand-overlay';
      o.width = (c && c.width) || 960;
      o.height = (c && c.height) || 600;
      var st = o.style || {};
      st.position = 'fixed'; st.left = '0px'; st.top = '0px';
      st.pointerEvents = 'none'; st.zIndex = '9999';
      d.body.appendChild(o);
      S.overlay = o;
      S.octx = (typeof o.getContext === 'function') ? o.getContext('2d') : null;
      return o;
    } catch (e) { warn('建不了覆盖层：' + (e && e.message)); return null; }
  }
  function removeOverlay() {
    if (S.overlay) {
      try { if (S.overlay.parentNode) S.overlay.parentNode.removeChild(S.overlay); } catch (e) { /* 忽略 */ }
    }
    S.overlay = null; S.octx = null;
  }
  function syncOverlay() {
    var c = S.canvas, o = S.overlay;
    if (!c || !o) return;
    try {
      var r = c.getBoundingClientRect();
      if (!r) return;
      if (o.width !== c.width) o.width = c.width;
      if (o.height !== c.height) o.height = c.height;
      o.style.left = r.left + 'px'; o.style.top = r.top + 'px';
      o.style.width = r.width + 'px'; o.style.height = r.height + 'px';
    } catch (e) { /* 忽略 */ }
  }
  function drawOverlay() {
    var ctx = S.octx, o = S.overlay;
    if (!ctx || !o) return;
    syncOverlay();
    ctx.clearRect(0, 0, o.width, o.height);
    var kps = S.keypoints;
    if (CONFIG.SHOW_KEYPOINTS && kps && kps.length >= 21) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      for (var i = 0; i < HAND_CONNECTIONS.length; i++) {
        var a = kps[HAND_CONNECTIONS[i][0]], b = kps[HAND_CONNECTIONS[i][1]];
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      for (var j = 0; j < kps.length; j++) {
        ctx.beginPath(); ctx.arc(kps[j].x, kps[j].y, 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (S.cursor) {
      var R = 16;
      ctx.lineWidth = 3;
      ctx.strokeStyle = S.pinched ? 'rgba(255,140,0,0.95)' : 'rgba(255,255,255,0.9)';
      ctx.beginPath(); ctx.arc(S.cursor.x, S.cursor.y, R, 0, Math.PI * 2); ctx.stroke();
      if (S.pinched) { ctx.fillStyle = 'rgba(255,140,0,0.55)'; ctx.fill(); }
      // 中心小点，便于对准
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.arc(S.cursor.x, S.cursor.y, 2.5, 0, Math.PI * 2); ctx.fill();
    }
    var lines = [];
    if (CONFIG.SHOW_FPS) {
      var fpsTxt = 'FPS ' + S.fps;
      if (S.fps > 0 && S.fps < CONFIG.LOW_FPS_WARN) fpsTxt += '  偏慢：换 lite / 加光 / 关其他标签页';
      lines.push(fpsTxt);
    }
    if (S.status) lines.push(S.status);
    else if (!S.keypoints) lines.push('没看到手：手掌对着摄像头，整只手放进画面');
    else lines.push(S.pinched ? '捏合中（按下）' : '张开（松开）  指距 ' + Math.round(S.pinchDist || 0) + 'px');
    ctx.font = '14px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (var k = 0; k < lines.length; k++) {
      var w = ctx.measureText ? ctx.measureText(lines[k]).width : 200;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(6, 6 + k * 20, w + 10, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(lines[k], 11, 8 + k * 20);
    }
  }
  function loop() {
    if (!S.running) return;
    try { checkLost(now()); drawOverlay(); } catch (e) { /* 画不出来也不影响游戏 */ }
    if (typeof global.requestAnimationFrame === 'function') S.raf = global.requestAnimationFrame(loop);
  }
  function setStatus(txt) { S.status = txt || ''; updateButton(); }

  // ---------------------------------------------------------------
  // 加载 ml5（只在第一次开摄像头时下载，约 4.5 MB）
  // ---------------------------------------------------------------
  function loadMl5() {
    return new Promise(function (resolve) {
      if (global.ml5 && typeof global.ml5.handPose === 'function') return resolve(true);
      var d = getDoc();
      if (!d || typeof d.createElement !== 'function' || !(d.head || d.body)) {
        fail('页面没有 document，加载不了 ml5');
        return resolve(false);
      }
      var done = false;
      var s;
      try { s = d.createElement('script'); } catch (e) { fail('建不了 <script>'); return resolve(false); }
      s.src = CONFIG.ML5_URL; s.async = true;
      var timer = setTimeout(function () {
        if (done) return; done = true;
        fail('下载 ml5 超时（网络太慢或 CDN 被挡）');
        resolve(false);
      }, CONFIG.ML5_LOAD_TIMEOUT_MS);
      s.onload = function () {
        if (done) return; done = true; clearTimeout(timer);
        if (global.ml5 && typeof global.ml5.handPose === 'function') resolve(true);
        else { fail('ml5 下载了但没有 handPose（版本不对？请用 1.4.0）'); resolve(false); }
      };
      s.onerror = function () {
        if (done) return; done = true; clearTimeout(timer);
        fail('ml5 下载失败：没有网络，或 cdn.jsdelivr.net 打不开');
        resolve(false);
      };
      try { (d.head || d.body).appendChild(s); } catch (e) {
        if (!done) { done = true; clearTimeout(timer); fail('插入 <script> 失败'); resolve(false); }
      }
    });
  }

  function explainCameraError(e) {
    var name = (e && e.name) || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return '你拒绝了摄像头权限。点地址栏左边的图标把「摄像头」改成允许，再点一次「手势」（Camera on）';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没找到摄像头（外接摄像头插好了吗？）';
    if (name === 'NotReadableError' || name === 'TrackStartError') return '摄像头被别的程序占用（Zoom / Teams / 微信视频？关掉再试）';
    if (name === 'SecurityError') return '浏览器出于安全拒绝开摄像头：页面必须是 https 或 localhost';
    if (name === 'OverconstrainedError') return '摄像头不支持申请的分辨率（把 CONFIG.VIDEO_WIDTH/HEIGHT 改小）';
    return '打不开摄像头：' + (name || (e && e.message) || '未知错误');
  }

  function waitVideoReady(v) {
    return new Promise(function (resolve) {
      var done = false;
      function ok() { if (done) return; done = true; resolve(true); }
      var timer = setTimeout(function () { if (!done) { done = true; resolve(v.videoWidth > 0); } }, 10000);
      try {
        if (v.readyState >= 2 && v.videoWidth > 0) { clearTimeout(timer); return ok(); }
        v.onloadedmetadata = function () { clearTimeout(timer); ok(); };
        v.onloadeddata = function () { clearTimeout(timer); ok(); };
      } catch (e) { clearTimeout(timer); ok(); }
    });
  }

  // ---------------------------------------------------------------
  // 开 / 关
  // ---------------------------------------------------------------
  function cleanup() {
    if (S.hp && typeof S.hp.detectStop === 'function') { try { S.hp.detectStop(); } catch (e) { /* 忽略 */ } }
    S.hp = null;
    if (S.pinched) { S.pinched = false; if (S.cursor) fire('pointerup', S.cursor.x, S.cursor.y, 0); }
    if (S.raf && typeof global.cancelAnimationFrame === 'function') { try { global.cancelAnimationFrame(S.raf); } catch (e) { /* 忽略 */ } }
    S.raf = 0;
    if (S.stream) {
      try { var tracks = S.stream.getTracks ? S.stream.getTracks() : []; for (var i = 0; i < tracks.length; i++) { try { tracks[i].stop(); } catch (e) { /* 忽略 */ } } } catch (e2) { /* 忽略 */ }
    }
    S.stream = null;
    if (S.video) {
      try { S.video.pause && S.video.pause(); } catch (e) { /* 忽略 */ }
      try { S.video.srcObject = null; } catch (e) { /* 忽略 */ }
      try { if (S.video.parentNode) S.video.parentNode.removeChild(S.video); } catch (e) { /* 忽略 */ }
    }
    S.video = null;
    removeOverlay();
    S.running = false; S.status = '';
    S.cursor = null; S.keypoints = null; S.pinchDist = null;
    updateButton();
  }

  async function doStart() {
    S.lastError = '';
    var d = getDoc();
    var c = getCanvas();
    if (!c) return fail('找不到 <canvas id="' + CONFIG.CANVAS_ID + '">，手势层没有可操作的画布');
    S.canvas = c;

    if (global.isSecureContext === false) {
      return fail('页面不是 https 也不是 localhost（file:// 直接双击打开不行），浏览器不允许开摄像头');
    }
    var nav = global.navigator;
    if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
      return fail('这个浏览器拿不到摄像头接口（getUserMedia）。请用 Chrome / Edge，并用 https 或 localhost 打开');
    }

    setStatus('正在打开摄像头…');
    var stream;
    try {
      stream = await nav.mediaDevices.getUserMedia({
        video: { width: { ideal: CONFIG.VIDEO_WIDTH }, height: { ideal: CONFIG.VIDEO_HEIGHT }, facingMode: 'user' },
        audio: false
      });
    } catch (e) { setStatus(''); return fail(explainCameraError(e)); }
    S.stream = stream;

    // 隐藏的 <video>（不用 display:none，有些浏览器会因此不出帧）
    var v;
    try {
      v = d.createElement('video');
      v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.setAttribute('autoplay', '');
      v.muted = true; v.playsInline = true; v.autoplay = true;
      var st = v.style || {};
      st.position = 'fixed'; st.left = '-10000px'; st.top = '0px'; st.width = '1px'; st.height = '1px'; st.opacity = '0';
      v.srcObject = stream;
      if (d.body) d.body.appendChild(v);
    } catch (e) { cleanup(); return fail('建不了 <video>：' + (e && e.message)); }
    S.video = v;
    try { var p = v.play(); if (p && typeof p.catch === 'function') p.catch(function () { /* 静音视频一般能自动播放 */ }); } catch (e) { /* 忽略 */ }
    var ready = await waitVideoReady(v);
    if (!ready) { cleanup(); return fail('摄像头打开了但没有画面（videoWidth=0）'); }

    setStatus('正在下载 ml5 库（约 4.5 MB，只下一次）…');
    if (!(await loadMl5())) { cleanup(); return false; }

    setStatus('正在加载手部模型（第一次要几十秒）…');
    // 已对照 ml5 1.4.0 源码核实（src/utils/p5Utils.js 的 registerAsyncConstructors）：
    // 页面没有 p5.js 时，ml5.handPose(options) 被包成「返回 Promise，resolve 后才是实例」；
    // 有 p5 1.x 时则直接返回实例（实例上有 .ready Promise）。两种形态都兼容：
    var hp;
    try {
      hp = global.ml5.handPose({ maxHands: CONFIG.MAX_HANDS, modelType: CONFIG.MODEL_TYPE, flipped: false, runtime: 'tfjs' });
      if (hp && typeof hp.then === 'function') {
        hp = await withTimeout(hp, CONFIG.MODEL_LOAD_TIMEOUT_MS, '手部模型下载超时');
      }
      if (hp && hp.ready && typeof hp.ready.then === 'function') {
        await withTimeout(hp.ready, CONFIG.MODEL_LOAD_TIMEOUT_MS, '手部模型下载超时');
      }
    } catch (e) { cleanup(); return fail('手部模型加载失败：' + ((e && e.message) || e)); }
    if (!hp || typeof hp.detectStart !== 'function') { cleanup(); return fail('ml5.handPose 没有 detectStart（请确认 ml5 是 1.4.0）'); }
    S.hp = hp;

    installCaptureGuard(c);
    ensureOverlay();
    S.cursor = null; S.pinched = false; S.keypoints = null; S.pinchDist = null;
    S.fps = 0; S.fpsCount = 0; S.fpsTs = now(); S.lastHandTs = now();
    try { hp.detectStart(v, onHands); } catch (e) { cleanup(); return fail('detectStart 失败：' + ((e && e.message) || e)); }

    S.running = true;
    setStatus('');
    if (typeof global.requestAnimationFrame === 'function') S.raf = global.requestAnimationFrame(loop);
    log('手势层已开启：捏合 = 按下，移动 = 拖，张开 = 放开');
    return true;
  }

  function start() {
    if (S.running) return Promise.resolve(true);
    if (S.starting) return S.starting;
    var p;
    try {
      p = doStart();
    } catch (e) {
      // doStart 是 async，正常不会同步抛；兜底
      p = Promise.resolve(fail('启动出错：' + ((e && e.message) || e)));
    }
    S.starting = Promise.resolve(p).then(function (ok) {
      S.starting = null; updateButton(); return !!ok;
    }, function (e) {
      S.starting = null;
      try { cleanup(); } catch (e2) { /* 忽略 */ }
      return fail('启动出错：' + ((e && e.message) || e));
    });
    updateButton();
    return S.starting;
  }

  function stop() {
    try { cleanup(); } catch (e) { warn('关闭时出错：' + (e && e.message)); }
    log('手势层已关闭，回到鼠标');
    return true;
  }

  function isRunning() { return !!S.running; }

  // ---------------------------------------------------------------
  // 按钮与提示
  // ---------------------------------------------------------------
  function showMessage(txt) {
    var d = getDoc();
    if (!d || typeof d.createElement !== 'function' || !d.body) return;
    try {
      if (!S.msgBox) {
        var box = d.createElement('div');
        box.id = 'hand-msg';
        var st = box.style || {};
        st.position = 'fixed'; st.right = '12px'; st.bottom = '52px'; st.maxWidth = '360px';
        st.padding = '8px 12px'; st.background = 'rgba(0,0,0,0.8)'; st.color = '#fff';
        st.font = '13px system-ui, sans-serif'; st.borderRadius = '6px'; st.zIndex = '10000';
        st.pointerEvents = 'none';
        d.body.appendChild(box);
        S.msgBox = box;
      }
      S.msgBox.textContent = txt;
      S.msgBox.style.display = 'block';
      if (S.msgTimer) clearTimeout(S.msgTimer);
      S.msgTimer = setTimeout(function () { try { S.msgBox.style.display = 'none'; } catch (e) { /* 忽略 */ } }, 8000);
    } catch (e) { /* 忽略 */ }
  }

  // 页面若有「输入：鼠标 / 手势」单选框（index.html 有），让它跟着真实状态走：
  // 只改 checked、不派发 change 事件，所以不会反过来再调 start()/stop()，不会死循环。
  function syncRadios() {
    var d = getDoc();
    if (!d || typeof d.getElementById !== 'function' || S.starting) return;
    try {
      var rh = d.getElementById(CONFIG.RADIO_HAND_ID), rm = d.getElementById(CONFIG.RADIO_MOUSE_ID);
      if (!rh || !rm) return;
      if (S.running) rh.checked = true; else rm.checked = true;
    } catch (e) { /* 忽略 */ }
  }
  function updateButton() {
    syncRadios();
    var b = S.button;
    if (!b) return;
    var txt;
    if (S.running) txt = 'Camera off（关闭手势）';
    else if (S.starting) txt = 'Camera …（' + (S.status || '启动中') + '）';
    else if (S.lastError) txt = 'Camera on（上次失败，再试一次）';
    else txt = 'Camera on（开启手势）';
    try { b.textContent = txt; } catch (e) { /* 忽略 */ }
    try { b.title = S.lastError || '捏合拇指和食指 = 按下；捏着移动 = 拖；张开 = 放开'; } catch (e) { /* 忽略 */ }
    try { if (typeof b.setAttribute === 'function') b.setAttribute('data-state', S.running ? 'on' : (S.starting ? 'starting' : 'off')); } catch (e) { /* 忽略 */ }
  }
  function onToggleClick() {
    if (S.running) { stop(); return; }
    if (S.starting) return;
    start();
  }
  function setupButton() {
    var d = getDoc();
    if (!d || typeof d.getElementById !== 'function') return null;
    var b = null;
    try { b = d.getElementById('hand-toggle'); } catch (e) { b = null; }
    if (!b) {
      if (typeof d.createElement !== 'function' || !d.body) return null;
      try {
        b = d.createElement('button');
        b.id = 'hand-toggle'; b.type = 'button';
        var st = b.style || {};
        st.position = 'fixed'; st.right = '12px'; st.bottom = '12px'; st.zIndex = '10000';
        st.padding = '8px 14px'; st.font = '14px system-ui, sans-serif'; st.cursor = 'pointer';
        st.borderRadius = '6px'; st.border = '1px solid #888'; st.background = '#fff';
        d.body.appendChild(b);
      } catch (e) { return null; }
    }
    S.button = b;
    try {
      if (typeof b.addEventListener === 'function') b.addEventListener('click', onToggleClick);
      else b.onclick = onToggleClick;
    } catch (e) { /* 忽略 */ }
    updateButton();
    return b;
  }
  function whenReady(fn) {
    var d = getDoc();
    if (!d) return;
    try {
      if (d.readyState === 'loading' && typeof d.addEventListener === 'function') d.addEventListener('DOMContentLoaded', function () { fn(); });
      else fn();
    } catch (e) { /* 忽略 */ }
  }

  // ---------------------------------------------------------------
  // 导出
  // ---------------------------------------------------------------
  var EggHand = {
    start: start,
    stop: stop,
    isRunning: isRunning,
    config: CONFIG,
    version: '1.0.0',
    // 下面是测试 / 调试用的内部入口，游戏不要调用
    _internal: {
      state: S,
      processHands: processHands,
      checkLost: checkLost,
      fire: fire,
      toCanvas: toCanvas,
      installCaptureGuard: installCaptureGuard,
      setupButton: setupButton,
      loadMl5: loadMl5,
      explainCameraError: explainCameraError,
      HAND_CONNECTIONS: HAND_CONNECTIONS
    }
  };
  try {
    Object.defineProperty(EggHand, 'lastError', { get: function () { return S.lastError; }, enumerable: true });
  } catch (e) { EggHand.lastError = ''; }

  global.EggHand = EggHand;
  if (typeof module !== 'undefined' && module.exports) module.exports = EggHand;

  whenReady(setupButton);
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
