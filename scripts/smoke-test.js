#!/usr/bin/env node
/**
 * 冒烟测试（不需要 Electron）
 * ---------------------------------------------------------------------------
 * 把编译好的 dist/renderer/renderer.js 丢进一个假 DOM 里跑，验证核心行为：
 *   1. 四边反弹，且球永远不出屏
 *   2. 悬停小球 → setInteractive(true)；移开 → setInteractive(false)
 *   3. 单击 → 停下 + 呼出面板 + 缩放脉冲（不再换色）
 *   4. 只有长按 ≥100ms 才进入拖拽，拖拽中球被夹在屏幕内
 *   5. 拖拽松手 → 用拖拽速度抛出，且速度上限 25
 *   6. 抛出造成的提速会指数回落到常态速度
 *   7. 面板上的速度 / 大小滑块实时生效
 *   8. 移动时贴图按「滚动」关系旋转（方向跟着 vx 走，停下就不转）
 *
 * 观测手段：小球是整张贴图 drawImage 上去的，位置 / 尺寸直接从
 * ctx.drawImage(img, dx, dy, dw, dh) 的参数反推（rx = dw/2、ry = dh/2）。
 * draw() 会先 translate 到球心再 rotate，所以假 ctx 把 translate 累积起来、
 * 把 rotate 的角度记下来：dw / dh 永远是**贴图自身**的尺寸，旋转角另外算。
 * 因为贴图是蛋形，竖直半径 ry 比水平半径 rx 大（ry = rx × 521/448），
 * 而转起来之后轴对齐外接框又在两者之间摆动 —— 判「有没有出屏」时，
 * 必须用 ballState() 算出来的旋转后外接框（旋转角为 0 时退化回原值）。
 * 全部是只读观测，不改动业务代码。
 *
 *   node scripts/smoke-test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RENDERER = path.resolve(__dirname, '..', 'dist', 'renderer', 'renderer.js');
if (!fs.existsSync(RENDERER)) {
  console.error(`✗ 找不到 ${RENDERER}，请先执行 npm run build`);
  process.exit(1);
}

const FRAME = 1000 / 60;
// 测试 1 需要小球够快撞到四边 → 用小屏；测试 3/5 需要绝对不撞墙 → 用大屏
const SMALL = { width: 1000, height: 700 };
const HUGE = { width: 4000, height: 3000 };

// --------------------------------------------------------------------- 假 DOM
function createHarness(size = SMALL, options = {}) {
  const W = size.width;
  const H = size.height;
  /** 这些文件名会被 FakeAudio 当成「文件不存在」，用来验证笑声的降级提示 */
  const missingAudio = options.missingAudio ? new Set(options.missingAudio) : new Set();
  /** 让 FakeAudio.play() 同步报告失败，验证「播放态回滚」 */
  const failPlay = !!options.failPlay;
  let now = 0;

  // 反弹是带随机性的，用固定种子的 Math.random 让每次跑出来的结果完全一致
  let seed = 0x2f6e2b1;
  const seededMath = Object.create(Math);
  seededMath.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let rafCallback = null;
  const windowHandlers = new Map();
  const docHandlers = new Map();
  const interactiveCalls = [];
  const subscriptions = { paused: [], reset: [], layout: [] };

  let arcs = []; // 本帧的 ellipse 调用（只有贴图未就绪时的兜底路径才会走）
  let images = []; // 本帧的 drawImage 调用（贴图路径）
  let spins = []; // 本帧的 rotate 调用
  // 台球模式的球杆是「多边形填充」画的，不是图片，所以得单独收：
  //   paths   —— 本帧 fill() 掉的多边形（杆身 + 皮头两个梯形）
  //   strokes —— 本帧 stroke() 掉的折线（瞄准虚线）
  let paths = [];
  let strokes = [];
  let pathPts = [];
  // 「停稳开应用」的三样东西各收一份：
  //   roundRects —— 高亮框（正方形）+ 名字牌（长方形）
  //   ringArcs   —— 倒计时环（唯一用 ctx.arc 的地方）
  //   texts      —— 名字牌上的文字
  let roundRects = [];
  let ringArcs = [];
  let texts = [];

  // 画布变换的最小实现：渲染层用 save/translate/rotate 把贴图绕球心转，
  // 这里把位移累积起来，好让 drawImage 的参数换算回绝对坐标。
  const xformStack = [];
  let tx = 0;
  let ty = 0;

  const ctx2d = {
    lineWidth: 0,
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: false,
    imageSmoothingQuality: '',
    setTransform() {},
    clearRect() {
      arcs = [];
      images = [];
      spins = [];
      paths = [];
      strokes = [];
      pathPts = [];
      roundRects = [];
      ringArcs = [];
      texts = [];
      xformStack.length = 0;
      tx = 0;
      ty = 0;
    },
    save() {
      xformStack.push([tx, ty]);
    },
    restore() {
      const prev = xformStack.pop();
      if (prev) {
        tx = prev[0];
        ty = prev[1];
      }
    },
    translate(x, y) {
      tx += x;
      ty += y;
    },
    rotate(angle) {
      spins.push(angle);
    },
    beginPath() {
      pathPts = [];
    },
    moveTo(x, y) {
      pathPts.push([x + tx, y + ty]);
    },
    lineTo(x, y) {
      pathPts.push([x + tx, y + ty]);
    },
    closePath() {},
    setLineDash() {},
    /** 倒计时环。全场只有它用 arc，所以单独收一张表，不和兜底椭圆的 arcs 混 */
    arc(x, y, r, startAngle, endAngle) {
      ringArcs.push({
        x: x + tx,
        y: y + ty,
        r,
        startAngle,
        endAngle,
        lineWidth: ctx2d.lineWidth,
      });
    },
    ellipse(x, y, rx, ry) {
      arcs.push({ x: x + tx, y: y + ty, r: rx, rx, ry });
    },
    /** 高亮框 / 名字牌：新浏览器走 roundRect，老环境退化成 rect —— 两个都记进同一张表 */
    rect(x, y, w, h) {
      roundRects.push({ x: x + tx, y: y + ty, w, h, radius: 0 });
    },
    roundRect(x, y, w, h, radius) {
      roundRects.push({ x: x + tx, y: y + ty, w, h, radius });
    },
    /** 固定的 7px/字：让「名字太长要截断」这条逻辑有确定的输入输出 */
    measureText(text) {
      return { width: String(text).length * 7 };
    },
    fillText(text, x, y) {
      texts.push({ text: String(text), x: x + tx, y: y + ty, font: ctx2d.font });
    },
    fill() {
      // 高亮框 / 名字牌用的是 rect / roundRect，不会往 pathPts 里塞点，
      // 所以不会被误记成「球杆的多边形」
      if (pathPts.length >= 3) paths.push({ pts: pathPts.slice(), fill: ctx2d.fillStyle });
    },
    stroke() {
      if (pathPts.length >= 2) strokes.push(pathPts.slice());
    },
    /** 贴图是整张 drawImage 上去的：位置 / 尺寸直接从参数反推（补上当前 translate） */
    drawImage(img, dx, dy, dw, dh) {
      images.push({ img, dx: dx + tx, dy: dy + ty, dw, dh });
    },
  };

  /**
   * 渲染层里的 new Image()：补一个假的，赋 src 时同步触发 onload，
   * 让渲染层走「贴图已就绪」的真实分支，而不是 ellipse 兜底分支。
   */
  class FakeImage {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.width = 448;
      this.height = 521;
      this.naturalWidth = 448;
      this.naturalHeight = 521;
      this._src = '';
    }
    get src() {
      return this._src;
    }
    set src(value) {
      this._src = value;
      if (this.onload) this.onload();
    }
  }

  /**
   * 渲染层里的 new Audio()：补一个假的，赋 src 时同步派发事件，
   * 跟 FakeImage 一个套路。
   *   · 文件名不在 missingAudio 里 → 派发 loadeddata（模拟「解码完成，能用」）
   *   · 在 missingAudio 里       → 派发 error（模拟 file:// 下文件不存在）
   * 渲染层就是靠这两个事件挑出「用哪个扩展名」以及「到底有没有音频」的。
   *
   * 另外补了 paused / play() / pause() / ended，因为按钮是播放·停止开关：
   * 测试要能观察「到底在响没有」，也要能模拟「自然播完」。
   */
  const audioInstances = [];
  class FakeAudio {
    constructor() {
      this.preload = '';
      this.currentTime = 0;
      this.paused = true;
      this.ended = false;
      this.plays = 0;
      this.pauses = 0;
      this._src = '';
      this._listeners = new Map();
      audioInstances.push(this);
    }
    get src() {
      return this._src;
    }
    set src(value) {
      this._src = value;
      if (missingAudio.has(value)) this._emit('error');
      else this._emit('loadeddata');
    }
    addEventListener(type, fn, options) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push({ fn, once: !!(options && options.once) });
    }
    _emit(type) {
      const list = this._listeners.get(type) || [];
      // 先摘掉 once 监听，再回调：避免回调里又改监听列表把自己绕进去
      this._listeners.set(
        type,
        list.filter((entry) => !entry.once),
      );
      for (const entry of list) entry.fn();
    }
    play() {
      this.plays++;
      if (failPlay) {
        // 真实的 play() 是在微任务里回调 catch 的，而整个冒烟测试是同步的，
        // 用这个同步 thenable 才能观察到渲染层的「回滚成播放态」。
        return {
          catch: (fn) => {
            fn(new Error('NotAllowedError: play() rejected'));
            return this;
          },
        };
      }
      this.paused = false;
      this.ended = false;
      this._emit('playing');
      return Promise.resolve();
    }
    pause() {
      this.pauses++;
      this.paused = true;
      this._emit('pause');
    }
    /** 测试用：模拟音频自然播完 */
    finish() {
      this.paused = true;
      this.ended = true;
      this._emit('ended');
    }
  }

  const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx2d };

  // 设置面板里用到的那几个 DOM 节点
  function fakeElement(id, rect) {
    const handlers = new Map();
    const classes = new Set();
    return {
      id,
      // 渲染层的 isFromMenu() 用 nodeType 做鸭子类型判断，假元素也得像那么回事
      nodeType: 1,
      hidden: false,
      value: '',
      checked: false,
      textContent: '',
      min: '',
      max: '',
      step: '',
      style: {},
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        /** 渲染层用 toggle(name, force) 同步状态，第二个参数必须支持 */
        toggle: (name, force) => {
          const want = force === undefined ? !classes.has(name) : !!force;
          if (want) classes.add(name);
          else classes.delete(name);
          return want;
        },
        toString: () => [...classes].join(' '),
      },
      _handlers: handlers,
      /** 子节点集合，供 contains() 判断「事件是不是从面板里来的」 */
      _children: new Set(),
      addEventListener(type, fn) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(fn);
      },
      /** 测试里手动触发面板事件 */
      fire(type, event = {}) {
        for (const fn of handlers.get(type) || []) fn(event);
      },
      getBoundingClientRect() {
        return rect;
      },
      /** 自身或任意子节点都算「在面板里」——渲染层靠它把面板的点击拦下来 */
      contains(node) {
        return node === this || this._children.has(node);
      },
    };
  }

  // 面板真实尺寸：宽度是 CSS 里写死的 232px，高度是内容撑出来的。
  // 真机实测约 260px（不含台球模式那一行）。加了勾选行 + 模式说明之后会再高一点，
  // 渲染层每次都拿 getBoundingClientRect() 现场量，所以这里给个近似值就够了 ——
  // 冒烟测试只用它来验「贴着小球定位 + 完整落在视口内」这段数学。
  const MENU_W = 232;
  const MENU_H = 300;

  const menuEl = fakeElement('menu', {
    left: 0,
    top: 0,
    width: MENU_W,
    height: MENU_H,
    right: MENU_W,
    bottom: MENU_H,
  });
  menuEl.hidden = true;
  const zeros = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 });
  const elements = {
    stage: canvas,
    menu: menuEl,
    speed: fakeElement('speed', zeros()),
    size: fakeElement('size', zeros()),
    'speed-value': fakeElement('speed-value', zeros()),
    'size-value': fakeElement('size-value', zeros()),
    'menu-close': fakeElement('menu-close', zeros()),
    resume: fakeElement('resume', zeros()),
    laugh: fakeElement('laugh', zeros()),
    'laugh-hint': fakeElement('laugh-hint', zeros()),
    billiard: fakeElement('billiard', zeros()),
    'billiard-hint': fakeElement('billiard-hint', zeros()),
    hint: fakeElement('hint', zeros()),
  };
  // 把面板的子节点挂上去，这样 isFromMenu() 才认得出「点的是面板里的东西」
  menuEl._children = new Set([
    elements.speed,
    elements.size,
    elements['speed-value'],
    elements['size-value'],
    elements['menu-close'],
    elements.resume,
    elements.laugh,
    elements['laugh-hint'],
    elements.billiard,
    elements['billiard-hint'],
    elements.hint,
  ]);
  // 与 index.html 一致：这条提示默认是藏着的，只有找不到音频文件时才露出来
  elements['laugh-hint'].hidden = true;
  // 台球模式的说明默认也是藏着的（跟 index.html 里的 hidden 对齐）
  elements['billiard-hint'].hidden = true;

  /**
   * 「停稳开应用」用的假桥接。
   *
   * ★ readDesktopIcons 返回的是**同步 thenable**，不是真 Promise。
   *   整个 smoke 测试是一个同步脚本：真 Promise 的回调是微任务，要等整个脚本
   *   跑完才会执行，那断言就永远看不到结果了。同步 thenable 一样会调用渲染层的
   *   .then(cb)，覆盖到那段逻辑，同时让测试保持完全同步、逐次可复现。
   */
  const iconState = {
    /** 固定返回这份列表 */
    list: [],
    /** 按「读取那一刻小球的绘制位置」现算列表 —— 这样测试不用去算落点 */
    fromBall: null,
    /** true 时只走 catch，模拟读图标失败 */
    fail: false,
    /** 在 then 回调**之前**执行，用来模拟「IPC 还没回来，球已经被挪走了」 */
    beforeResolve: null,
    reads: 0,
    launches: [],
  };

  const win = {
    innerWidth: W,
    innerHeight: H,
    devicePixelRatio: 1,
    addEventListener(type, fn) {
      if (!windowHandlers.has(type)) windowHandlers.set(type, []);
      windowHandlers.get(type).push(fn);
    },
    ballAPI: {
      setInteractive(value) {
        interactiveCalls.push(value);
      },
      onPaused(handler) {
        subscriptions.paused.push(handler);
        return () => {};
      },
      onReset(handler) {
        subscriptions.reset.push(handler);
        return () => {};
      },
      onLayoutChanged(handler) {
        subscriptions.layout.push(handler);
        return () => {};
      },
      readDesktopIcons() {
        iconState.reads++;
        if (iconState.fail) {
          return {
            then() {
              return {
                catch(onErr) {
                  onErr(new Error('stub: 读桌面图标失败'));
                },
              };
            },
          };
        }
        return {
          then(onOk) {
            if (iconState.beforeResolve) iconState.beforeResolve();
            const source = iconState.fromBall
              ? iconState.fromBall(api.ball())
              : iconState.list;
            onOk(source.map((icon) => Object.assign({}, icon)));
            return { catch() {} };
          },
        };
      },
      launchDesktopIcon(name) {
        iconState.launches.push(name);
        return {
          then(onOk) {
            onOk({ ok: true });
            return { catch() {} };
          },
        };
      },
    },
  };

  const doc = {
    getElementById: (id) => elements[id] ?? null,
    addEventListener(type, fn) {
      if (!docHandlers.has(type)) docHandlers.set(type, []);
      docHandlers.get(type).push(fn);
    },
  };

  const sandbox = {
    window: win,
    document: doc,
    Math: seededMath,
    Image: FakeImage,
    Audio: FakeAudio,
    performance: { now: () => now },
    requestAnimationFrame: (cb) => {
      rafCallback = cb;
      return 1;
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(RENDERER, 'utf8'), sandbox, { filename: RENDERER });

  /**
   * 组装一帧的小球状态。
   * a / b 是贴图**自身**（未旋转）的半宽 / 半高；
   * rx / ry 是**旋转后**的轴对齐外接框半宽 / 半高 —— 碰撞用的是这一对。
   * 两者满足 rx² + ry² = a² + b²，这是个与旋转角无关的不变量。
   */
  function ballState(x, y, a, b) {
    const spin = spins.length ? spins[0] : 0;
    const c = Math.cos(spin);
    const s = Math.sin(spin);
    return {
      x,
      y,
      a,
      b,
      spin,
      r: a, // 兼容按「名义半径」写的旧断言
      rx: Math.hypot(a * c, b * s),
      ry: Math.hypot(a * s, b * c),
    };
  }

  // ------------------------------------------------------------------ 驱动器
  const api = {
    /** 前进一帧（默认 1/60 秒） */
    step(dt = FRAME) {
      now += dt;
      const cb = rafCallback;
      rafCallback = null;
      cb(now);
    },
    stepMany(count, dt = FRAME) {
      for (let i = 0; i < count; i++) api.step(dt);
    },
    /**
     * 从 draw() 的 drawImage 反推小球状态。
     * 注意 draw() 是「先 translate 到球心、再 rotate」，所以 drawImage 里的
     * dw / dh 是**贴图自身**的宽高（旋转不影响它），坐标点已经换算回绝对坐标。
     */
    ball() {
      const d = images[0];
      if (d) {
        return ballState(d.dx + d.dw / 2, d.dy + d.dh / 2, d.dw / 2, d.dh / 2);
      }
      // 贴图未就绪时走兜底椭圆分支
      const first = arcs[0];
      if (!first) throw new Error('本帧没有绘制小球');
      return ballState(first.x, first.y, first.r, first.ry);
    },
    /** 当前绘制用的贴图地址（空串表示走的是兜底椭圆） */
    spriteSrc() {
      return images.length ? images[0].img.src : '';
    },
    fire(target, type, event) {
      const handlers = (target === 'window' ? windowHandlers : docHandlers).get(type) || [];
      for (const fn of handlers) fn(event);
    },
    mouse(type, x, y, button = 0, target = null) {
      api.fire('window', type, { clientX: x, clientY: y, button, target, preventDefault() {} });
    },
    /** 面板上的事件（滑块 input、按钮 click、pointerdown） */
    el(id) {
      return elements[id];
    },
    /** 本帧 fill() 出来的多边形（台球模式的杆身 + 皮头）。空数组 = 屏幕上没有球杆 */
    cuePaths() {
      return paths;
    },
    /** 本帧 stroke() 出来的折线（台球模式的瞄准虚线） */
    cueStrokes() {
      return strokes;
    },
    panelEvent(id, type, event = {}) {
      elements[id].fire(type, event);
    },
    /**
     * 完整地在面板里的某个元素上点一下：
     * 依次派发 mousedown / mouseup（带 target，模拟事件从面板冒泡上来）+ click。
     * 用来验证「面板里的点击不会被小球那套按压逻辑截走」。
     */
    clickInside(id, x = 0, y = 0) {
      const target = elements[id];
      // 真实浏览器里 mousedown 之前会先来 pointerdown，面板靠它标记「正在操作面板」
      menuEl.fire('pointerdown', { target });
      api.mouse('mousedown', x, y, 0, target);
      api.mouse('mouseup', x, y, 0, target);
      api.fire('window', 'pointerup', { target });
      api.panelEvent(id, 'click', { target });
    },
    /** 渲染层最后创建的那个音频对象（笑声文件探测的产物） */
    audio() {
      return audioInstances.length ? audioInstances[audioInstances.length - 1] : null;
    },
    /** 渲染层探测/播放用过的所有音频对象 */
    audios() {
      return audioInstances;
    },
    menuOpen() {
      return menuEl.hidden === false;
    },
    menuBox() {
      const left = Number.parseFloat(menuEl.style.left);
      const top = Number.parseFloat(menuEl.style.top);
      return {
        left,
        top,
        width: MENU_W,
        height: MENU_H,
        right: left + MENU_W,
        bottom: top + MENU_H,
      };
    },
    /** 模拟「鼠标停在某处不动」 */
    hover(x, y) {
      api.mouse('mousemove', x, y);
    },
    interactive() {
      return interactiveCalls.length ? interactiveCalls[interactiveCalls.length - 1] : false;
    },
    resetCalls() {
      interactiveCalls.length = 0;
    },
    main(channel, ...args) {
      for (const handler of subscriptions[channel]) handler(...args);
    },
    // ------------------------------------------------ 停稳开应用的观测 / 摆布
    /** 摆好「读桌面图标」要返回的内容（固定列表） */
    setIcons(list) {
      iconState.list = list || [];
      iconState.fromBall = null;
      return api;
    },
    /**
     * 让图标列表在**读取那一刻**按小球实际位置生成。
     * 好处是测试完全不用去算「这一杆会停在哪」—— 直接把图标摆到球底下就行。
     */
    setIconsFromBall(fn) {
      iconState.fromBall = fn;
      iconState.list = [];
      return api;
    },
    setIconReadError(on) {
      iconState.fail = !!on;
      return api;
    },
    setBeforeIconResolve(fn) {
      iconState.beforeResolve = fn;
      return api;
    },
    /** 一共去读了桌面图标几次 */
    iconReads() {
      return iconState.reads;
    },
    /** 被请求启动的图标名，按顺序 */
    launchCalls() {
      return iconState.launches;
    },
    /** 本帧画出来的高亮框（正方形）+ 名字牌（长方形） */
    launchRects() {
      return roundRects;
    },
    /** 本帧的倒计时环 */
    launchArcs() {
      return ringArcs;
    },
    /** 本帧画出来的文字 */
    launchLabels() {
      return texts;
    },
    get time() {
      return now;
    },
    get W() {
      return W;
    },
    get H() {
      return H;
    },
  };

  return api;
}

// --------------------------------------------------------------------- 断言helper
let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

function speedOf(h, frames = 4) {
  const before = h.ball();
  h.stepMany(frames);
  const after = h.ball();
  return Math.hypot(after.x - before.x, after.y - before.y) / frames;
}

/**
 * 真实速率：逐帧测位移取最大值。
 * 撞墙那一帧的位移会被夹短，取最大值就绕开了这个干扰。
 */
function trueSpeed(h, probes = 6) {
  let best = 0;
  for (let i = 0; i < probes; i++) {
    const before = h.ball();
    h.step();
    const after = h.ball();
    best = Math.max(best, Math.hypot(after.x - before.x, after.y - before.y));
  }
  return best;
}

/** 采样一段轨迹，返回每帧位移（即当帧速度） */
function trail(h, frames) {
  const points = [h.ball()];
  for (let i = 0; i < frames; i++) {
    h.step();
    points.push(h.ball());
  }
  const deltas = [];
  for (let i = 0; i < points.length - 1; i++) {
    deltas.push({ x: points[i + 1].x - points[i].x, y: points[i + 1].y - points[i].y });
  }
  return { points, deltas };
}

// --------------------------------------------------------------------- 用例
console.log('\n奶球 · 渲染层冒烟测试\n');

// ---- 1. 边界反弹 -----------------------------------------------------------
{
  console.log('[1] 四边反弹 / 不出屏 / 偏离法线');
  const h = createHarness();
  const { W, H } = h;
  h.stepMany(3);

  const { points, deltas } = trail(h, 2400);

  let escaped = 0;
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const p of points) {
    // 竖直方向必须用 ry：蛋比圆高，拿 rx 判会漏掉上下出屏
    if (p.x - p.rx < -0.5 || p.x + p.rx > W + 0.5) escaped++;
    if (p.y - p.ry < -0.5 || p.y + p.ry > H + 0.5) escaped++;
    if (p.x - p.rx < 1) minX++;
    if (p.x + p.rx > W - 1) maxX++;
    if (p.y - p.ry < 1) minY++;
    if (p.y + p.ry > H - 1) maxY++;
  }

  check('2400 帧内小球从未出屏', () => assert.strictEqual(escaped, 0));
  check('四个方向都发生过反弹', () =>
    assert.ok(minX > 0 && maxX > 0 && minY > 0 && maxY > 0, `左${minX} 右${maxX} 上${minY} 下${maxY}`));

  // 每帧位移的模长 ≈ 当帧速率。撞墙那一帧会被「夹回边界」修正，模长明显偏小；
  // 拿中位数当基准，就能把这种被污染的帧挑出来绕开。
  const mags = deltas.map((d) => Math.hypot(d.x, d.y));
  const sortedMags = [...mags].sort((a, b) => a - b);
  const medMag = sortedMags[sortedMags.length >> 1];
  const isClean = (i) => i >= 0 && i < deltas.length && mags[i] > 0.9 * medMag;

  // 撞墙那一帧（记作 c）的位移被边界夹紧修正过，直接拿去算角度 / 速率都会偏，
  // 所以入射取 deltas[c-1]、出射取 deltas[c+1]，两侧都是干净的自由飞行帧。
  //
  // 麻烦在于 c 到底是翻转点的前一个还是后一个：
  //   · 不旋转时：夹紧只是把球往回拉一点，位移方向不变 → 翻转发生在 c → c+1，
  //     检测到的 i 就是 c 本身；
  //   · 旋转时：外接框变宽，墙把球推回的距离可能超过它自己前进的距离，
  //     夹紧帧的位移方向直接翻过来 → 翻转发生在 c-1 → c，检测到的 i 是 c-1。
  // 两种情况下 c 都是 {i, i+1} 里**模长更小**的那一个（夹紧只会让位移变小），
  // 所以按模长取就同时兼容两种情况。
  const deviations = [];
  const speeds = [];
  for (let i = 1; i < deltas.length - 2; i++) {
    const flippedX =
      Math.sign(deltas[i].x) !== Math.sign(deltas[i + 1].x) && deltas[i].x !== 0 && deltas[i + 1].x !== 0;
    const flippedY =
      Math.sign(deltas[i].y) !== Math.sign(deltas[i + 1].y) && deltas[i].y !== 0 && deltas[i + 1].y !== 0;
    // 两只轴同时翻转 = 撞角落，速度是两次旋转叠加，口径不干净，丢掉
    if (flippedX === flippedY) continue;

    const normal = flippedX ? 'x' : 'y';
    const other = flippedX ? 'y' : 'x';

    const c = mags[i] <= mags[i + 1] ? i : i + 1;
    const a = c - 1;
    const b = c + 1;
    // 夹紧影响超过一帧（例如贴着墙连续弹），这一段口径不干净，丢掉
    if (!isClean(a) || !isClean(b)) continue;
    // 两侧必须真的是「反了向」
    if (Math.sign(deltas[a][normal]) === Math.sign(deltas[b][normal])) continue;

    const incoming = deltas[a];
    const outgoing = deltas[b];

    const angleFromWall = (v) => Math.atan2(Math.abs(v[other]), Math.abs(v[normal]));
    deviations.push(Math.abs(angleFromWall(outgoing) - angleFromWall(incoming)));
    speeds.push({
      in: Math.hypot(incoming.x, incoming.y),
      out: Math.hypot(outgoing.x, outgoing.y),
    });
  }

  const avgDev = deviations.reduce((a, b) => a + b, 0) / deviations.length;
  const maxDev = Math.max(...deviations);
  const worstSpeed = Math.max(...speeds.map((s) => Math.abs(s.out - s.in)));

  check(
    `采集到足够多的反弹样本（${deviations.length} 次）`,
    () => assert.ok(deviations.length > 4, `样本 ${deviations.length}`),
  );
  check(
    `反弹角度偏离法线（平均 ${avgDev.toFixed(3)} rad ≈ ${((avgDev * 180) / Math.PI).toFixed(1)}°）`,
    () => assert.ok(avgDev > 0.08, `平均偏离 ${avgDev.toFixed(3)} rad`),
  );
  check(`偏离量不超过设定上限 0.45rad（最大 ${maxDev.toFixed(3)}）`, () =>
    assert.ok(maxDev <= 0.46, `最大偏离 ${maxDev.toFixed(3)} rad`));
  check(`反弹是纯旋转，速率不变（最大变化 ${worstSpeed.toExponential(1)}）`, () =>
    assert.ok(worstSpeed < 0.01, `最大速率变化 ${worstSpeed.toFixed(4)}`));
}

// ---- 2. 悬停切换穿透 -------------------------------------------------------
{
  console.log('\n[2] 悬停切换鼠标穿透');
  const h = createHarness();
  h.stepMany(2);

  const ball = h.ball();
  h.resetCalls();
  h.mouse('mousemove', ball.x, ball.y);
  check('鼠标进入小球 → setInteractive(true)', () => assert.strictEqual(h.interactive(), true));

  h.resetCalls();
  h.mouse('mousemove', 5, 5);
  check('鼠标移开 → setInteractive(false)', () => assert.strictEqual(h.interactive(), false));

  // 小球自己飘到光标下方时，每帧重算也要能重新打开交互
  h.mouse('mousemove', 500, 350);
  h.fire('document', 'mouseleave', {});
  check('指针离开窗口 → 立刻恢复穿透', () => assert.strictEqual(h.interactive(), false));
}

// ---- 3. 单击 = 停下 + 弹出设置面板 -----------------------------------------
{
  console.log('\n[3] 单击小球 = 停下 + 弹出设置面板（且不再换色）');
  // 用超大画布，保证这段测试里小球绝不会撞墙、速度读数干净
  const h = createHarness(HUGE);
  h.stepMany(2);
  h.main('reset');
  h.stepMany(70); // 等初始脉冲衰减完，此时半径精确等于 24

  const radiusIdle = h.ball().r;
  check('球扩大一倍后半径 24（水平 48px / 竖直约 56px）', () =>
    assert.ok(Math.abs(radiusIdle - 24) < 0.01, `实测 ${radiusIdle.toFixed(3)}`));
  check('贴图是蛋形：竖直半高 = 半宽 × 宽高比', () => {
    // 用贴图自身的半宽 / 半高（a / b）：rx / ry 是旋转后的外接框，会随角度摆动，
    // 拿它们的比值去比宽高比只在 spin = 0 时成立
    const b = h.ball();
    assert.ok(Math.abs(b.b / b.a - 521 / 448) < 0.01, `b/a = ${(b.b / b.a).toFixed(4)}`);
  });
  check('小球由贴图 ball-sprite.png 绘制', () => {
    const src = h.spriteSrc();
    assert.ok(/ball-sprite\.png$/.test(src), `实际 src=${src || '(空)'}`);
  });

  const baseSpeed = speedOf(h, 4);
  check('初始速度约等于默认常态速度 6', () =>
    assert.ok(Math.abs(baseSpeed - 6) < 0.3, `实测 ${baseSpeed.toFixed(3)}`));

  const spriteBefore = h.spriteSrc();
  check('点击前面板是关着的', () => assert.strictEqual(h.menuOpen(), false));

  const ball = h.ball();
  h.mouse('mousedown', ball.x, ball.y);
  h.stepMany(4); // 按住 66ms < 100ms 长按阈值
  h.mouse('mouseup', ball.x, ball.y);
  h.step();

  check('单击后小球停下', () => assert.ok(trueSpeed(h, 3) < 0.01, `实测 ${trueSpeed(h, 1).toFixed(3)}`));
  check('单击后弹出设置面板', () => assert.strictEqual(h.menuOpen(), true));
  check('触发了缩放脉冲作为反馈', () =>
    assert.ok(h.ball().r > 24, `24 → ${h.ball().r.toFixed(1)}`));

  h.stepMany(30);
  check('单击不再改变外观（贴图始终是同一张）', () =>
    assert.strictEqual(h.spriteSrc(), spriteBefore));

  // 再点一次应该收起面板
  h.mouse('mousedown', ball.x, ball.y);
  h.mouse('mouseup', ball.x, ball.y);
  h.step();
  check('再次单击收起面板', () => assert.strictEqual(h.menuOpen(), false));
}

// ---- 4. 短按后移动 → 按压作废 ----------------------------------------------
{
  console.log('\n[4] 短按后移动了 → 本次按压作废');
  const h = createHarness(HUGE);
  h.stepMany(2);
  h.main('reset');
  h.stepMany(30);

  const b = h.ball();
  h.mouse('mousedown', b.x, b.y);
  h.stepMany(3); // 65ms，远没到长按阈值
  h.mouse('mousemove', b.x + 140, b.y); // 直接甩开
  h.stepMany(3);

  check('没有误进入拖拽（小球没跟到指针处）', () => {
    const cur = h.ball();
    assert.ok(Math.abs(cur.x - (b.x + 140)) > 80, `球 x=${cur.x.toFixed(1)}，指针 x=${(b.x + 140).toFixed(1)}`);
  });
  check('没有误弹出面板', () => assert.strictEqual(h.menuOpen(), false));

  h.mouse('mouseup', b.x + 140, b.y);
  check('松手也不弹面板', () => assert.strictEqual(h.menuOpen(), false));
  check('小球带着原速度继续飞', () => assert.ok(trueSpeed(h, 3) > 4, `实测 ${trueSpeed(h, 1).toFixed(2)}`));
}

// ---- 5. 长按才能拖拽，且不越界 ---------------------------------------------
{
  console.log('\n[5] 长按 0.1s 才能拖拽，拖拽时不越界');
  const h = createHarness();
  const { W, H } = h;
  h.stepMany(2);

  const b = h.ball();
  h.mouse('mousedown', b.x, b.y);

  // 长按阈值之内怎么动都不该跟手
  h.mouse('mousemove', b.x + 60, b.y);
  h.stepMany(2);
  check('长按阈值内移动不跟手', () => {
    // 小球会继续自己飞（这是对的），关键是它没有被拽到指针处
    const cur = h.ball();
    const dist = Math.hypot(cur.x - (b.x + 60), cur.y - b.y);
    assert.ok(dist > 30, `小球离指针只有 ${dist.toFixed(1)}px`);
  });

  h.stepMany(20); // 越过 100ms
  const probes = [
    [-500, -500],
    [W + 500, -500],
    [W + 500, H + 500],
    [-500, H + 500],
    [0, 0],
  ];

  let escaped = 0;
  for (const [px, py] of probes) {
    h.mouse('mousemove', px, py);
    h.step();
    const cur = h.ball();
    if (cur.x - cur.rx < -0.5 || cur.x + cur.rx > W + 0.5) escaped++;
    if (cur.y - cur.ry < -0.5 || cur.y + cur.ry > H + 0.5) escaped++;
  }
  check('拖到屏幕外时被夹在边界内', () => assert.strictEqual(escaped, 0));

  h.mouse('mouseup', 0, 0);
  check('松手后恢复穿透判定', () => {
    h.resetCalls();
    h.step();
    assert.strictEqual(h.interactive(), false);
  });
}

// ---- 6. 长按拖拽抛出的速度上限 ---------------------------------------------
{
  console.log('\n[6] 长按拖拽松手抛出（速度上限 25）');
  const h = createHarness(HUGE);
  h.stepMany(2);

  const b = h.ball();
  h.mouse('mousedown', b.x, b.y);
  h.stepMany(20); // 越过长按阈值，进入拖拽

  // 模拟一次很快的甩动：每 16ms 移动 40px（≈ 42 px/帧，远超上限）
  let cx = b.x;
  const cy = b.y;
  for (let i = 0; i < 6; i++) {
    cx += 40;
    h.step(16);
    h.mouse('mousemove', cx, cy);
  }
  h.mouse('mouseup', cx, cy);

  // 注意：拖拽期间「绘制位置」总比指针慢一帧，所以先空跑一帧再采样，
  // 否则会把拖拽的 40px 位移算进来
  h.step();
  const settled = h.ball();
  h.step();
  const flown = h.ball();
  const thrown = Math.hypot(flown.x - settled.x, flown.y - settled.y);
  check('抛出速度被钳制在 25 以内', () => assert.ok(thrown <= 25.01, `实测 ${thrown.toFixed(3)}`));
  check('抛出速度确实接近上限（甩得够快）', () =>
    assert.ok(thrown > 20, `实测 ${thrown.toFixed(3)}`));

  // 反向甩动应该朝反方向飞
  const h2 = createHarness(HUGE);
  h2.stepMany(2);
  const b2 = h2.ball();
  h2.mouse('mousedown', b2.x, b2.y);
  h2.stepMany(20);
  let x2 = b2.x;
  const y2 = b2.y;
  for (let i = 0; i < 6; i++) {
    x2 -= 30;
    h2.step(16);
    h2.mouse('mousemove', x2, y2);
  }
  h2.mouse('mouseup', x2, y2);
  const before = h2.ball();
  h2.step(1);
  const after = h2.ball();
  check('向左甩 → 小球向左飞', () => assert.ok(after.x < before.x, `Δx=${(after.x - before.x).toFixed(2)}`));
}

// ---- 7. 抛出后减速回落 -----------------------------------------------------
{
  console.log('\n[7] 抛出后速度逐渐回落常态（6 px/帧）');
  const BASE = 6;
  const h = createHarness(HUGE);
  h.stepMany(2);

  // 甩到速度上限
  const b = h.ball();
  h.mouse('mousedown', b.x, b.y);
  h.stepMany(20); // 越过长按阈值
  let cx = b.x;
  const cy = b.y;
  for (let i = 0; i < 6; i++) {
    cx += 40;
    h.step(16);
    h.mouse('mousemove', cx, cy);
  }
  h.mouse('mouseup', cx, cy);
  h.step();

  const t0 = trueSpeed(h, 3);
  check('起步接近上限 25', () => assert.ok(t0 > 20, `实测 ${t0.toFixed(2)}`));

  h.stepMany(60); // 1s
  const t1 = trueSpeed(h, 3);
  h.stepMany(60); // 2s
  const t2 = trueSpeed(h, 3);
  h.stepMany(120); // 4s
  const t4 = trueSpeed(h, 3);
  h.stepMany(180); // 7s
  const t7 = trueSpeed(h, 3);

  check('1s 后已经明显减速', () => assert.ok(t1 < t0 - 5, `${t0.toFixed(2)} → ${t1.toFixed(2)}`));
  check('减速过程单调下降', () =>
    assert.ok(t0 > t1 && t1 > t2 && t2 > t4, `${t0.toFixed(2)} > ${t1.toFixed(2)} > ${t2.toFixed(2)} > ${t4.toFixed(2)}`));
  check('期间不会低于常态速度', () => assert.ok(t4 >= BASE - 0.01, `实测 ${t4.toFixed(2)}`));
  check('约 4s 后接近常态速度', () => assert.ok(t4 < BASE + 0.8, `实测 ${t4.toFixed(2)}`));
  check('7s 后基本回到常态速度', () => assert.ok(Math.abs(t7 - BASE) < 0.2, `实测 ${t7.toFixed(2)}`));

  // 轻甩（低于常态速度）也应该被拉回常态，不会停死
  const h2 = createHarness(HUGE);
  h2.stepMany(2);
  const b2 = h2.ball();
  h2.mouse('mousedown', b2.x, b2.y);
  h2.stepMany(20); // 越过长按阈值
  let x2 = b2.x;
  const y2 = b2.y;
  for (let i = 0; i < 4; i++) {
    x2 += 3; // 每 16ms 挪 3px ≈ 3.1 px/帧
    h2.step(16);
    h2.mouse('mousemove', x2, y2);
  }
  h2.mouse('mouseup', x2, y2);
  h2.step();

  const slow0 = trueSpeed(h2, 3);
  h2.stepMany(240);
  const slow4 = trueSpeed(h2, 3);
  check('轻甩后速度偏低', () => assert.ok(slow0 < BASE, `实测 ${slow0.toFixed(2)}`));
  check('轻甩也会被拉回常态速度（不会停死）', () =>
    assert.ok(Math.abs(slow4 - BASE) < 0.5, `${slow0.toFixed(2)} → ${slow4.toFixed(2)}`));
}

// ---- 8. 设置面板 -----------------------------------------------------------
{
  console.log('\n[8] 设置面板：速度 / 大小滑块');
  const h = createHarness(HUGE);
  h.stepMany(2);
  h.main('reset');
  h.stepMany(40);

  // 单击小球打开面板
  const ball = h.ball();
  h.mouse('mousedown', ball.x, ball.y);
  h.mouse('mouseup', ball.x, ball.y);
  h.step();
  check('单击后排出了面板', () => assert.strictEqual(h.menuOpen(), true));

  // 面板应该贴着小球、且完整落在视口内
  const box = h.menuBox();
  check('面板定位在视口内', () =>
    assert.ok(
      box.left >= 8 && box.top >= 8 && box.right <= h.W - 8 && box.bottom <= h.H - 8,
      `left=${box.left} top=${box.top} right=${box.right} bottom=${box.bottom}`,
    ));

  // 打开时滑块应该回显当前值
  check('速度滑块回显当前常态速度', () => assert.strictEqual(h.el('speed').value, '6'));
  check('大小滑块回显当前半径', () => assert.strictEqual(h.el('size').value, '24'));
  check('大小数值按「宽 × 高」显示（贴图是蛋形，不是圆）', () =>
    assert.strictEqual(h.el('size-value').textContent, '48 × 56 px'));

  // 停着的小球，调速度应该直接带起来
  check('打开面板时小球是停的', () => assert.ok(trueSpeed(h, 2) < 0.01));
  h.el('speed').value = '16';
  h.panelEvent('speed', 'input');
  h.stepMany(3);
  check('把速度拉到 16 → 小球立刻以 16 运动', () => {
    const s = trueSpeed(h, 3);
    assert.ok(Math.abs(s - 16) < 0.6, `实测 ${s.toFixed(2)}`);
  });
  check('速度数值回显同步更新', () =>
    assert.strictEqual(h.el('speed-value').textContent, '16.0 px/帧'));

  // 速度调慢也应该生效
  h.el('speed').value = '3';
  h.panelEvent('speed', 'input');
  h.stepMany(420); // 指数衰减，从 16 掉到 3 大约要 6s
  check('把速度拉回 3 → 小球最终以 3 运动', () => {
    const s = trueSpeed(h, 3);
    assert.ok(Math.abs(s - 3) < 0.4, `实测 ${s.toFixed(2)}`);
  });

  // 大小滑块
  h.el('size').value = '40';
  h.panelEvent('size', 'input');
  h.stepMany(20); // 等缩放脉冲散掉
  check('把大小拉到 40 → 水平半径变成 40（宽 80 × 高 93 px）', () => {
    const r = h.ball().r;
    assert.ok(Math.abs(r - 40) < 0.5, `实测 ${r.toFixed(2)}`);
  });
  check('大小数值回显同步更新（宽 × 高）', () =>
    assert.strictEqual(h.el('size-value').textContent, '80 × 93 px'));

  // 调大之后不能越界
  h.el('size').value = '60';
  h.panelEvent('size', 'input');
  h.stepMany(20);
  check('半径调到上限 60 也不越界', () => {
    const b = h.ball();
    assert.ok(b.x - b.rx >= -0.5 && b.x + b.rx <= h.W + 0.5, `x=${b.x.toFixed(1)} rx=${b.rx.toFixed(1)}`);
    assert.ok(b.y - b.ry >= -0.5 && b.y + b.ry <= h.H + 0.5, `y=${b.y.toFixed(1)} ry=${b.ry.toFixed(1)}`);
  });

  // 速度拉到 0 → 小球停下；此时应该出现「让它动起来」按钮
  h.el('speed').value = '0';
  h.panelEvent('speed', 'input');
  h.stepMany(500); // 从 3 衰到 <0.01 大约要 8s
  check('速度拉到 0 → 小球停下', () => assert.ok(trueSpeed(h, 3) < 0.01));
  check('停下后出现「让它动起来」按钮', () => assert.strictEqual(h.el('resume').hidden, false));

  h.el('speed').value = '8';
  h.panelEvent('speed', 'input');
  h.stepMany(5);
  check('重新给速度 → 小球恢复运动', () => assert.ok(trueSpeed(h, 3) > 6, `实测 ${trueSpeed(h, 1).toFixed(2)}`));
  check('运动起来后按钮收起', () => assert.strictEqual(h.el('resume').hidden, true));

  // 悬停在面板上必须可交互，否则滑块根本拖不动
  const inside = { x: box.left + 20, y: box.top + 60 };
  h.resetCalls();
  h.hover(inside.x, inside.y);
  check('鼠标悬停在面板上 → 窗口可交互（否则滑块拖不动）', () =>
    assert.strictEqual(h.interactive(), true));

  // 关闭按钮
  h.panelEvent('menu-close', 'click');
  h.step();
  check('关闭按钮收起面板', () => assert.strictEqual(h.menuOpen(), false));

  h.resetCalls();
  h.hover(inside.x, inside.y);
  check('面板收起后，原面板区域恢复穿透', () => {
    const b = h.ball();
    // 蛋比圆高，判断「离得够远」要按竖直半径算
    const farFromBall = Math.hypot(inside.x - b.x, inside.y - b.y) > Math.max(b.rx, b.ry) + 20;
    assert.ok(farFromBall, '测试点位离小球太近，换一个位置');
    assert.strictEqual(h.interactive(), false);
  });
}

// ---- 9. 移动时贴图旋转（滚动关系） -----------------------------------------
{
  console.log('\n[9] 移动时贴图旋转（按「滚动」关系）');

  /** 角度差归一化到 (-π, π]：跨过 ±2π 回绕时也算得出正确的方向 / 大小 */
  const unwrap = (a, b) => {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };

  /**
   * 长按拖拽把球沿**水平**方向甩出去。
   * 横向甩 → vy ≈ 0，旋转就只由 vx 决定，方向断言才干净。
   * dirX = 1 向右、-1 向左。
   */
  function throwHorizontally(dirX) {
    const h = createHarness(HUGE);
    h.stepMany(2);
    const b = h.ball();
    h.mouse('mousedown', b.x, b.y);
    h.stepMany(20); // 越过 100ms 长按阈值 → 进入拖拽
    let cx = b.x;
    const cy = b.y;
    for (let i = 0; i < 6; i++) {
      cx += dirX * 40;
      h.step(16);
      h.mouse('mousemove', cx, cy);
    }
    h.mouse('mouseup', cx, cy);
    h.step(); // 收尾一帧，让贴图按抛出速度画一次
    return h;
  }

  const TURN = Math.PI * 2;
  const SPIN_WIDTHS = 9; // 必须与 renderer 里的 SPIN_WIDTHS_PER_TURN 保持一致

  // --- 方向：向右滚 = 顺时针（角度增大），向左滚 = 逆时针（角度减小）
  const right = throwHorizontally(1);
  const r0 = right.ball();
  right.stepMany(6);
  const r1 = right.ball();
  const dR = unwrap(r0.spin, r1.spin);
  check('向右飞 → 顺时针自转（角度增大）', () =>
    assert.ok(r1.x > r0.x && dR > 0.5, `Δx=${(r1.x - r0.x).toFixed(1)} Δspin=${dR.toFixed(3)}`));

  const leftThrow = throwHorizontally(-1);
  const l0 = leftThrow.ball();
  leftThrow.stepMany(6);
  const l1 = leftThrow.ball();
  const dL = unwrap(l0.spin, l1.spin);
  check('向左飞 → 逆时针自转（角度减小）', () =>
    assert.ok(l1.x < l0.x && dL < -0.5, `Δx=${(l1.x - l0.x).toFixed(1)} Δspin=${dL.toFixed(3)}`));

  // 持续转：每帧都推进（而不是只转一下就停）
  {
    let sum = 0;
    let prev = right.ball().spin;
    for (let i = 0; i < 30; i++) {
      right.step();
      const cur = right.ball().spin;
      sum += unwrap(prev, cur);
      prev = cur;
    }
    check('运动中持续自转（30 帧累计转过 90° 以上）', () =>
      assert.ok(Math.abs(sum) > Math.PI / 2, `累计 ${sum.toFixed(3)} rad`));
  }

  // --- 滚动比：每转过一整圈，水平方向正好滚过 SPIN_WIDTHS 个球宽
  {
    const h = throwHorizontally(1);
    const b0 = h.ball();
    let angle = 0;
    let prev = b0.spin;
    for (let i = 0; i < 20; i++) {
      h.step();
      const cur = h.ball().spin;
      angle += unwrap(prev, cur);
      prev = cur;
    }
    const b1 = h.ball();
    const widths = (b1.x - b0.x) / (b0.a * 2);
    const turns = angle / TURN;
    check('滚动比正确：滚过 1 圈 = 横向滚过 9 个球宽', () =>
      assert.ok(
        Math.abs(turns * SPIN_WIDTHS - widths) < 0.02,
        `转过 ${turns.toFixed(3)} 圈 → 折算 ${(turns * SPIN_WIDTHS).toFixed(4)} 个宽，实测 ${widths.toFixed(4)} 个宽`,
      ));
  }

  // --- 停下就不转（角度完全冻结）
  {
    const h = createHarness(HUGE);
    h.stepMany(2);
    const b = h.ball();
    h.mouse('mousedown', b.x, b.y);
    h.stepMany(4); // 66ms < 100ms：短按
    h.mouse('mouseup', b.x, b.y);
    h.step();

    const q0 = h.ball();
    h.stepMany(40);
    const q1 = h.ball();
    check('小球停下后不再自转（角度完全冻结）', () => {
      assert.ok(trueSpeed(h, 2) < 0.01, '小球其实没停下，这条断言就没意义');
      assert.ok(Math.abs(q1.spin - q0.spin) < 1e-9, `${q0.spin.toFixed(5)} → ${q1.spin.toFixed(5)}`);
    });
  }

  // --- 旋转后的外接框：rx² + ry² 恒等于 a² + b²，但 rx / ry 本身随角度摆动
  {
    const h = createHarness(HUGE);
    h.stepMany(2);
    h.main('reset');
    h.stepMany(80); // 等脉冲散尽，a / b 变成常量

    const first = h.ball();
    const invariant = first.a * first.a + first.b * first.b;
    let worst = 0;
    let minRx = Infinity;
    let maxRx = 0;
    for (let i = 0; i < 600; i++) {
      h.step();
      const b = h.ball();
      worst = Math.max(worst, Math.abs(b.rx * b.rx + b.ry * b.ry - invariant));
      minRx = Math.min(minRx, b.rx);
      maxRx = Math.max(maxRx, b.rx);
    }
    check('旋转后外接框满足 rx² + ry² = a² + b²（与角度无关）', () =>
      assert.ok(worst < 1e-9, `最大偏差 ${worst.toExponential(2)}`));
    check(
      `外接框确实随角度摆动（rx 在 ${minRx.toFixed(2)} ~ ${maxRx.toFixed(2)} 之间）`,
      () => assert.ok(maxRx - minRx > 1.5, `摆动幅度只有 ${(maxRx - minRx).toFixed(3)}px`),
    );
  }

  // --- 大球贴墙旋转：蛋尖转到侧面时外接框会变宽，
  //     这正是 ballRx / ballRy 存在的理由（不然 r=60 时能插进墙里约 10px）
  {
    const h = createHarness(SMALL);
    h.stepMany(2);
    h.main('reset');

    // 单击打开面板，把大小拉到上限、再给个速度让它跑起来
    const b = h.ball();
    h.mouse('mousedown', b.x, b.y);
    h.mouse('mouseup', b.x, b.y);
    h.step();
    h.el('size').value = '60';
    h.panelEvent('size', 'input');
    h.el('speed').value = '10';
    h.panelEvent('speed', 'input'); // 停着的小球调速度会立刻被带起来
    h.panelEvent('menu-close', 'click');
    h.stepMany(20); // 等缩放脉冲散掉

    let escaped = 0;
    let wallHits = 0;
    for (let i = 0; i < 1200; i++) {
      h.step();
      const cur = h.ball();
      if (cur.x - cur.rx < -0.5 || cur.x + cur.rx > h.W + 0.5) escaped++;
      if (cur.y - cur.ry < -0.5 || cur.y + cur.ry > h.H + 0.5) escaped++;
      if (cur.x - cur.rx < 1 || cur.x + cur.rx > h.W - 1) wallHits++;
    }
    check('半径 60 的大球贴着墙旋转，也没插进墙里', () =>
      assert.ok(escaped === 0 && wallHits > 0, `出屏 ${escaped} 次 / 贴墙 ${wallHits} 帧`));
  }
}

// ---- 10. 设置面板：笑声按钮（播放 / 停止 开关） ------------------------------
{
  console.log('\n[10] 设置面板：笑声按钮（播放 / 停止 开关）');

  /** 单击小球把面板打开（同时小球会被停下） */
  function openMenu(h) {
    h.stepMany(2);
    const b = h.ball();
    h.mouse('mousedown', b.x, b.y);
    h.mouse('mouseup', b.x, b.y);
    h.step();
    return h;
  }

  /** 面板关着时重新单击小球打开 */
  function reopenMenu(h) {
    const b = h.ball();
    h.mouse('mousedown', b.x, b.y);
    h.mouse('mouseup', b.x, b.y);
    h.step();
    return h;
  }

  const lbl = (h) => h.el('laugh').textContent;
  const playing = (h) => h.el('laugh').classList.contains('is-playing');
  const SOURCES = ['laugh.mp3', 'laugh.wav', 'laugh.ogg', 'laugh.m4a'];

  // --- 有音频：按钮在「播放笑声 / 停止大笑」两态之间切换
  {
    const h = openMenu(createHarness(HUGE));
    const audio = h.audio();

    check('面板里有笑声按钮，且确实挂在面板下面', () => {
      const btn = h.el('laugh');
      assert.ok(btn, '渲染层没取到 #laugh');
      // 挂在面板下才走得到 isFromMenu()，否则点击会被当成「点在桌面上」
      assert.ok(h.el('menu').contains(btn), '#laugh 不在面板里');
      // 按钮文案在标记里，假 DOM 看不到，顺手核对一下 index.html 别写漏
      const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
      assert.ok(/id="laugh"[^>]*>播放笑声</.test(html), 'index.html 里的按钮标记或文案对不上');
    });
    check('探测时就选中了 laugh.mp3 并预加载（点击不用等缓冲）', () => {
      assert.ok(audio, '渲染层没有创建音频对象');
      assert.strictEqual(audio.src, 'laugh.mp3');
      assert.strictEqual(audio.preload, 'auto');
      assert.strictEqual(h.audios().length, 1, '文件明明存在却多探测了几次');
    });
    check('音频就绪时不显示「缺少文件」提示', () =>
      assert.strictEqual(h.el('laugh-hint').hidden, true));
    check('初始状态是「播放笑声」', () => {
      assert.strictEqual(lbl(h), '播放笑声');
      assert.strictEqual(playing(h), false);
    });

    h.panelEvent('laugh', 'click');
    check('点击 → 开始播放，按钮变成「停止大笑」', () => {
      assert.strictEqual(audio.plays, 1);
      assert.strictEqual(audio.paused, false, '音频没有真的开始播');
      assert.strictEqual(lbl(h), '停止大笑');
      assert.ok(playing(h), '按钮没有进入播放态');
    });

    audio.currentTime = 2.5; // 假装已经播到第 2.5 秒
    h.panelEvent('laugh', 'click');
    check('再点一下 → 停止播放，按钮变回「播放笑声」', () => {
      assert.strictEqual(audio.pauses, 1);
      assert.strictEqual(audio.paused, true, '音频没有真的停下来');
      assert.strictEqual(lbl(h), '播放笑声');
      assert.strictEqual(playing(h), false);
    });
    check('停止时把进度拨回了开头（下次点才是从头播）', () =>
      assert.strictEqual(audio.currentTime, 0));

    h.panelEvent('laugh', 'click');
    check('停下之后还能再播，不是一次性的', () => {
      assert.strictEqual(audio.plays, 2);
      assert.strictEqual(audio.paused, false);
      assert.strictEqual(lbl(h), '停止大笑');
    });

    audio.finish(); // 自然播完（触发 ended）
    check('音频自然播完 → 按钮自己变回「播放笑声」', () => {
      assert.strictEqual(lbl(h), '播放笑声');
      assert.strictEqual(playing(h), false, '播完了按钮还挂着「停止大笑」');
    });
    check('播完之后再点，是重新开始播', () => {
      h.panelEvent('laugh', 'click');
      assert.strictEqual(audio.plays, 3);
      assert.strictEqual(audio.paused, false);
    });
  }

  // --- 面板里的点击不该被小球那套按压逻辑截走
  {
    const h = openMenu(createHarness(HUGE));
    const audio = h.audio();
    const before = audio.plays;

    // 完整点一次：pointerdown + mousedown / mouseup 都带 target，模拟真实冒泡
    h.clickInside('laugh', 100, 100);
    check('按钮上的完整点击只触发播放，不会被当成在点小球', () => {
      assert.strictEqual(audio.plays, before + 1, '没有触发播放');
      assert.strictEqual(h.menuOpen(), true, '面板被误关掉了');
      assert.ok(trueSpeed(h, 2) < 0.01, '小球被误当成「单击小球」了');
    });
  }

  // --- 面板关掉再开：按钮得跟真实播放状态一致
  {
    const h = openMenu(createHarness(HUGE));
    h.panelEvent('laugh', 'click');
    h.clickInside('menu-close', 10, 10);
    check('关掉面板不会掐断声音（声音和面板是两回事）', () => {
      assert.strictEqual(h.menuOpen(), false);
      assert.strictEqual(h.audio().paused, false);
    });

    reopenMenu(h);
    check('重新打开面板时按钮显示的是真实状态（停止大笑）', () =>
      assert.strictEqual(lbl(h), '停止大笑'));

    // 面板关着的时候播完了，再打开也不该还写着「停止大笑」
    h.clickInside('menu-close', 10, 10);
    h.audio().finish();
    reopenMenu(h);
    check('面板关着时播完了，重开也会变回「播放笑声」', () => assert.strictEqual(lbl(h), '播放笑声'));
  }

  // --- play() 被拒绝：按钮要滚回「播放笑声」，不能卡在停止态
  {
    const h = openMenu(createHarness(HUGE, { failPlay: true }));
    // 这次失败是**故意造出来的**，渲染层会老老实实 console.error 一条 ——
    // 临时把它按掉，免得测试输出里混进一段像报错的堆栈
    const realError = console.error;
    console.error = () => {};
    try {
      h.panelEvent('laugh', 'click');
    } finally {
      console.error = realError;
    }
    check('play() 失败时按钮滚回「播放笑声」，不会卡在「停止大笑」', () => {
      assert.strictEqual(h.audio().plays, 1, '没去尝试播放');
      assert.strictEqual(lbl(h), '播放笑声');
      assert.strictEqual(playing(h), false, '播放失败了按钮还停在停止态');
    });
  }

  // --- 只缺 mp3：自动退到下一个候选扩展名
  {
    const h = openMenu(createHarness(HUGE, { missingAudio: ['laugh.mp3'] }));
    check('只缺 laugh.mp3 → 自动改用 laugh.wav', () => {
      const a = h.audio();
      assert.ok(a, '渲染层没有创建音频对象');
      assert.strictEqual(a.src, 'laugh.wav', `实际用的是 ${a.src}`);
      assert.strictEqual(h.audios().length, 2, `探测次数不对：${h.audios().length}`);
    });
    check('退到可用文件之后就不再显示提示', () =>
      assert.strictEqual(h.el('laugh-hint').hidden, true));
    check('换成了 wav 也照样能播 / 能停', () => {
      h.panelEvent('laugh', 'click');
      assert.strictEqual(h.audio().plays, 1);
      assert.strictEqual(lbl(h), '停止大笑');
      h.panelEvent('laugh', 'click');
      assert.strictEqual(h.audio().pauses, 1);
      assert.strictEqual(lbl(h), '播放笑声');
    });
  }

  // --- 一个都没放：把说明显示出来，而不是静默失灵
  {
    const h = openMenu(createHarness(HUGE, { missingAudio: SOURCES }));
    check(`四个候选文件逐个都探测过（共 ${SOURCES.length} 次）`, () =>
      assert.strictEqual(h.audios().length, SOURCES.length, `实际探测了 ${h.audios().length} 次`));
    check('找不到音频时把说明显示出来（不静默失灵）', () => {
      assert.strictEqual(h.el('laugh-hint').hidden, false);
      assert.ok(h.el('laugh').classList.contains('is-missing'), '按钮没有进入告警态');
    });
    check('此时点击不会抛异常，也不会切换成「停止大笑」', () => {
      const n = h.audios().length;
      h.panelEvent('laugh', 'click');
      assert.strictEqual(h.audios().length, n, '又去创建音频对象了');
      assert.strictEqual(h.el('laugh-hint').hidden, false, '提示反而被藏起来了');
      assert.strictEqual(lbl(h), '播放笑声', '没有声音却切到了停止态');
      assert.strictEqual(playing(h), false);
    });
    check('小球照常工作，按钮没声音不影响其它功能', () => {
      h.clickInside('menu-close', 10, 10);
      assert.strictEqual(h.menuOpen(), false);
      assert.ok(trueSpeed(h, 2) < 0.01);
    });
  }
}

// --------------------------------------------------------------------- 台球工具
/** 必须与 renderer.ts 里的台球常量保持一致 */
const CUE = {
  MIN_PULL: 8,
  MAX_PULL: 120,
  MIN_SPEED: 3,
  MAX_SPEED: 25,
  LUNGE_MS: 90,
  HOLD_MS: 170,
  LENGTH: 190,
  DECEL: 0.15,
  AIM_RADIUS: 240,
  SHAFT_COLOR: '#111111',
  TIP_COLOR: '#e9e2cf',
};

/**
 * 「拉杆量 → 击球初速度」的预期值。渲染层里就是一条线性插值，
 * 这里独立算一遍：既能当断言的期望值，也顺手说明「改 CUE_MAX_PULL 曲线会自己跟着变」。
 * @param pull 拉杆量（px），调用方自己按 MAX_PULL 钳一下
 */
function expectedCueSpeed(pull) {
  const clamped = Math.min(Math.max(pull, 0), CUE.MAX_PULL);
  return CUE.MIN_SPEED + (clamped / CUE.MAX_PULL) * (CUE.MAX_SPEED - CUE.MIN_SPEED);
}

/** 勾上 / 取消勾选台球模式（等价于点面板里那个复选框） */
function setBilliards(h, on) {
  h.el('billiard').checked = on;
  h.panelEvent('billiard', 'change');
}

/**
 * 进入台球模式，并且等缩放脉冲散尽。
 * 脉冲会改变球的有效半径，算「杆头离球面多远」这类几何量之前必须等它归零，
 * 否则每一步都会带上一个随时间漂移的误差。
 */
function enterBilliards(h, settle = 24) {
  h.stepMany(2);
  setBilliards(h, true);
  h.stepMany(settle);
  return h;
}

/**
 * 从球杆的多边形里反推杆头和杆尾。
 * drawStick 的顶点顺序是 [A + perp*半宽A, B + perp*半宽B, B - perp*半宽B, A - perp*半宽A]，
 * 所以 A（杆头）= pts[0] 与 pts[3] 的中点，B（杆尾）= pts[1] 与 pts[2] 的中点。
 */
function cueEnds(path) {
  const p = path.pts;
  return {
    tip: { x: (p[0][0] + p[3][0]) / 2, y: (p[0][1] + p[3][1]) / 2 },
    butt: { x: (p[1][0] + p[2][0]) / 2, y: (p[1][1] + p[2][1]) / 2 },
  };
}

/**
 * 右键按住拉杆 → 松手 → 一直步进到小球动起来。
 * 返回击出瞬间那一帧的位移（就是初速度，误差只有一帧摩擦）。
 * 空杆（球杆没碰到球）返回 hit: false。
 */
function shoot(h, offsetX, offsetY, maxFrames = 60) {
  const b = h.ball();
  h.mouse('mousedown', b.x + offsetX, b.y + offsetY, 2);
  h.step();
  h.mouse('mouseup', b.x + offsetX, b.y + offsetY, 2);

  let prev = h.ball();
  for (let i = 0; i < maxFrames; i++) {
    h.step();
    const cur = h.ball();
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (Math.hypot(dx, dy) > 0.5) return { hit: true, speed: Math.hypot(dx, dy), dx, dy };
    prev = cur;
  }
  return { hit: false, speed: 0, dx: 0, dy: 0 };
}

/** 角度差归一化到 (-π, π]，跨过 ±2π 回绕也算得对 */
function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * 打一杆，然后一直步进到小球**彻底停死**，返回停稳后的小球状态。
 * 判停做得很直接：连续两帧绘制位置一模一样（速度归零后 ball.x 就不再变了）。
 */
function shootAndSettle(h, offsetX, offsetY, maxFrames = 3000) {
  const shot = shoot(h, offsetX, offsetY);
  if (!shot.hit) throw new Error('这一杆没打到球（空杆）');

  let prev = h.ball();
  let still = 0;
  for (let i = 0; i < maxFrames; i++) {
    h.step();
    const cur = h.ball();
    const moved = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    prev = cur;
    if (moved === 0) {
      still++;
      if (still >= 2) return cur;
    } else {
      still = 0;
    }
  }
  throw new Error(`小球在 ${maxFrames} 帧内没停下来`);
}

/** 一直步进到「启动被请求」为止；返回用掉的帧数，一直没启动返回 -1 */
function stepUntilLaunch(h, maxFrames = 600) {
  for (let i = 0; i < maxFrames; i++) {
    h.step();
    if (h.launchCalls().length) return i + 1;
  }
  return -1;
}

/** 取一帧里那个正方形的高亮框（名字牌是长条形，用它区分） */
function highlightBox(h) {
  return h.launchRects().find((r) => Math.abs(r.w - r.h) < 0.01) || null;
}

/** 「图标就摆在小球底下」—— 测试里最常用的摆法 */
function iconOnBall(b, over) {
  return Object.assign({ name: 'QQ', x: b.x - 24, y: b.y - 24, size: 48, launchable: true }, over);
}

// ---- 11. 台球模式：进入 / 静止 / 左键不拖 / 右键呼出球杆 ---------------------
{
  console.log('\n[11] 台球模式：勾上就静止 / 左键拖不动 / 右键呼出球杆');

  // --- 面板里真的有这个勾选项
  {
    const h = createHarness(HUGE);
    h.stepMany(2);
    const b = h.ball();
    h.mouse('mousedown', b.x, b.y);
    h.mouse('mouseup', b.x, b.y);
    h.step();

    check('面板里有「台球模式」勾选项，且挂在面板下面', () => {
      const box = h.el('billiard');
      assert.ok(box, '渲染层没取到 #billiard');
      assert.ok(h.el('menu').contains(box), '#billiard 不在面板里');
      // 文案和 input 标记都在 HTML 里，假 DOM 看不到，顺手核对一下别写漏
      const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
      assert.ok(/id="billiard"[^>]*type="checkbox"/.test(html), 'index.html 里的勾选框标记对不上');
      assert.ok(/台球模式/.test(html), 'index.html 里没有「台球模式」这几个字');
    });
    check('默认没勾上，模式说明藏着的、正常提示露着的', () => {
      assert.strictEqual(h.el('billiard').checked, false);
      assert.strictEqual(h.el('billiard-hint').hidden, true);
      assert.strictEqual(h.el('hint').hidden, false);
    });
  }

  // --- 勾上 → 小球立刻静止
  {
    const h = createHarness(HUGE);
    h.stepMany(2);
    const moving = trueSpeed(h, 3);
    check('勾之前小球确实是在动的', () => assert.ok(moving > 5, `实测 ${moving.toFixed(2)}`));

    setBilliards(h, true);
    h.step();

    check('勾上台球模式 → 小球立刻静止', () =>
      assert.ok(trueSpeed(h, 4) < 0.01, `实测 ${trueSpeed(h, 1).toFixed(3)}`));
    check('勾上之后模式说明露出来、正常提示收起来', () => {
      assert.strictEqual(h.el('billiard-hint').hidden, false);
      assert.strictEqual(h.el('hint').hidden, true);
    });

    h.stepMany(40);
    check('静静地待着不会自己动起来', () => assert.ok(trueSpeed(h, 4) < 0.01));
  }

  // --- 左键拖不动（长按也不行）
  {
    const h = createHarness();
    h.stepMany(2);
    setBilliards(h, true);
    h.stepMany(4);

    const b = h.ball();
    h.mouse('mousedown', b.x, b.y);
    h.stepMany(20); // 远越 100ms 长按阈值：正常模式下这里早该进拖拽了
    h.mouse('mousemove', b.x + 300, b.y + 200);
    h.stepMany(3);
    check('台球模式下长按左键也拖不走小球', () => {
      const cur = h.ball();
      const dist = Math.hypot(cur.x - (b.x + 300), cur.y - (b.y + 200));
      assert.ok(dist > 200, `小球离指针只有 ${dist.toFixed(1)}px`);
    });
    check('台球模式下小球完全不动', () => assert.ok(trueSpeed(h, 3) < 0.01));

    h.mouse('mouseup', b.x + 300, b.y + 200);
    h.step();
    check('松手只当成一次「单击小球」→ 弹出面板', () => assert.strictEqual(h.menuOpen(), true));
    check('这时候小球依旧静止', () => assert.ok(trueSpeed(h, 3) < 0.01));
  }

  // --- 右键呼出球杆
  {
    const h = enterBilliards(createHarness(HUGE));
    check('没按右键时屏幕上没有球杆', () => assert.strictEqual(h.cuePaths().length, 0));

    const b = h.ball();
    const px = b.x - 120; // 按在球的左边 → 球会被打向右边
    h.mouse('mousedown', px, b.y, 2);
    h.step();

    const cue = h.cuePaths();
    check('按下右键 → 球杆出现（黑色杆身 + 浅色皮头两个多边形）', () =>
      assert.strictEqual(cue.length, 2, `实际 ${cue.length} 个多边形`));
    check('杆身黑、皮头浅色', () => {
      assert.strictEqual(cue[0].fill, CUE.SHAFT_COLOR);
      assert.strictEqual(cue[1].fill, CUE.TIP_COLOR);
    });
    check('还画了一条瞄准虚线', () => assert.strictEqual(h.cueStrokes().length, 1));

    const ends = cueEnds(cue[0]);
    const ballNow = h.ball();
    check('杆头停在指针拉到的位置（离球心 = 指针距离）', () => {
      const d = Math.hypot(ends.tip.x - ballNow.x, ends.tip.y - ballNow.y);
      assert.ok(Math.abs(d - 120) < 0.5, `实测 ${d.toFixed(2)}，指针离球心 120`);
    });
    check(`球杆长 ${CUE.LENGTH}px`, () => {
      const len = Math.hypot(ends.butt.x - ends.tip.x, ends.butt.y - ends.tip.y);
      assert.ok(Math.abs(len - CUE.LENGTH) < 1, `实测 ${len.toFixed(2)}`);
    });
    check('球杆在球心的反方向上（杆在左，球会被打向右）', () => {
      assert.ok(ends.tip.x < ballNow.x, `杆头 x=${ends.tip.x.toFixed(1)}，球心 x=${ballNow.x.toFixed(1)}`);
      assert.ok(Math.abs(ends.tip.y - ballNow.y) < 0.5, `杆头竖直方向偏了 ${(ends.tip.y - ballNow.y).toFixed(2)}px`);
    });

    // 拖动指针 → 球杆跟着转
    h.mouse('mousemove', ballNow.x, ballNow.y - 150);
    h.step();
    const moved = cueEnds(h.cuePaths()[0]).tip;
    check('按住右键拖动 → 球杆跟着指针转过去', () => {
      assert.ok(moved.y < ballNow.y - 100, `杆头只挪到 y=${moved.y.toFixed(1)}`);
      assert.ok(Math.abs(moved.x - ballNow.x) < 1, `杆头横向偏了 ${(moved.x - ballNow.x).toFixed(2)}px`);
    });
    check('球杆摆好之前小球一直不动', () => assert.ok(trueSpeed(h, 3) < 0.01));
  }

  // --- 命中圈：只有勾上台球模式才把鼠标接管范围放大
  {
    const h = enterBilliards(createHarness());
    const b = h.ball();
    h.resetCalls();
    h.hover(b.x + 200, b.y);
    check('台球模式：球外 200px 也接管鼠标（否则收不到右键）', () =>
      assert.strictEqual(h.interactive(), true));
    h.resetCalls();
    h.hover(b.x + 400, b.y);
    check('台球模式：球外 400px 交还桌面', () => assert.strictEqual(h.interactive(), false));

    const n = createHarness();
    n.stepMany(30);
    const nb = n.ball();
    n.resetCalls();
    n.hover(nb.x, nb.y);
    assert.strictEqual(n.interactive(), true, '先确认正常模式下悬停小球是可交互的');
    n.resetCalls();
    n.hover(nb.x + 200, nb.y);
    check('正常模式下球外 200px 依然穿透（桌面照常点得动）', () =>
      assert.strictEqual(n.interactive(), false));
  }

  // --- 握着杆的时候指针跑出命中圈也不能丢
  {
    const h = enterBilliards(createHarness());
    const b = h.ball();

    // 前提：没握杆的时候，这个点在命中圈外，应该是穿透的。
    // 注意 setInteractive 只在状态**变化**时才上报，所以断言前必须先把状态推到
    // 「可交互之外」的那一侧，否则观察不到任何变化（这是本套测试的一个通用坑）
    h.resetCalls();
    h.hover(5, 5);
    assert.strictEqual(h.interactive(), false, '前提不成立：没有球杆时 (5,5) 居然也可交互');

    h.mouse('mousedown', b.x - 100, b.y, 2);
    h.step();
    h.hover(5, 5);
    check('握着球杆时指针拖到命中圈外，球杆也不会丢', () => {
      assert.strictEqual(h.interactive(), true);
      assert.strictEqual(h.cuePaths().length, 2);
    });
  }
}

// ---- 12. 台球模式：力度随拉杆增长 / 击球方向 / 空杆 -------------------------
{
  console.log('\n[12] 台球模式：拉得越远打得越狠 / 方向 / 拉太少不击球');

  // 指针离球心 40px → 拉杆量 40 − 24 = 16 → 初速度约 5.9
  const near = shoot(enterBilliards(createHarness(HUGE)), -40, 0);
  // 指针离球心 120px → 拉杆量 120 − 24 = 96 → 初速度约 20.6
  const far = shoot(enterBilliards(createHarness(HUGE)), -120, 0);

  check('轻拉一杆能打动小球', () => assert.ok(near.hit && near.speed > 3, `实测 ${near.speed.toFixed(2)}`));
  check('拉得越远，击出的初速度越大', () =>
    assert.ok(far.speed > near.speed + 10, `${near.speed.toFixed(2)} → ${far.speed.toFixed(2)}`));
  check(`轻拉（拉杆 16px）的初速度 ≈ ${expectedCueSpeed(16).toFixed(1)} px/帧`, () =>
    assert.ok(Math.abs(near.speed - expectedCueSpeed(16)) < 0.4, `实测 ${near.speed.toFixed(2)}`));
  check(`重拉（拉杆 96px）的初速度 ≈ ${expectedCueSpeed(96).toFixed(1)} px/帧`, () =>
    assert.ok(Math.abs(far.speed - expectedCueSpeed(96)) < 0.6, `实测 ${far.speed.toFixed(2)}`));

  // 满力：指针拉到 244px，拉杆量被钳在上限 120 → 初速度顶到 25
  const maxed = shoot(enterBilliards(createHarness(HUGE)), -244, 0);
  check(`拉到上限（${CUE.MAX_PULL}px）→ 初速度顶到 ${CUE.MAX_SPEED}`, () =>
    assert.ok(maxed.speed > CUE.MAX_SPEED - 0.5 && maxed.speed <= CUE.MAX_SPEED + 0.01, `实测 ${maxed.speed.toFixed(2)}`));
  // 钳位必须是「截断」而不是「按比例缩放」：拉过头和刚好拉满要打出一模一样的一杆
  const exact = shoot(enterBilliards(createHarness(HUGE)), -(CUE.MAX_PULL + 24), 0);
  check('拉过头和刚好拉满打出的速度一样（钳位是截断）', () =>
    assert.ok(Math.abs(maxed.speed - exact.speed) < 0.05, `${maxed.speed.toFixed(2)} vs ${exact.speed.toFixed(2)}`));

  // 方向：杆在左 → 球向右；斜着拉 → 球朝斜对角飞
  check('杆拉在左边 → 小球朝右飞（而且不歪）', () => {
    assert.ok(far.dx > 0, `dx=${far.dx.toFixed(2)}`);
    assert.ok(Math.abs(far.dy) < 0.05, `dy=${far.dy.toFixed(3)}`);
  });
  const diag = shoot(enterBilliards(createHarness(HUGE)), -80, -80);
  check('斜着向左上拉杆 → 小球朝右下飞', () => {
    assert.ok(diag.dx > 0 && diag.dy > 0, `dx=${diag.dx.toFixed(2)} dy=${diag.dy.toFixed(2)}`);
    // 45° 拉杆应该打出 45° 的球：|dx| ≈ |dy|
    assert.ok(Math.abs(Math.abs(diag.dx) - Math.abs(diag.dy)) < 0.05, `dx=${diag.dx.toFixed(2)} dy=${diag.dy.toFixed(2)}`);
  });

  // 拉得太少：杆收走，球不打
  {
    const h = enterBilliards(createHarness(HUGE));
    const b = h.ball();
    h.mouse('mousedown', b.x - 28, b.y, 2); // 离球心 28px → 拉杆量只有 4 < 8
    h.step();
    h.mouse('mouseup', b.x - 28, b.y, 2);
    h.stepMany(3);
    check(`拉杆量不到 ${CUE.MIN_PULL}px → 不击球，球杆直接收走`, () => {
      assert.strictEqual(h.cuePaths().length, 0, '球杆还挂在屏幕上');
      assert.ok(trueSpeed(h, 4) < 0.01, '小球被误打动了');
    });
  }

  // 冲杆后球杆还要在球上停一会儿才收走（不然「弹出」这一下根本看不见）
  {
    const h = enterBilliards(createHarness(HUGE));
    shoot(h, -120, 0);
    check('击球之后球杆还在（要停一下才收）', () => assert.strictEqual(h.cuePaths().length, 2));
    h.stepMany(30); // 30 帧 ≈ 500ms > CUE_HOLD_MS
    check('停够了就把球杆收走', () => assert.strictEqual(h.cuePaths().length, 0));
  }
}

// ---- 13. 台球模式：摩擦减速到停死 / 碰边反弹 / 滚动 -------------------------
{
  console.log('\n[13] 台球模式：摩擦减速到停死 / 碰边反弹 / 滚动');

  // --- 恒定减速度：一路掉到 0，而不是回落到某个常态速度
  {
    const h = enterBilliards(createHarness(HUGE));
    const shot = shoot(h, -244, 0);
    check('满力一杆起手就是上限速度', () => assert.ok(shot.speed > 24.5, `实测 ${shot.speed.toFixed(2)}`));

    const speeds = [shot.speed];
    // 采 4 段就够：每段 33 帧，合计约 2.3s，速度已经从 25 掉到 5 上下，
    // 再采下去会撞上「已经归零」那段，单调性断言就变成 0 < 0 了
    for (let i = 0; i < 4; i++) {
      h.stepMany(30);
      speeds.push(trueSpeed(h, 3));
    }
    check('每 0.5s 采一次，速度一路单调下降', () => {
      for (let i = 1; i < speeds.length; i++) {
        assert.ok(
          speeds[i] < speeds[i - 1],
          `第 ${i} 段没降：${speeds[i - 1].toFixed(2)} → ${speeds[i].toFixed(2)}（全程 ${speeds.map((s) => s.toFixed(1)).join(' → ')}）`,
        );
      }
    });
    check('衰减是「每帧减固定量」的库仑摩擦（0.5s 掉约 4.5 px/帧）', () => {
      // 第一段用掉了 33 帧左右，25 - 0.15×33 ≈ 20.1
      assert.ok(Math.abs(speeds[1] - 20.1) < 1.2, `实测 ${speeds[1].toFixed(2)}`);
    });

    h.stepMany(240); // 4s，远超 2.8s 的停车时间
    check('最后彻底停下（不是回落到常态速度 6）', () =>
      assert.ok(trueSpeed(h, 5) < 0.01, `实测 ${trueSpeed(h, 1).toFixed(3)}`));

    // 停下之后再等一会儿也不该自己动起来
    h.stepMany(120);
    check('停下之后不会自己复活', () => assert.ok(trueSpeed(h, 4) < 0.01));
  }

  // --- 碰边反弹 + 不出屏
  {
    const h = enterBilliards(createHarness(SMALL));
    const shot = shoot(h, -244, 0);
    check('小屏幕上满力一杆也确实打出去了', () => assert.ok(shot.hit, '空杆了'));

    let escaped = 0;
    let wallHits = 0;
    for (let i = 0; i < 600; i++) {
      h.step();
      const cur = h.ball();
      if (cur.x - cur.rx < -0.5 || cur.x + cur.rx > h.W + 0.5) escaped++;
      if (cur.y - cur.ry < -0.5 || cur.y + cur.ry > h.H + 0.5) escaped++;
      if (cur.x - cur.rx < 1 || cur.x + cur.rx > h.W - 1) wallHits++;
      if (cur.y - cur.ry < 1 || cur.y + cur.ry > h.H - 1) wallHits++;
    }
    check('台球模式下也一次都没出屏', () => assert.strictEqual(escaped, 0));
    check('撞到边界会按正常模式那套规则反弹', () => assert.ok(wallHits > 0, `贴墙 ${wallHits} 帧`));
  }

  // --- 一边走一边滚
  {
    const h = enterBilliards(createHarness(HUGE));
    const before = h.ball().spin;
    shoot(h, -120, 0);
    h.stepMany(10);
    check('被打出去之后一边走一边滚（滚动旋转照旧生效）', () => {
      const d = angleDelta(before, h.ball().spin);
      assert.ok(Math.abs(d) > 0.3, `只转了 ${d.toFixed(4)} rad`);
    });
  }

  // --- 球滚走了就是空杆（「如果触碰到小球」的那个「如果」）
  {
    const h = enterBilliards(createHarness(HUGE));
    shoot(h, -244, 0); // 先打一杆让球跑起来
    h.stepMany(4);
    const moving = trueSpeed(h, 2);
    check('小球正在飞快地滚', () => assert.ok(moving > 20, `实测 ${moving.toFixed(2)}`));

    // 拿球**这一瞬间**的位置架杆：球正朝右跑，杆也架在左边往右冲。
    // 冲杆一共只有 90ms，杆头追不上 25px/帧 的球 —— 这就是空杆。
    const b = h.ball();
    h.mouse('mousedown', b.x - 120, b.y, 2);
    h.step();
    h.mouse('mouseup', b.x - 120, b.y, 2);
    h.stepMany(12);
    check('球在冲杆的 90ms 里跑掉了 → 空杆，球没被二次击中', () => {
      const now = trueSpeed(h, 3);
      assert.ok(now < moving, `${moving.toFixed(2)} → ${now.toFixed(2)}（速度没继续掉，说明被补了一杆）`);
      assert.ok(now > 5, '小球不该被这一杆打停');
    });
    check('空杆之后球杆照样收走', () => {
      h.stepMany(30);
      assert.strictEqual(h.cuePaths().length, 0);
    });
  }
}

// ---- 14. 台球模式：退出后一切照旧 ------------------------------------------
{
  console.log('\n[14] 台球模式：退出之后恢复正常玩法');

  const h = enterBilliards(createHarness(HUGE));
  setBilliards(h, false);
  h.stepMany(3);

  check('取消勾选 → 小球重新以常态速度跑起来', () => {
    const s = trueSpeed(h, 3);
    assert.ok(Math.abs(s - 6) < 0.5, `实测 ${s.toFixed(2)}`);
  });
  check('取消勾选后模式说明收起、正常提示回来', () => {
    assert.strictEqual(h.el('billiard-hint').hidden, true);
    assert.strictEqual(h.el('hint').hidden, false);
  });

  // 长按左键应该又能拖了
  const b = h.ball();
  h.mouse('mousedown', b.x, b.y);
  h.stepMany(20); // 越过 100ms 长按阈值 → 进入拖拽
  h.mouse('mousemove', b.x + 200, b.y);
  h.step();
  check('取消勾选后长按左键又能拖动小球', () => {
    const cur = h.ball();
    assert.ok(Math.abs(cur.x - (b.x + 200)) < 5, `小球 x=${cur.x.toFixed(1)}，指针 x=${(b.x + 200).toFixed(1)}`);
  });
  h.mouse('mouseup', b.x + 200, b.y);

  // 右键退回去当普通右键用，不该再冒出球杆
  h.stepMany(3);
  const b2 = h.ball();
  h.mouse('mousedown', b2.x - 120, b2.y, 2);
  h.step();
  check('正常模式下按右键不会冒出球杆', () => assert.strictEqual(h.cuePaths().length, 0));
  h.mouse('mouseup', b2.x - 120, b2.y, 2);

  // 托盘「重置」在台球模式下只把球摆回中央，不该推它跑起来
  const h2 = enterBilliards(createHarness(HUGE));
  h2.main('reset');
  h2.stepMany(3);
  check('台球模式下按重置：小球回到中央且仍然静止', () => {
    const b3 = h2.ball();
    assert.ok(Math.abs(b3.x - h2.W / 2) < 1 && Math.abs(b3.y - h2.H / 2) < 1, `位置 ${b3.x.toFixed(1)},${b3.y.toFixed(1)}`);
    assert.ok(trueSpeed(h2, 4) < 0.01);
  });
}

// ---- 15. 停稳开应用：停稳才读 / 高亮 / 1.5 秒后启动 / 动鼠标取消 --------------
{
  console.log('\n[15] 停稳开应用：停稳才读图标 / 高亮 + 倒计时 / 满 1.5 秒启动 / 动鼠标取消');

  // 一杆 -72px 大约打出 11.8 px/帧、滚 460 多像素后停死；
  // 在 4000×3000 的画布上从中央出发，绝对碰不到墙，所以落点完全确定
  const SHOT = -72;

  // --- 只是进台球模式不算「停稳」：球本来就是停的，不是被打停的
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIconsFromBall((b) => [iconOnBall(b)]);
    h.stepMany(30);
    check('刚进台球模式不会去读桌面图标', () => assert.strictEqual(h.iconReads(), 0));
    check('刚进台球模式不会高亮任何图标', () => assert.strictEqual(h.launchRects().length, 0));
  }

  // --- 正常模式的球一直在动，永远不该触发
  {
    const h = createHarness(HUGE);
    h.setIconsFromBall((b) => [iconOnBall(b)]);
    h.stepMany(120);
    check('正常模式下不会去读桌面图标', () => assert.strictEqual(h.iconReads(), 0));
  }

  // --- 核心流程：停稳 → 读图标 → 高亮 + 倒计时 → 满 1.5 秒启动
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIconsFromBall((b) => [iconOnBall(b, { name: '英雄联盟WeGame版' })]);
    const settled = shootAndSettle(h, SHOT, 0);

    check('停稳之后才去读桌面图标（就一次）', () => assert.strictEqual(h.iconReads(), 1));

    const box = highlightBox(h);
    check('停稳后画出了高亮框', () => assert.ok(box, '没有任何正方形高亮框'));
    check('高亮框正好框住那个图标（外扩 4px）', () => {
      const wantX = settled.x - 24 - 4;
      const wantY = settled.y - 24 - 4;
      assert.ok(Math.abs(box.x - wantX) < 1.5, `框左边 ${box.x.toFixed(1)}，期望 ${wantX.toFixed(1)}`);
      assert.ok(Math.abs(box.y - wantY) < 1.5, `框上边 ${box.y.toFixed(1)}，期望 ${wantY.toFixed(1)}`);
      assert.ok(Math.abs(box.w - 56) < 1.5, `框边长 ${box.w.toFixed(1)}，期望 56`);
    });

    check('倒计时环画在图标外面一圈（底环 + 进度弧）', () => {
      const ring = h.launchArcs();
      assert.ok(ring.length >= 2, `只画了 ${ring.length} 段弧`);
      const r = ring[0].r;
      assert.ok(Math.abs(r - (24 + 4 + 9)) < 1, `环半径 ${r.toFixed(1)}，期望 37`);
      const sweep = ring[ring.length - 1].endAngle - ring[ring.length - 1].startAngle;
      assert.ok(sweep > 0 && sweep < Math.PI * 2, `进度弧扫过 ${sweep.toFixed(3)} 弧度`);
    });

    check('名字牌写的是「即将打开：<图标名>」', () => {
      const label = h.launchLabels()[0];
      assert.ok(label, '没有画文字');
      assert.strictEqual(label.text, '即将打开：英雄联盟WeGame版');
    });

    check('名字牌挂在图标下方', () => {
      const label = h.launchLabels()[0];
      const pill = h.launchRects().find((r) => Math.abs(r.w - r.h) > 0.01);
      assert.ok(pill, '没有名字牌底板');
      assert.ok(label.y > box.y + box.h, '文字应当在框的下方');
    });

    // 走到 ~0.75 秒：还早，不该启动
    h.stepMany(45);
    check('倒计时没过半时不会启动', () => assert.strictEqual(h.launchCalls().length, 0));
    check('倒计时中途高亮一直在', () => assert.ok(highlightBox(h)));

    // 补齐剩下的
    h.stepMany(60);
    check('满 1.5 秒后启动一次，名字正确', () =>
      assert.deepStrictEqual(h.launchCalls(), ['英雄联盟WeGame版']));
    check('启动之后高亮收掉', () => {
      assert.strictEqual(h.launchRects().length, 0);
      assert.strictEqual(h.launchArcs().length, 0);
    });
    h.stepMany(120);
    check('启动只会发生一次，不会反复启动', () => assert.strictEqual(h.launchCalls().length, 1));
  }

  // --- 倒计时的时长确实在 1.5 秒这一档（不是 0.5 秒也不是 3 秒）
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIconsFromBall((b) => [iconOnBall(b)]);
    shootAndSettle(h, SHOT, 0);
    const frames = stepUntilLaunch(h);
    check('从停稳到启动约 1.5 秒（90 帧 @60fps）', () => {
      assert.ok(frames > 0, '压根没启动');
      assert.ok(frames >= 80 && frames <= 95, `${frames} 帧 ≈ ${((frames * FRAME) / 1000).toFixed(2)}s`);
    });
  }

  // --- 动鼠标取消
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIconsFromBall((b) => [iconOnBall(b)]);
    const beforeShot = h.ball();
    shootAndSettle(h, SHOT, 0);
    h.stepMany(10);
    check('前提：倒计时已经起来', () => assert.ok(highlightBox(h)));

    // 指针停在出杆的位置上，也就是球心往左 72px —— 倒计时开始时记的就是这里
    const px = beforeShot.x + SHOT;
    const py = beforeShot.y;

    // 零位移的 mousemove 不算「动」：窗口重绘 / 驱动抖动会派发这种事件，
    // 真按「收到 mousemove 就取消」写，倒计时会被自己瞬间取消掉
    h.mouse('mousemove', px, py);
    h.step();
    check('零位移的 mousemove 不会取消倒计时', () => assert.ok(highlightBox(h)));

    // 真的动了 5px（阈值 3px）
    h.mouse('mousemove', px + 5, py);
    h.step();
    check('鼠标移动超过阈值 → 高亮立刻消失', () => assert.strictEqual(h.launchRects().length, 0));
    h.stepMany(150);
    check('取消之后不会再启动', () => assert.strictEqual(h.launchCalls().length, 0));
  }

  // --- 停在不可启动的图标上（桌面虚拟项，例如回收站）
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIconsFromBall((b) => [iconOnBall(b, { name: '回收站', launchable: false })]);
    shootAndSettle(h, SHOT, 0);
    h.stepMany(120);
    check('停在「回收站」这类不可启动的图标上：不高亮', () =>
      assert.strictEqual(h.launchRects().length, 0));
    check('停在「回收站」上：不会启动', () => assert.strictEqual(h.launchCalls().length, 0));
  }

  // --- 停在空白处（脚下没有任何图标）
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIcons([]);
    shootAndSettle(h, SHOT, 0);
    h.stepMany(120);
    check('停在空白处：不高亮也不启动', () => {
      assert.strictEqual(h.launchRects().length, 0);
      assert.strictEqual(h.launchCalls().length, 0);
    });
  }

  // --- 命中判定外扩 6px：差一点点也算停上去了
  {
    const h = enterBilliards(createHarness(HUGE));
    // 球心落在图标左边界**外面** 4px → 仍在 6px 容差内
    h.setIconsFromBall((b) => [iconOnBall(b, { x: b.x + 4 })]);
    shootAndSettle(h, SHOT, 0);
    h.stepMany(120);
    check('球心偏出图标 4px 仍算命中（命中区外扩 6px）', () =>
      assert.deepStrictEqual(h.launchCalls(), ['QQ']));
  }
  {
    const h = enterBilliards(createHarness(HUGE));
    // 球心落在外面 9px → 超出 6px 容差
    h.setIconsFromBall((b) => [iconOnBall(b, { x: b.x + 9 })]);
    shootAndSettle(h, SHOT, 0);
    h.stepMany(120);
    check('球心偏出图标 9px 就不算命中', () => assert.strictEqual(h.launchCalls().length, 0));
  }

  // --- 倒计时期间又打了一杆
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIconsFromBall((b) => [iconOnBall(b)]);
    shootAndSettle(h, SHOT, 0);
    h.stepMany(10);
    check('前提：倒计时已经起来', () => assert.ok(highlightBox(h)));

    shoot(h, SHOT, 0); // 再打一杆
    h.setIcons([]); // 第二杆不摆图标，专心验证「旧倒计时被撤掉」
    h.stepMany(3);
    check('倒计时期间再打一杆 → 高亮立刻消失', () =>
      assert.strictEqual(h.launchRects().length, 0));

    h.stepMany(220); // 等第二杆也停稳
    check('被新的一杆打断后，旧的启动不会补执行', () =>
      assert.strictEqual(h.launchCalls().length, 0));
    check('新的一杆停稳后会重新读一次图标', () => assert.strictEqual(h.iconReads(), 2));
  }

  // --- 倒计时期间退出台球模式
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIconsFromBall((b) => [iconOnBall(b)]);
    shootAndSettle(h, SHOT, 0);
    h.stepMany(10);
    check('前提：倒计时已经起来', () => assert.ok(highlightBox(h)));

    setBilliards(h, false);
    h.step();
    check('退出台球模式 → 高亮立刻消失', () => assert.strictEqual(h.launchRects().length, 0));
    h.stepMany(150);
    check('退出台球模式后不会启动', () => assert.strictEqual(h.launchCalls().length, 0));
  }

  // --- 暂停时倒计时也冻住（托盘点了暂停就该真的什么都不发生）
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIconsFromBall((b) => [iconOnBall(b)]);
    shootAndSettle(h, SHOT, 0);
    h.stepMany(5);
    h.main('paused', true);
    h.stepMany(300); // 5 秒，足够走完三轮倒计时
    check('暂停期间倒计时冻住，不会启动', () => assert.strictEqual(h.launchCalls().length, 0));
    check('暂停期间高亮仍然挂着（解除暂停后接着走）', () => assert.ok(highlightBox(h)));

    h.main('paused', false);
    const frames = stepUntilLaunch(h);
    check('解除暂停后倒计时接着走完并启动', () => {
      assert.ok(frames > 0 && frames < 100, `${frames} 帧`);
      assert.deepStrictEqual(h.launchCalls(), ['QQ']);
    });
  }

  // --- 读图标失败（koffi 没装上 / explorer 异常 / 不是 Windows）
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIconReadError(true);
    shootAndSettle(h, SHOT, 0);
    h.stepMany(150);
    check('读桌面图标失败时静默降级：不高亮、不启动、不崩', () => {
      assert.strictEqual(h.launchRects().length, 0);
      assert.strictEqual(h.launchCalls().length, 0);
    });
    check('读失败之后小球照常停在原地', () => {
      const b = h.ball();
      assert.ok(trueSpeed(h, 4) < 0.01, `速度 ${trueSpeed(h, 2).toFixed(4)}`);
      assert.ok(b.x > 0 && b.x < h.W && b.y > 0 && b.y < h.H);
    });
  }

  // --- 异步期间球被挪走了（读图标要几毫秒，这几毫秒里球可能被重置到中央）
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIconsFromBall((b) => [iconOnBall(b)]);
    h.setBeforeIconResolve(() => h.main('reset')); // 模拟「IPC 还没回来，球已经被搬走了」
    shootAndSettle(h, SHOT, 0);
    h.stepMany(3);
    check('读图标的路上球被搬走 → 这一次作废，不高亮', () =>
      assert.strictEqual(h.launchRects().length, 0));
    h.stepMany(150);
    check('作废之后也不会启动', () => assert.strictEqual(h.launchCalls().length, 0));
  }

  // --- 高亮用完就收干净：不能拖着上一次的坐标继续画
  {
    const h = enterBilliards(createHarness(HUGE));
    h.setIconsFromBall((b) => [iconOnBall(b)]);
    shootAndSettle(h, SHOT, 0);
    h.stepMany(10);
    check('前提：正在高亮', () => assert.ok(highlightBox(h)));
    h.main('reset');
    h.step();
    check('重置小球会把高亮一起收掉', () => assert.strictEqual(h.launchRects().length, 0));
  }
}

console.log(`\n${process.exitCode ? '✗' : '✓'} ${passed} 项断言通过\n`);
