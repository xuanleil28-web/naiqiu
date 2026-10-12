/**
 * 渲染进程 —— 小球本体 + 设置面板 + 台球模式
 * ---------------------------------------------------------------------------
 * 正常模式的交互模型：
 *   · 悬停在小球上   → 通知主进程关闭穿透（否则点不到）
 *   · 单击（短按）   → 小球停下 + 呼出设置面板（速度 / 大小 两个滑块）
 *   · 长按（≥100ms） → 进入拖拽，松手时按拖拽速度抛出
 *   · 短按后移动了   → 本次按压作废（不拖拽、不弹面板），小球带原速度继续走
 *
 * 台球模式（面板里的勾选项）：
 *   · 小球静止，左键不能拖它；单击只负责开面板
 *   · 右键呼出球杆 → 按住拖动球杆（跟着光标走）→ 松手球杆向前弹出
 *   · 杆头离球面越远＝拉得越多＝击出的初速度越大
 *   · 被击中后按台球摩擦（恒定减速度）慢慢停下来，途中照样碰边反弹 + 滚动
 *   · **停稳之后**：看球压在哪一个桌面图标上 → 高亮它 → 倒计时 1.5 秒 →
 *     让主进程把那个应用启起来。这 1.5 秒里鼠标一动就取消（见「停稳开应用」一章）
 *
 * 为什么渲染层是单个脚本文件：tsconfig 用了 `module: "none"`（为了绕开
 * file:// 下 ES module 的 CORS 限制），所以不能 import/export，只能放在一起。
 */

/** 桌面图标（与主进程 icons.ts 的 DesktopIcon 一致；坐标是窗口内 DIP） */
interface DesktopIcon {
  name: string;
  x: number;
  y: number;
  size: number;
  launchable: boolean;
}

interface BallAPI {
  setInteractive(value: boolean): void;
  onPaused(handler: (paused: boolean) => void): () => void;
  onReset(handler: () => void): () => void;
  onLayoutChanged(handler: () => void): () => void;
  /**
   * 读桌面图标。这里是**可选**的：万一 dist/preload 是旧的（用户只重建了渲染层），
   * 渲染进程不该因为缺一个方法就整个崩掉 —— 拿不到就当没有这个功能。
   */
  readDesktopIcons?(): Promise<DesktopIcon[]>;
  /** 启动某个图标对应的应用（只传名字，路径由主进程自己找） */
  launchDesktopIcon?(name: string): Promise<{ ok: boolean; error?: string }>;
}

interface Window {
  ballAPI?: BallAPI;
}

/**
 * 球杆的状态机（只在台球模式里用）：
 *   off     —— 没有球杆
 *   aiming  —— 右键按住了，球杆跟着指针走（击球方向 = 指针 → 球心）
 *   firing  —— 已松手，杆头正沿轴向前冲，**碰到球才算击中**
 *   holding —— 冲完了，在球上停一下再收杆（不然「弹出」这一下快得看不见）
 */
type CueState = 'off' | 'aiming' | 'firing' | 'holding';

(() => {
  'use strict';

  // ------------------------------------------------------------------- 可调参数
  /** 速度上限，单位 px / 帧（@60fps）；抛出速度也会被它截断 */
  const MAX_SPEED = 25;
  /**
   * 常态速度的初始值（面板滑块可调）。
   * 它同时是「回落目标」：抛出造成的提速最终都会衰减回这个值。
   */
  const DEFAULT_BASE_SPEED = 6;
  /** 常态速度滑块取值范围 */
  const SPEED_RANGE = { min: 0, max: 20, step: 0.5 };
  /**
   * 小球的名义半径（CSS px = DIP），指的是贴图的**半宽**。
   * 贴图是蛋形、比圆略高，竖直方向的半径另外按 SPRITE_ASPECT 算。
   * 24 → 蛋宽 48px、高约 56px，面板滑块可在 8~60 之间调。
   */
  const DEFAULT_RADIUS = 24;
  const RADIUS_RANGE = { min: 8, max: 60, step: 1 };

  /** 贴图文件名（与 index.html 同目录，构建时一并拷进 dist/renderer） */
  const SPRITE_URL = 'ball-sprite.png';
  /**
   * 贴图宽高比 h / w。必须与 src/renderer/ball-sprite.png 的实际尺寸一致，
   * 换贴图就要同步改这里。当前 521 / 448 ≈ 1.1629（蛋形，竖直方向更高）。
   */
  const SPRITE_ASPECT = 521 / 448;
  /** 贴图还没解码完时用的兜底色，取贴图主体色，避免第一帧闪出别的颜色 */
  const SPRITE_FALLBACK_COLOR = '#EFC96C';

  /**
   * 旋转：滚过这么多个「球宽」正好转一整圈。
   * 纯物理滚动是「一圈 = π 倍球宽」，但那意味着 24px 的球在 6px/帧 下
   * 要转 2.4 圈/秒，太快了；9 大约是 0.83 圈/秒，是看着比较舒服的量级。
   * 想更疯或更慢，只改这一个数。
   */
  const SPIN_WIDTHS_PER_TURN = 9;

  /**
   * 「播放笑声」按钮要用的音频，放在 src/renderer/ 下（构建时一并拷进 dist/renderer）。
   * 按顺序挨个探测，**你先放哪个就用哪个** —— 这样丢一个 laugh.wav 进来也能直接跑，
   * 不用为了换个格式去改代码。文件不存在时按钮会把说明显示出来，不会静默失灵。
   */
  const LAUGH_SOURCES = ['laugh.mp3', 'laugh.wav', 'laugh.ogg', 'laugh.m4a'];
  /** 按钮的两态文案。播放中必须能停下来 —— 不然长音频一点下去就收不住了 */
  const LAUGH_PLAY_TEXT = '播放笑声';
  const LAUGH_STOP_TEXT = '停止大笑';

  /**
   * 按住多久算「长按」→ 进入拖拽。
   * 注意它同时是「点击」和「拖拽」的分界线：按下超过这个时间再松手就**不算点击**了，
   * 面板不会弹出来。0.1s 很贴近正常的鼠标点按时长，所以点得稍微慢一点就会变成拖拽。
   */
  const LONG_PRESS_MS = 100;
  /** 长按阈值之前，指针移动超过这么多像素 → 本次按压作废 */
  const PRESS_CANCEL_TOLERANCE = 8;
  /** 拖拽过程中，位移超过这么多像素才算「真的拖动过」 */
  const MOVE_TOLERANCE = 4;
  /** 悬停判定的额外宽容半径（球小的时候靠它才好抓） */
  const HOVER_SLACK = 4;
  /** 抛掷速度只取最后这段时间的采样 */
  const VELOCITY_WINDOW_MS = 90;
  /** 采样队列上限 */
  const SAMPLE_LIMIT = 60;
  /** 点击反馈的缩放脉冲时长 */
  const PULSE_DECAY_MS = 260;
  /** 脉冲带来的最大放大比例（1 → 1.45） */
  const PULSE_MAX_SCALE = 0.45;
  /** 单帧最大时间步，防止切回来时瞬移穿墙 */
  const MAX_STEP_MS = 48;

  /** 反弹时偏离法线的最大角度（rad，约 26°），设 0 就退回严格镜面反弹 */
  const BOUNCE_DEVIATION = 0.45;
  /** 偏转后法线分量至少要占总速率的这个比例，避免贴着墙「蹭」着走 */
  const MIN_NORMAL_RATIO = 0.28;

  /**
   * 速度回落到常态速度的时间常数（指数衰减）。
   * 抛到 25 时约 1.1s 衰减掉 63% 的超出量，3~4s 基本回到常态速度。
   */
  const SPEED_RELAX_TAU_MS = 1100;

  // ------------------------------------------------------------- 台球模式参数
  /**
   * 台球模式：小球静止，用右键召唤球杆来打。
   * 「拉杆距离」= 杆头到球表面的距离；向后拉得越多，击出的初速度越大。
   */
  /** 拉杆不到这个距离就当没拉（右键点一下就松开的情况）：收杆，不击球 */
  const CUE_MIN_PULL = 8;
  /**
   * 拉到这个距离就是满力，约合 2.5 个球宽（球宽 48px）。
   * 再往后拉视觉上就假了 —— 杆会退到离球老远的地方，而且手指得拖到瞄准圈边上才够。
   */
  const CUE_MAX_PULL = 120;
  /**
   * 最小 / 最大击球初速度（px/帧）。上限跟正常模式的 MAX_SPEED 对齐（满力＝能打出破防的一杆）。
   *
   * 中间按拉杆量**线性**插值：每拉 1px ≈ 加 0.18 px/帧 的速度。
   * 注意插值的分母就是 CUE_MAX_PULL —— 拉杆量被它钳住，所以改这一个数，
   * 整条「距离 → 初速度」的曲线会自己重新对齐，不需要动别的地方。
   * 换句话说：拉距变短 → 灵敏度等比变高，满力永远落在被钳住的那一点上。
   */
  const CUE_MIN_SPEED = 3;
  const CUE_MAX_SPEED = MAX_SPEED;
  /**
   * 释放后球杆向前弹出的时长（ms）。
   * 「击中」发生在杆头真正顶到球面的那一瞬间 —— 不是松手那一刻，
   * 所以这段前冲不是纯动画，它是击球判定的一部分。
   */
  const CUE_LUNGE_MS = 90;
  /** 击中后杆在球上停留一会儿再收走，不然「弹出」这一下快得看不见 */
  const CUE_HOLD_MS = 170;
  /** 球杆外观：长度 / 杆尾粗细 / 杆头粗细 / 皮头长度（px，DIP） */
  const CUE_LENGTH = 190;
  const CUE_BUTT_WIDTH = 7;
  const CUE_TIP_WIDTH = 4;
  const CUE_TIP_BAND = 9;
  const CUE_COLOR = '#111111';
  const CUE_TIP_COLOR = '#e9e2cf';
  /** 瞄准虚线：从球心沿击球方向画这么长（px） */
  const CUE_AIM_LINE = 150;

  /**
   * 台球模式下的摩擦减速度（每个 60fps 帧减掉这么多 px/帧）。
   * 注意这和正常模式的「回落到常态速度」完全不是一回事：台球是要**停下来**的，
   * 所以这里用恒定减速度（库仑摩擦），而不是指数衰减到某个非零目标。
   * 满力 25 px/帧 击出约 2.8s 停下、滚两千多像素；轻轻一推只走百来像素。
   */
  const BILLIARD_DECEL = 0.15;

  /**
   * 台球模式下窗口接管鼠标的范围（以球心为圆心的半径，px）。
   * 全屏窗口平时是穿透的，不把命中区放大就根本收不到右键；但也不能整个屏幕都接管，
   * 那样桌面就点不动了。按住右键期间会强制保持可交互，所以拖到圈外也照样跟手。
   */
  const BILLIARD_AIM_RADIUS = 240;

  /** 杆头前表面多靠近球面算「顶上了」：杆头本身有厚度，不能要求严丝合缝（px） */
  const CUE_TIP_TOUCH = 3;
  /**
   * 冲杆的子步长（px）。满力时杆头一整帧要走 22px，不分步就会直接从球上「穿」过去，
   * 于是「有没有碰到」这件事就完全看运气了。
   */
  const CUE_LUNGE_SUBSTEP = 4;
  /** 击球瞬间的缩放脉冲。比单击的 1 小得多 —— 台球这一击是干脆的，不该弹成球 */
  const CUE_HIT_PULSE = 0.32;

  // --------------------------------------------------- 停稳开应用（只在台球模式）
  /**
   * 停稳之后等这么久就启动（毫秒）。这段时间内鼠标一动就取消。
   *
   * 为什么要留这个缓冲：桌面图标里就有「英雄联盟WeGame版」「饥荒联机版」这种
   * 一点就吃掉半分钟的东西。没有倒计时的话，随手甩一杆停上去就直接启动了，
   * 而且**撤销不了** —— 只有「先预告、给时间反悔」才是能用的设计。
   */
  const ICON_LAUNCH_DELAY_MS = 1500;

  /**
   * 命中判定往外放宽多少（DIP）。
   * 严格要求球心落进图标图形那个方框里太苛刻了，往外放 6px 让「停上去」友好些。
   * 上限是安全的：图标横向间距 75 DIP，放宽后命中区 48+12=60 < 75，相邻图标不会重叠。
   */
  const ICON_HIT_PAD = 6;

  /**
   * 鼠标相对倒计时开始时的位置移动超过这么多（DIP）才算「动了」。
   * 不能一收到 mousemove 就取消：有些环境（窗口重绘、驱动抖动）会派发**零位移**的
   * mousemove，那样倒计时会被自己瞬间取消掉，功能看起来像是坏的。
   */
  const ICON_CANCEL_MOVE = 3;

  /** 高亮框相对图标再向外扩一点，让它看起来是「框住」而不是「贴住」 */
  const ICON_HILITE_PAD = 4;
  const ICON_HILITE_COLOR = '#d1462f';
  /** 高亮框内部的淡色填充 + 倒计时外圈的底环 */
  const ICON_HILITE_FILL = 'rgba(209, 70, 47, 0.14)';
  const ICON_RING_TRACK = 'rgba(209, 70, 47, 0.22)';

  /** 名字牌：深底浅字，在亮 / 暗壁纸上都读得清 */
  const ICON_LABEL_FONT = '600 13px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
  const ICON_LABEL_BG = 'rgba(24, 26, 30, 0.88)';
  const ICON_LABEL_FG = '#f4f1ea';
  const ICON_LABEL_PREFIX = '即将打开：';
  /** 名字牌最宽多少（DIP）—— 名字太长就截断，别横穿整个屏幕 */
  const ICON_LABEL_MAX_W = 260;
  const ICON_LABEL_PAD_X = 10;
  const ICON_LABEL_H = 26;
  /** 名字牌与高亮框之间的间隙 */
  const ICON_LABEL_GAP = 10;

  // ------------------------------------------------------------------- 画布与面板
  function mustEl<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`[ball] 找不到 #${id}`);
    return el as T;
  }

  // 注意：TS 不会在闭包里保留可空收窄，所以这里必须把 null 挡在函数外面，
  // 拿不到就直接抛错，让 ctx 的类型是确定的 CanvasRenderingContext2D
  function mustCtx(value: CanvasRenderingContext2D | null): CanvasRenderingContext2D {
    if (!value) throw new Error('[ball] 无法获取 2d 上下文');
    return value;
  }

  const canvas = mustEl<HTMLCanvasElement>('stage');
  const ctx = mustCtx(canvas.getContext('2d', { alpha: true }));

  const menu = mustEl<HTMLDivElement>('menu');
  const speedInput = mustEl<HTMLInputElement>('speed');
  const sizeInput = mustEl<HTMLInputElement>('size');
  const speedValue = mustEl<HTMLElement>('speed-value');
  const sizeValue = mustEl<HTMLElement>('size-value');
  const menuClose = mustEl<HTMLButtonElement>('menu-close');
  const resumeButton = mustEl<HTMLButtonElement>('resume');
  const laughButton = mustEl<HTMLButtonElement>('laugh');
  const laughHint = mustEl<HTMLElement>('laugh-hint');
  const billiardToggle = mustEl<HTMLInputElement>('billiard');
  const billiardHint = mustEl<HTMLElement>('billiard-hint');
  const hintText = mustEl<HTMLElement>('hint');

  /** 面板底部那句提示：两种模式的玩法完全不同，得跟着切 */
  const HINT_NORMAL = '长按小球 0.1 秒即可拖拽甩出';
  const HINT_BILLIARD = '右键出杆；停在图标上会倒计时后打开它';

  const api = window.ballAPI;

  // ------------------------------------------------------------------- 笑声
  /** 探测到的可用音频（null = 还没就绪 / 文件没放进来） */
  let laughAudio: HTMLAudioElement | null = null;
  /** 是不是正在播 —— 按钮在「播放笑声 / 停止大笑」之间切换就靠它 */
  let laughPlaying = false;

  /** 把按钮刷成当前状态：文案 + 配色 */
  function syncLaughButton(): void {
    laughButton.textContent = laughPlaying ? LAUGH_STOP_TEXT : LAUGH_PLAY_TEXT;
    laughButton.classList.toggle('is-playing', laughPlaying);
  }

  /** 文件缺失时的统一反馈：按钮进告警态 + 把说明露出来 */
  function markLaughMissing(): void {
    laughPlaying = false;
    syncLaughButton();
    laughButton.classList.add('is-missing');
    laughHint.hidden = false;
  }

  /**
   * 依次探测每个候选文件名，谁先加载成功就用谁。
   *
   * 用 loadeddata / error 事件判断文件在不在：file:// 下文件缺失时 Chromium 会
   * 触发 error（MEDIA_ERR_SRC_NOT_SUPPORTED），这是最可靠的「没放进来」信号。
   * 探测和预加载是同一件事，所以点击时不用等缓冲。
   */
  function probeLaugh(index: number): void {
    if (index >= LAUGH_SOURCES.length) {
      markLaughMissing();
      console.warn(
        '[ball] 没找到笑声文件，按钮暂时没声音。把音频放到 src/renderer/ 下，' +
          `命名成 ${LAUGH_SOURCES.map((name) => `"${name}"`).join(' 或 ')}，再 npm run build`,
      );
      return;
    }

    const url = LAUGH_SOURCES[index];
    const audio = new Audio();
    audio.preload = 'auto';

    audio.addEventListener(
      'loadeddata',
      () => {
        laughAudio = audio;
        // 播完自己回到「播放笑声」。不接这个事件的话，音频放完了按钮还会一直挂着
        // 「停止大笑」，用户再点一下反而变成「从头再播」，怎么点都关不掉。
        audio.addEventListener('ended', () => {
          laughPlaying = false;
          syncLaughButton();
        });
        laughButton.classList.remove('is-missing');
        laughHint.hidden = true;
        syncLaughButton();
        console.log(`[ball] 笑声已就绪：${url}`);
      },
      { once: true },
    );
    // 这个文件名不存在（或解不了码）→ 换下一个候选
    audio.addEventListener('error', () => probeLaugh(index + 1), { once: true });

    audio.src = url;
  }

  /** 从头播放笑声 */
  function playLaugh(): void {
    if (!laughAudio) {
      // 文件没放进来：给一次显式反馈，别让点击静默失败
      markLaughMissing();
      return;
    }

    // loadeddata 之后 readyState 至少是 HAVE_CURRENT_DATA，这时改 currentTime 是安全的
    laughAudio.currentTime = 0;
    // 乐观地先切到「停止大笑」：不等 play() 的 Promise，点击才有即时反馈。
    // 真播不了（自动播放被拦 / 解码失败）时，下面的 catch 会把状态滚回去。
    laughPlaying = true;
    syncLaughButton();

    // play() 返回 Promise：被自动播放策略拦下或解码失败都会走 reject。
    // 这里必须接住，否则控制台只会留一条看不懂的「未处理 Promise」警告
    laughAudio.play().catch((err: unknown) => {
      laughPlaying = false;
      syncLaughButton();
      console.error('[ball] 笑声播放失败：', err);
    });
  }

  /** 停止播放，并把进度拨回开头，下次点就是从头播 */
  function stopLaugh(): void {
    if (laughAudio) {
      laughAudio.pause();
      laughAudio.currentTime = 0;
    }
    laughPlaying = false;
    syncLaughButton();
  }

  /** 按钮点击 = 播放 / 停止 二选一 */
  function toggleLaugh(): void {
    if (laughPlaying) stopLaugh();
    else playLaugh();
  }

  // 小球贴图：平面化的蛋形小生物（见 scripts/gen_sprite.py）
  const sprite = new Image();
  let spriteReady = false;
  sprite.onload = () => {
    spriteReady = true;
    // 这条日志是给启动自检用的：能确认 PNG 真的从 dist 里加载出来了
    // （拷贝漏了 / 路径写错会走下面的 onerror，而不是静默变成兜底椭圆）
    console.log(`[ball] 贴图已加载 ${sprite.naturalWidth}x${sprite.naturalHeight}`);
  };
  sprite.onerror = () => {
    console.error(`[ball] 贴图加载失败，将一直用兜底椭圆绘制：${SPRITE_URL}`);
  };
  sprite.src = SPRITE_URL;

  // 笑声文件（可选）：探测一次，命中就顺便预加载好了。
  // 必须放在上面那些声明之后 —— `laughAudio` 是 let，声明前就在暂时性死区里，
  // 而 loadeddata 有可能是同步派发出去的（桩实现就是同步的）。
  probeLaugh(0);

  // ------------------------------------------------------------------- 状态
  let width = window.innerWidth;
  let height = window.innerHeight;

  const ball = {
    x: width / 2,
    y: height / 2,
    radius: DEFAULT_RADIUS,
    vx: 0,
    vy: 0,
    spin: 0, // 当前旋转角（rad），移动时按滚动关系推进
    pulse: 0, // 缩放脉冲 1 → 0
  };

  /** 常态速度，滑块可调 */
  let baseSpeed = DEFAULT_BASE_SPEED;

  let paused = false;
  let interactive = false; // 与主进程保持一致的本地缓存

  /** 左键按在小球上、还没到长按阈值 */
  let pressing = false;
  /** 已进入拖拽 */
  let dragging = false;
  let draggingHasMoved = false;

  let pressStartTime = 0;
  let pressOrigin = { x: 0, y: 0 };

  /** 设置面板是否打开 */
  let menuOpen = false;
  /** 面板正在被操作（拖滑块），此时必须保持可交互 */
  let menuEngaged = false;
  /** 面板的屏幕矩形，用于命中判定 */
  let menuRect: { left: number; top: number; right: number; bottom: number } | null = null;

  let lastAtRest = true;

  const pointer = { x: -1, y: -1, seen: false };
  const samples: { t: number; x: number; y: number }[] = [];

  // ------------------------------------------------------------------- 台球模式状态
  /** 面板里那个勾选框的状态 */
  let billiardsMode = false;
  /** 台球模式下左键按在了小球上（要等到松手才算一次「单击」） */
  let leftClickOnBall = false;

  let cueState: CueState = 'off';

  /** 瞄准中：击球方向（单位向量）＋ 拉杆量（杆头离球面多远，px） */
  let aimDir = { x: 1, y: 0 };
  let aimPull = 0;

  /** 松手那一刻**锁定**下来的击球轴 / 力量 / 起点 —— 之后球怎么动都不再影响这一杆 */
  let cueDir = { x: 1, y: 0 };
  let cuePower = 0;
  let cueOrigin = { x: 0, y: 0 };
  /** 击球轴上，球面到球心的距离（蛋形：竖着量比横着量长，锁定一次就够） */
  let cueRest = 0;
  /** 冲杆中：杆头离球面的距离，从 aimPull 一路收到 0 */
  let cueGap = 0;
  /** 冲杆速度（px / 帧）—— 拉得越深，冲得越快 */
  let cueLunge = 0;
  /** holding 阶段还剩多久 */
  let cueHoldLeft = 0;

  /**
   * 本次击球是否已经处理过「停稳 → 找图标」。
   * 初始 true：刚启动 / 刚进台球模式时球本来就是停的，不该触发。
   * 只有 strikeBall() 打出新的一杆才置 false —— 于是「停稳」这件事
   * 每杆只可能触发一次。
   */
  let settleHandled = true;

  /**
   * 正在倒计时的目标图标；null = 没有。
   * mouseX / mouseY 是倒计时开始那一刻的指针位置，用来判断「鼠标动了没有」。
   */
  let pendingLaunch: { icon: DesktopIcon; left: number; mouseX: number; mouseY: number } | null =
    null;

  // ------------------------------------------------------------------- 小工具
  /** 名义半径（半宽），含点击缩放脉冲 */
  function effectiveRadius(): number {
    return ball.radius * (1 + ball.pulse * PULSE_MAX_SCALE);
  }

  /** 贴图自身的半宽（不含旋转），也就是面板里说的「球的大小」 */
  function spriteHalfW(): number {
    return effectiveRadius();
  }

  /** 贴图自身的半高（不含旋转）：蛋比圆高，按宽高比换算 */
  function spriteHalfH(): number {
    return effectiveRadius() * SPRITE_ASPECT;
  }

  /**
   * 贴图**旋转之后**的外接框半宽 / 半高。
   * 椭圆转起来，它的轴对齐包围盒会在「半宽 ↔ 半高」之间来回摆，所以碰撞
   * 必须按外接框算：否则蛋尖转到侧面时会插进墙里（r=60 时能插进去约 10px）。
   * 角度为 0 时退化成 (半宽, 半高)，与不旋转时完全一致。
   */
  function ballRx(): number {
    const a = spriteHalfW();
    const b = spriteHalfH();
    return Math.hypot(a * Math.cos(ball.spin), b * Math.sin(ball.spin));
  }

  function ballRy(): number {
    const a = spriteHalfW();
    const b = spriteHalfH();
    return Math.hypot(a * Math.sin(ball.spin), b * Math.cos(ball.spin));
  }

  function clamp(value: number, min: number, max: number): number {
    if (min > max) return (min + max) / 2;
    return Math.min(Math.max(value, min), max);
  }

  function speed(): number {
    return Math.hypot(ball.vx, ball.vy);
  }

  function isAtRest(): boolean {
    return speed() < 0.01;
  }

  function limitSpeed(vx: number, vy: number): { x: number; y: number } {
    const s = Math.hypot(vx, vy);
    if (s <= MAX_SPEED || s === 0) return { x: vx, y: vy };
    const k = MAX_SPEED / s;
    return { x: vx * k, y: vy * k };
  }

  /** 悬停命中判定：贴图是椭圆，所以按椭圆算，不能拿半径当圆用 */
  function isInsideBall(x: number, y: number): boolean {
    const rx = ballRx() + HOVER_SLACK;
    const ry = ballRy() + HOVER_SLACK;
    const dx = (x - ball.x) / rx;
    const dy = (y - ball.y) / ry;
    return dx * dx + dy * dy <= 1;
  }

  function isOverMenu(x: number, y: number): boolean {
    if (!menuOpen || !menuRect) return false;
    return x >= menuRect.left && x <= menuRect.right && y >= menuRect.top && y <= menuRect.bottom;
  }

  /**
   * 事件目标是否落在设置面板里。
   * 用 nodeType 做鸭子类型判断而不是 `instanceof Node`：后者遇到非 Node 目标
   * （例如合成事件把 target 设成 window）会抛 TypeError，把整个 mousedown
   * 处理函数打断；而且某些无 DOM 的运行环境里根本没有 Node 这个全局。
   */
  function isFromMenu(target: EventTarget | null): boolean {
    if (!target || typeof (target as Node).nodeType !== 'number') return false;
    return menu.contains(target as Node);
  }

  // ------------------------------------------------------------------- 穿透开关
  function setInteractive(next: boolean): void {
    if (interactive === next) return;
    interactive = next;
    api?.setInteractive(next);
  }

  /** 每一帧 / 每次鼠标移动都重算，避免「窗口状态」和「视觉状态」脱节 */
  function refreshInteractivity(): void {
    // 手里正握着球杆（瞄 / 冲 / 收）时必须一直可交互：指针拖到命中圈外也照样跟手
    if (dragging || pressing || menuEngaged || cueState !== 'off') {
      setInteractive(true);
      return;
    }
    if (!pointer.seen) {
      setInteractive(false);
      return;
    }
    if (isInsideBall(pointer.x, pointer.y) || isOverMenu(pointer.x, pointer.y)) {
      setInteractive(true);
      return;
    }
    // 台球模式：球周围一大圈都要接管，否则全屏穿透的窗口根本收不到右键。
    // 只在勾上之后才这么做 —— 不能为了台球把整个桌面都变成点不动的地方。
    setInteractive(billiardsMode && isOverAimArea(pointer.x, pointer.y));
  }

  // ------------------------------------------------------------------- 布局
  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    keepBallInside();
    if (menuOpen) positionMenu();
    // 窗口尺寸 / 缩放变了，之前读到的图标坐标（窗口内 DIP）就失效了 ——
    // 与其拿一份偏掉的坐标去高亮，不如把这一次取消掉
    cancelPendingLaunch();
  }

  /** 任何时候都不让球跑出可视区域 */
  function keepBallInside(): void {
    const rx = ballRx();
    const ry = ballRy();
    ball.x = clamp(ball.x, rx, width - rx);
    ball.y = clamp(ball.y, ry, height - ry);
  }

  /** 给小球一个随机方向的初速度 */
  function launchBall(target?: number): void {
    const v = target ?? baseSpeed;
    const angle = Math.random() * Math.PI * 2;
    ball.vx = Math.cos(angle) * v;
    ball.vy = Math.sin(angle) * v;
    ball.pulse = 1;
  }

  function resetBall(): void {
    ball.x = width / 2;
    ball.y = height / 2;
    ball.spin = 0;
    // 台球模式下的「重置」只是把球摆回桌面中央，不该顺手把它推着跑起来
    if (billiardsMode) {
      ball.vx = 0;
      ball.vy = 0;
    } else {
      launchBall();
    }
    samples.length = 0;
    // 球被搬走了，上一处的落点判断作废
    settleHandled = true;
    cancelPendingLaunch();
  }

  // ------------------------------------------------------------------- 物理
  /**
   * 撞墙后的新速度：法线分量反向 → 整体随机偏转 ±BOUNCE_DEVIATION → 兜底修正。
   * 全程只做旋转，所以速率严格不变。
   *
   * @param outward 撞完墙后必须朝外的方向：左墙/上墙 +1，右墙/下墙 -1
   */
  function bounceVelocity(
    vx: number,
    vy: number,
    axis: 'x' | 'y',
    outward: 1 | -1,
  ): { x: number; y: number } {
    const s = Math.hypot(vx, vy);
    if (s === 0) return { x: vx, y: vy };

    // 1) 法线分量反向（用 abs 保证方向正确，避免多次碰撞后卡在墙上抖动）
    const nx = axis === 'x' ? Math.abs(vx) * outward : vx;
    const ny = axis === 'y' ? Math.abs(vy) * outward : vy;

    // 2) 整体随机偏转，这个角度就是「偏离法线」的量
    const angle = (Math.random() * 2 - 1) * BOUNCE_DEVIATION;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let rx = nx * cos - ny * sin;
    let ry = nx * sin + ny * cos;

    // 3) 兜底：偏转后法线分量必须朝外且够大，否则小球会贴着墙滑甚至钻出去
    const minNormal = s * MIN_NORMAL_RATIO;
    const normal = axis === 'x' ? rx : ry;
    if (Math.sign(normal) !== outward || Math.abs(normal) < minNormal) {
      const tangentialRaw = axis === 'x' ? ry : rx;
      const tangential =
        Math.sqrt(Math.max(s * s - minNormal * minNormal, 0)) *
        (tangentialRaw === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(tangentialRaw));
      if (axis === 'x') {
        rx = minNormal * outward;
        ry = tangential;
      } else {
        ry = minNormal * outward;
        rx = tangential;
      }
    }

    return { x: rx, y: ry };
  }

  function bounce(): void {
    // 左右用水平外接框、上下用竖直外接框：蛋比圆高，混用会让球在墙边"悬空"或"嵌进去"
    const rx = ballRx();
    const ry = ballRy();

    if (width <= rx * 2) {
      ball.x = width / 2;
      ball.vx = 0;
    } else if (ball.x - rx < 0) {
      ball.x = rx;
      // 只有「正往墙里走」才反弹。旋转本身会让外接框变大，那种情况把位置夹回来就够了，
      // 不能顺手再反一次速度 —— 否则球会贴着墙来回抖。
      if (ball.vx < 0) {
        const v = bounceVelocity(ball.vx, ball.vy, 'x', 1);
        ball.vx = v.x;
        ball.vy = v.y;
      }
    } else if (ball.x + rx > width) {
      ball.x = width - rx;
      if (ball.vx > 0) {
        const v = bounceVelocity(ball.vx, ball.vy, 'x', -1);
        ball.vx = v.x;
        ball.vy = v.y;
      }
    }

    if (height <= ry * 2) {
      ball.y = height / 2;
      ball.vy = 0;
    } else if (ball.y - ry < 0) {
      ball.y = ry;
      if (ball.vy < 0) {
        const v = bounceVelocity(ball.vx, ball.vy, 'y', 1);
        ball.vx = v.x;
        ball.vy = v.y;
      }
    } else if (ball.y + ry > height) {
      ball.y = height - ry;
      if (ball.vy > 0) {
        const v = bounceVelocity(ball.vx, ball.vy, 'y', -1);
        ball.vx = v.x;
        ball.vy = v.y;
      }
    }
  }

  /**
   * 速率向 baseSpeed 指数回落：抛出造成的提速会慢慢消失，最终稳定在常态速度。
   * 完全静止时不会自己动起来（没有方向可言），要动请拖一下或用面板里的按钮。
   */
  function relaxSpeed(dt: number): void {
    const s = speed();
    if (s === 0) return;

    const next = baseSpeed + (s - baseSpeed) * Math.exp(-dt / SPEED_RELAX_TAU_MS);

    // 目标本身就是 0，且已经慢到看不出来 → 直接归零。
    // 否则指数衰减永远到不了 0，小球会以极小速度一直漂移。
    if (next < 0.01) {
      ball.vx = 0;
      ball.vy = 0;
      return;
    }

    const k = next / s;
    ball.vx *= k;
    ball.vy *= k;
  }

  /**
   * 台球模式的摩擦：每帧从速率里**减掉一个固定量**（库仑摩擦），慢到零就停死。
   *
   * 跟 relaxSpeed 的区别是本质的：那个是指数衰减到某个非零的「常态速度」，
   * 数学上永远到不了 0；台球要的是「滚着滚着停住」，所以只能扣固定量。
   * 结果就是：轻轻一推走百来像素，满力一杆滚两千多像素、约 2.8s 停下。
   */
  function applyFriction(dt: number): void {
    const s = speed();
    if (s === 0) return;

    const frames = dt / (1000 / 60);
    const next = s - BILLIARD_DECEL * frames;
    if (next <= 0) {
      ball.vx = 0;
      ball.vy = 0;
      return;
    }

    const k = next / s;
    ball.vx *= k;
    ball.vy *= k;
  }

  /**
   * 推进旋转角：像球在地上滚一样，角速度正比于**水平**速度。
   * 方向取 vx 的符号 —— 向右滚顺时针、向左滚逆时针，撞到左右墙时 vx 反向，
   * 旋转方向也就跟着反过来，这正是「滚」该有的样子；上下墙不改变 vx，
   * 所以旋转是连续的。小球停下时 vx = 0，旋转自然也就停了。
   */
  function advanceSpin(dt: number): void {
    const a = spriteHalfW();
    if (a <= 0) return;
    const frames = dt / (1000 / 60);
    const delta = (2 * Math.PI * ball.vx * frames) / (SPIN_WIDTHS_PER_TURN * 2 * a);
    // 取模归一化：长时间运行也不会把角度累积成很大的数，浮点精度更稳
    ball.spin = (ball.spin + delta) % (Math.PI * 2);
  }

  // ------------------------------------------------------------------- 台球模式
  /**
   * 球面沿某个方向到球心的距离。
   * 贴图是蛋形（椭圆）不是圆：正着量是半宽、竖着量是半高，斜着介于两者之间。
   * 杆头的起点必须按这个算 —— 拿半宽当通用半径的话，竖着打的那一杆
   * 杆头一冒出来就已经埋在球里了，一松手就直接「击中」，力度完全失控。
   */
  function surfaceDistance(dirX: number, dirY: number): number {
    const a = spriteHalfW();
    const b = spriteHalfH();
    const len = Math.hypot(dirX / a, dirY / b);
    return len === 0 ? a : 1 / len;
  }

  /**
   * 指针在球的哪一侧，球就往**反**方向飞 —— 这正是拉杆：你把杆拉到左边，
   * 松手它朝右冲。所以击球方向是「从指针指向球心」。
   */
  function aimDirection(px: number, py: number): { x: number; y: number } {
    const dx = ball.x - px;
    const dy = ball.y - py;
    const len = Math.hypot(dx, dy);
    // 指针正好压在球心上：没有方向可言，沿用上一次的朝向，别让它变成 NaN
    if (len < 1) return { x: aimDir.x, y: aimDir.y };
    return { x: dx / len, y: dy / len };
  }

  /** 指针离球心越远 = 杆拉得越开。扣掉球面半径，所以「贴着球面」正好是 0 */
  function pullFromPointer(px: number, py: number): number {
    const dist = Math.hypot(px - ball.x, py - ball.y);
    return clamp(dist - spriteHalfW(), 0, CUE_MAX_PULL);
  }

  function beginAim(px: number, py: number): void {
    aimDir = aimDirection(px, py);
    aimPull = pullFromPointer(px, py);
    cueState = 'aiming';
    setInteractive(true);
  }

  /** 松手：拉够了就冲杆击球，没拉够（右键原地一点）就只是把杆收走 */
  function releaseCue(): void {
    if (aimPull < CUE_MIN_PULL) {
      cueState = 'off';
      aimPull = 0;
      refreshInteractivity();
      return;
    }

    cueDir = { x: aimDir.x, y: aimDir.y };
    cueOrigin = { x: ball.x, y: ball.y };
    cueRest = surfaceDistance(cueDir.x, cueDir.y);
    cueGap = aimPull;
    // 拉多远就冲多远，并且固定用掉 CUE_LUNGE_MS —— 于是「拉得深」同时意味着
    // 「冲得快」和「打得狠」，两个直觉一致，不用分别调
    cueLunge = aimPull / (CUE_LUNGE_MS / 1000) / 60;
    cuePower = CUE_MIN_SPEED + (aimPull / CUE_MAX_PULL) * (CUE_MAX_SPEED - CUE_MIN_SPEED);
    cueHoldLeft = 0;
    cueState = 'firing';
    setInteractive(true);
  }

  /** 真的顶上了：小球拿到初速度，方向就是锁定下来的杆轴 */
  function strikeBall(): void {
    ball.vx = cueDir.x * cuePower;
    ball.vy = cueDir.y * cuePower;
    ball.pulse = CUE_HIT_PULSE;
    cueState = 'holding';
    cueHoldLeft = CUE_HOLD_MS;

    // 新的一杆开始了：这一杆停稳时要重新找一次图标；
    // 同时把上一杆可能还挂着的倒计时撤掉（上一杆的落点已经不作数了）
    settleHandled = false;
    cancelPendingLaunch();
  }

  /**
   * 杆头前表面顶到球了没有。
   * 用「杆头相对球心的位移 ÷ 各自半轴」再取模长：1 就是正好贴在球面上。
   * 这样竖着打、斜着打的口径都一致（球是椭圆，横竖半径不一样）。
   *
   * 注意是**减** dir：dir 是击球方向（球的去向），球杆一定在反方向上。
   */
  function cueTipTouchesBall(): boolean {
    const reach = cueRest + cueGap;
    const tipX = cueOrigin.x - cueDir.x * reach;
    const tipY = cueOrigin.y - cueDir.y * reach;
    const u = Math.hypot((tipX - ball.x) / spriteHalfW(), (tipY - ball.y) / spriteHalfH());
    return u <= 1 + CUE_TIP_TOUCH / spriteHalfW();
  }

  /**
   * 推进球杆。注意 firing 这一段**不是动画**：击中判定就发生在这里面，
   * 所以满力那一杆一帧要切成十来个子步走，不然杆头会从球上直接穿过去。
   */
  function updateCue(dt: number): void {
    if (cueState === 'firing') {
      let travel = cueLunge * (dt / (1000 / 60));
      while (travel > 0 && cueState === 'firing') {
        const step = Math.min(travel, CUE_LUNGE_SUBSTEP);
        travel -= step;
        cueGap = Math.max(0, cueGap - step);

        if (cueTipTouchesBall()) {
          strikeBall();
          break;
        }
        if (cueGap <= 0) {
          // 冲到头也没碰到 —— 球在这 90ms 里滚开了，这杆空了
          cueState = 'holding';
          cueHoldLeft = CUE_HOLD_MS;
          break;
        }
      }
      return;
    }

    if (cueState === 'holding') {
      cueHoldLeft -= dt;
      if (cueHoldLeft <= 0) {
        cueState = 'off';
        aimPull = 0;
      }
    }
  }

  /** 台球模式下窗口接管鼠标的范围：球周围一大圈，否则全屏穿透的窗口收不到右键 */
  function isOverAimArea(x: number, y: number): boolean {
    return Math.hypot(x - ball.x, y - ball.y) <= BILLIARD_AIM_RADIUS;
  }

  /** 切换台球模式（面板里那个勾选框） */
  function setBilliardsMode(on: boolean): void {
    if (billiardsMode === on) return;
    billiardsMode = on;

    // 两种模式的交互模型完全不同，切换时把中间状态一次性清干净，
    // 免得出现「拖到一半切模式」这种半截状态
    pressing = false;
    dragging = false;
    draggingHasMoved = false;
    leftClickOnBall = false;
    samples.length = 0;
    cueState = 'off';
    aimPull = 0;
    // 换模式时把「停稳开应用」也一并清干净：没打完的倒计时不该跨模式活下来
    settleHandled = true;
    cancelPendingLaunch();

    if (on) {
      // 进台球模式：球先安静下来，等着挨杆
      ball.vx = 0;
      ball.vy = 0;
    } else if (isAtRest() && baseSpeed > 0) {
      // 退出去时球还停着的话，给它一个常态速度 —— 否则桌面上留一颗死球，
      // 跟「这是个会自己滚的桌面宠物」这个前提就矛盾了
      launchBall(baseSpeed);
    }

    syncMenuMode();
    refreshInteractivity();
  }

  /** 模式相关的面板元素（勾选框、提示语、按钮）一起对齐 */
  function syncMenuMode(): void {
    billiardToggle.checked = billiardsMode;
    billiardHint.hidden = !billiardsMode;
    hintText.hidden = billiardsMode;
    hintText.textContent = billiardsMode ? HINT_BILLIARD : HINT_NORMAL;
    syncResumeButton();
  }

  // --------------------------------------------------------------- 停稳开应用
  /**
   * 触点落在哪个图标上（都不在就返回 null）。
   *
   * 只认 launchable 的：桌面上的「回收站」这类虚拟项没有文件系统实体，停上去就该
   * 什么都不发生，而不是高亮一个根本打不开的东西。同理，「读不到图标」和
   * 「脚下没有图标」在调用方看来是同一条路径 —— 都不高亮。
   */
  function findIconAt(x: number, y: number, icons: DesktopIcon[]): DesktopIcon | null {
    let best: DesktopIcon | null = null;
    let bestDist = Infinity;
    for (const icon of icons) {
      if (!icon.launchable) continue;
      if (x < icon.x - ICON_HIT_PAD || x > icon.x + icon.size + ICON_HIT_PAD) continue;
      if (y < icon.y - ICON_HIT_PAD || y > icon.y + icon.size + ICON_HIT_PAD) continue;
      // 命中区理论上互不重叠（60 < 75），真重叠了就取离球心最近的那个
      const d = Math.hypot(x - (icon.x + icon.size / 2), y - (icon.y + icon.size / 2));
      if (d < bestDist) {
        bestDist = d;
        best = icon;
      }
    }
    return best;
  }

  /** 取消待启动 —— 动鼠标 / 再打一杆 / 退出台球模式 / 重置小球都会走这里 */
  function cancelPendingLaunch(): void {
    pendingLaunch = null;
  }

  /**
   * 小球在台球模式下刚刚停稳。
   *
   * ★ 这里**不能同步等** IPC：我们在 requestAnimationFrame 的回调里，而主进程要花
   * 几毫秒去读 explorer 的图标列表。所以先异步取回来，回来时再复核一次「球还在原地
   * 停着吗」—— 否则可能出现「球早就被打出去了，倒计时却在别的地方冒出来」。
   */
  function onBallSettled(): void {
    if (settleHandled) return;
    settleHandled = true;
    if (!billiardsMode) return;

    const bridge = api;
    if (!bridge || !bridge.readDesktopIcons) return;

    const atX = ball.x;
    const atY = ball.y;

    void bridge
      .readDesktopIcons()
      .then((icons) => {
        if (!billiardsMode || pendingLaunch) return;
        // 异步这几毫秒里球要是又动起来 / 被重置了，这一次就作废
        if (!isAtRest() || Math.hypot(ball.x - atX, ball.y - atY) > 1) return;

        const hit = findIconAt(atX, atY, icons || []);
        if (!hit) return;

        pendingLaunch = {
          icon: hit,
          left: ICON_LAUNCH_DELAY_MS,
          mouseX: pointer.x,
          mouseY: pointer.y,
        };
      })
      .catch(() => {
        // 读不到图标（koffi 没装上 / explorer 异常 / 不是 Windows）→ 什么都不做。
        // 这是设计好的降级路径，不是错误，不用打扰用户。
      });
  }

  /** 倒计时推进；到点就请主进程启动 */
  function advanceLaunchCountdown(dt: number): void {
    if (!pendingLaunch) return;

    pendingLaunch.left -= dt;
    if (pendingLaunch.left > 0) return;

    const target = pendingLaunch.icon;
    pendingLaunch = null;

    // 再确认一次这 1.5 秒里球确实没被动过。理论上不可能，但「启动应用」是个
    // 有副作用的动作，多这一层判断很便宜，能挡住所有没想到的路径。
    if (!billiardsMode || !isAtRest()) return;
    void api?.launchDesktopIcon?.(target.name);
  }

  // ------------------------------------------------------------------- 按压 / 拖拽
  function beginPress(x: number, y: number): void {
    pressing = true;
    dragging = false;
    draggingHasMoved = false;
    pressStartTime = performance.now();
    pressOrigin = { x, y };
    setInteractive(true);
  }

  /** 取消按压：小球带着原来的速度继续走 */
  function cancelPress(): void {
    pressing = false;
    refreshInteractivity();
  }

  /** 长按达成 → 真正进入拖拽 */
  function activateDrag(): void {
    pressing = false;
    dragging = true;
    draggingHasMoved = false;
    samples.length = 0;
    samples.push({ t: performance.now(), x: ball.x, y: ball.y });
    setInteractive(true);
  }

  /** 用最近 90ms 的位移估算「每帧速度」 */
  function dragVelocity(): { x: number; y: number } {
    if (samples.length < 2) return { x: 0, y: 0 };

    const now = performance.now();
    let recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS);
    if (recent.length < 2) recent = samples.slice(-2);

    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return { x: 0, y: 0 };

    const frames = 1000 / 60 / dt; // 毫秒 → 帧
    return limitSpeed((last.x - first.x) * frames, (last.y - first.y) * frames);
  }

  function releaseBall(): void {
    if (!dragging) return;
    dragging = false;

    const v = dragVelocity();
    ball.vx = v.x;
    ball.vy = v.y;

    samples.length = 0;
    refreshInteractivity();
  }

  /** 单击小球：停下 + 呼出 / 收起设置面板 */
  function handleBallClick(): void {
    ball.vx = 0;
    ball.vy = 0;
    ball.pulse = 1;
    toggleMenu();
  }

  // ------------------------------------------------------------------- 设置面板
  function syncResumeButton(): void {
    // 台球模式下小球本来就该停着等杆，「让它动起来」会跟这个前提打架，直接藏掉
    resumeButton.hidden = billiardsMode || !isAtRest();
  }

  function positionMenu(): void {
    if (!menuOpen) return;
    // 先藏起来再量尺寸，避免在错误位置闪一下
    menu.style.visibility = 'hidden';
    const rect = menu.getBoundingClientRect();

    const gap = 12;
    const rx = ballRx();

    let left = ball.x + rx + gap;
    let top = ball.y - rect.height / 2;
    if (left + rect.width > width - 8) {
      left = ball.x - rx - gap - rect.width; // 右边放不下就翻到左边
    }
    left = clamp(left, 8, Math.max(8, width - rect.width - 8));
    top = clamp(top, 8, Math.max(8, height - rect.height - 8));

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.visibility = '';

    menuRect = { left, top, right: left + rect.width, bottom: top + rect.height };
  }

  /** 贴图是椭圆，把宽 × 高都报出来，比只写「直径」清楚 */
  function sizeLabel(): string {
    const w = Math.round(ball.radius * 2);
    const h = Math.round(ball.radius * 2 * SPRITE_ASPECT);
    return `${w} × ${h} px`;
  }

  function syncMenuValues(): void {
    speedInput.value = String(baseSpeed);
    speedValue.textContent = `${baseSpeed.toFixed(1)} px/帧`;
    sizeInput.value = String(Math.round(ball.radius));
    sizeValue.textContent = sizeLabel();
    syncResumeButton();
  }

  function openMenu(): void {
    if (menuOpen) return;
    menuOpen = true;
    syncMenuValues();
    // 面板关着的时候音频可能已经播完（或还在播），重开时按钮得跟真实状态对齐，
    // 否则会出现「按钮写着播放笑声、其实声音还在响」这种对不上的情况
    syncLaughButton();
    // 勾选框 / 提示语同理：面板关着时模式也可能被改过（例如托盘重置）
    syncMenuMode();

    menu.hidden = false;
    positionMenu();
    refreshInteractivity();
  }

  function closeMenu(): void {
    if (!menuOpen) return;
    menuOpen = false;
    menu.hidden = true;
    menuRect = null;
    menuEngaged = false;
    refreshInteractivity();
  }

  function toggleMenu(): void {
    if (menuOpen) closeMenu();
    else openMenu();
  }

  speedInput.addEventListener('input', () => {
    baseSpeed = Number(speedInput.value);
    speedValue.textContent = `${baseSpeed.toFixed(1)} px/帧`;
    // 小球停着的时候调速度 → 立刻带起来，滑块才有即时反馈。
    // 台球模式例外：那儿的小球就该停着，拖滑块不该把它推出去
    if (!billiardsMode && isAtRest() && baseSpeed > 0) launchBall(baseSpeed);
    syncResumeButton();
  });

  sizeInput.addEventListener('input', () => {
    ball.radius = Number(sizeInput.value);
    sizeValue.textContent = sizeLabel();
    keepBallInside();
  });

  resumeButton.addEventListener('click', () => {
    launchBall(baseSpeed > 0 ? baseSpeed : DEFAULT_BASE_SPEED);
    syncResumeButton();
  });

  menuClose.addEventListener('click', closeMenu);
  // 播放 / 停止 是同一个按钮的两种状态：播放中再点就是停，长音频才收得住
  laughButton.addEventListener('click', toggleLaugh);
  billiardToggle.addEventListener('change', () => setBilliardsMode(billiardToggle.checked));

  // 操作面板期间必须一直保持可交互，否则鼠标划出面板就会丢掉滑块
  menu.addEventListener('pointerdown', () => {
    menuEngaged = true;
    setInteractive(true);
  });

  window.addEventListener('pointerup', () => {
    if (!menuEngaged) return;
    menuEngaged = false;
    refreshInteractivity();
  });

  window.addEventListener('pointercancel', () => {
    if (!menuEngaged) return;
    menuEngaged = false;
    refreshInteractivity();
  });

  // ------------------------------------------------------------------- 鼠标事件
  window.addEventListener('mousemove', (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.seen = true;

    // 停稳后的倒计时：鼠标一动就取消（回到「球停在那儿，什么都没发生」）。
    // 按「相对倒计时开始时的位移」判断，而不是收到 mousemove 就取消 ——
    // 窗口重绘 / 驱动抖动会派发零位移的 mousemove，那样倒计时会被自己瞬间取消。
    if (pendingLaunch) {
      const moved = Math.hypot(
        event.clientX - pendingLaunch.mouseX,
        event.clientY - pendingLaunch.mouseY,
      );
      if (moved > ICON_CANCEL_MOVE) cancelPendingLaunch();
    }

    // 台球模式：按住右键的时候球杆一路跟着指针（角度 + 拉杆量）
    if (cueState === 'aiming') {
      aimDir = aimDirection(event.clientX, event.clientY);
      aimPull = pullFromPointer(event.clientX, event.clientY);
      setInteractive(true);
      return;
    }

    if (dragging) {
      const moved = Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y);
      if (!draggingHasMoved && moved > MOVE_TOLERANCE) {
        draggingHasMoved = true;
        // 一旦真的拖动起来，就清掉自身速度，纯跟手
        ball.vx = 0;
        ball.vy = 0;
      }

      // 拖拽中不允许出屏
      const rx = ballRx();
      const ry = ballRy();
      ball.x = clamp(event.clientX, rx, width - rx);
      ball.y = clamp(event.clientY, ry, height - ry);

      samples.push({ t: performance.now(), x: ball.x, y: ball.y });
      if (samples.length > SAMPLE_LIMIT) samples.shift();

      setInteractive(true);
      return;
    }

    if (pressing) {
      // 还没到长按阈值就移动 → 本次按压作废，小球带原速度继续
      const moved = Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y);
      if (moved > PRESS_CANCEL_TOLERANCE) cancelPress();
      return;
    }

    refreshInteractivity();
  });

  window.addEventListener('mousedown', (event) => {
    // 右键 = 台球模式的球杆（正常模式下什么都不做，右键本来就是留给系统的）
    if (event.button === 2) {
      if (!billiardsMode) return;
      if (isFromMenu(event.target) || isOverMenu(event.clientX, event.clientY)) return;
      // 冲杆 / 收杆期间不接受新的瞄准：等这一杆走完，免得一次点击打两下
      if (cueState !== 'off') return;

      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.seen = true;
      beginAim(event.clientX, event.clientY);
      event.preventDefault();
      return;
    }

    if (event.button !== 0) return;
    // 面板上的点击交给面板自己处理
    if (isFromMenu(event.target)) return;
    if (isOverMenu(event.clientX, event.clientY)) return;

    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.seen = true;

    if (!isInsideBall(event.clientX, event.clientY)) {
      refreshInteractivity();
      return;
    }

    // 台球模式：左键拖不动球，点一下只负责开关面板
    if (billiardsMode) {
      leftClickOnBall = true;
      event.preventDefault();
      return;
    }

    beginPress(event.clientX, event.clientY);
    event.preventDefault();
  });

  window.addEventListener('mouseup', (event) => {
    // 右键松手 = 出杆
    if (event.button === 2) {
      if (billiardsMode && cueState === 'aiming') {
        releaseCue();
        event.preventDefault();
      }
      return;
    }

    if (event.button !== 0) return;
    if (isFromMenu(event.target)) return;

    if (billiardsMode) {
      if (leftClickOnBall) {
        leftClickOnBall = false;
        handleBallClick();
        refreshInteractivity();
      }
      return;
    }

    if (pressing) {
      // 短按松手 → 点击：停下 + 呼出面板
      pressing = false;
      handleBallClick();
      refreshInteractivity();
      return;
    }

    if (dragging) releaseBall();
  });

  // 指针离开窗口（例如拖到任务栏上）时兜底收尾，避免按压状态卡死
  document.addEventListener('mouseleave', () => {
    pointer.seen = false;
    if (dragging) releaseBall();
    pressing = false;
    leftClickOnBall = false;
    setInteractive(false);
  });

  window.addEventListener('blur', () => {
    pointer.seen = false;
    if (dragging) releaseBall();
    pressing = false;
    leftClickOnBall = false;
    setInteractive(false);
  });

  window.addEventListener('contextmenu', (event) => event.preventDefault());
  window.addEventListener('resize', resize);

  // ------------------------------------------------------------------- 主循环
  function update(dt: number): void {
    // 长按判定
    if (pressing && performance.now() - pressStartTime >= LONG_PRESS_MS) {
      activateDrag();
    }

    if (ball.pulse > 0) {
      ball.pulse = Math.max(0, ball.pulse - dt / PULSE_DECAY_MS);
    }

    // 球杆跟球的运动必须在同一拍上：击中判定就发生在这里面。
    // 放在积分之前 —— 这一帧刚被打出去的球，本该这一帧就开始走
    updateCue(dt);

    // 按压待定期间小球原地不动（速度保留，取消按压时接着飞）
    if (!paused && !dragging && !pressing) {
      // 台球用恒定减速度（库仑摩擦），会真的停死；
      // 正常模式用指数衰减回落到常态速度，两者不能混
      if (billiardsMode) {
        // 「刚停稳」只看这一帧的变化：applyFriction 会让速度**真的归零**，
        // 所以 动→停 这个边沿只出现一次，不用额外加去抖
        const wasMoving = !isAtRest();
        applyFriction(dt);
        if (wasMoving && isAtRest()) onBallSettled();
      } else {
        relaxSpeed(dt);
      }
      // 先推进旋转，再让碰撞按「转完之后」的外接框来算
      advanceSpin(dt);
      const k = dt / (1000 / 60);
      ball.x += ball.vx * k;
      ball.y += ball.vy * k;
      bounce();
    }

    // 倒计时（暂停时也冻住：托盘点了暂停就该真的什么都不发生）
    if (!paused) advanceLaunchCountdown(dt);

    // 停 / 动状态变化时同步面板上的「让它动起来」按钮
    const atRest = isAtRest();
    if (atRest !== lastAtRest) {
      lastAtRest = atRest;
      if (menuOpen) syncResumeButton();
    }

    refreshInteractivity();
  }

  /**
   * 画一段「有粗细变化」的杆体 —— 一个梯形。
   * 球杆就是两段这样的梯形拼起来的：黑色的长杆身 + 浅色的短皮头。
   * 用多边形而不是 stroke：canvas 的 lineWidth 在一根线上是恒定的，
   * 画不出「杆尾粗、杆头细」这种从后往前收的样子。
   */
  function drawStick(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    halfFrom: number,
    halfTo: number,
    color: string,
  ): void {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;

    // 垂直于杆轴的单位向量，用它把「粗细」铺到两侧
    const px = -dy / len;
    const py = dx / len;

    ctx.beginPath();
    ctx.moveTo(fromX + px * halfFrom, fromY + py * halfFrom);
    ctx.lineTo(toX + px * halfTo, toY + py * halfTo);
    ctx.lineTo(toX - px * halfTo, toY - py * halfTo);
    ctx.lineTo(fromX - px * halfFrom, fromY - py * halfFrom);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  /** 台球模式的球杆：瞄准虚线 + 黑色长杆 + 浅色皮头 */
  function drawCue(): void {
    if (cueState === 'off') return;

    // aiming 阶段一切都锚在当前球心上（球要是还在滚，杆就跟着它走）；
    // firing / holding 用的是松手那一刻锁下来的轴和起点，所以球飞走了杆还留在原地
    const aiming = cueState === 'aiming';
    const dir = aiming ? aimDir : cueDir;
    const anchor = aiming ? ball : cueOrigin;
    const gap = aiming ? aimPull : cueGap;
    const rest = aiming ? surfaceDistance(dir.x, dir.y) : cueRest;

    const reach = rest + gap;
    // 球杆在球的**反**方向：dir 是球被打出去的方向，杆当然在另一侧拉弓
    const tipX = anchor.x - dir.x * reach;
    const tipY = anchor.y - dir.y * reach;

    // 瞄准虚线：从球面往外画，让人一眼看清这一杆会把球送去哪儿。
    // 从球面起而不是球心起，免得线横穿球面盖住贴图
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = CUE_COLOR;
    ctx.lineWidth = 1.5;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(ball.x + dir.x * rest, ball.y + dir.y * rest);
    ctx.lineTo(ball.x + dir.x * (rest + CUE_AIM_LINE), ball.y + dir.y * (rest + CUE_AIM_LINE));
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    ctx.restore();

    // 杆身：从杆头往后延伸 CUE_LENGTH
    const buttX = tipX - dir.x * CUE_LENGTH;
    const buttY = tipY - dir.y * CUE_LENGTH;
    drawStick(tipX, tipY, buttX, buttY, CUE_TIP_WIDTH / 2, CUE_BUTT_WIDTH / 2, CUE_COLOR);

    // 皮头：压在杆身最前面的一小段浅色，让「哪头是杆头」看得清
    const bandX = tipX - dir.x * CUE_TIP_BAND;
    const bandY = tipY - dir.y * CUE_TIP_BAND;
    drawStick(tipX, tipY, bandX, bandY, CUE_TIP_WIDTH / 2, CUE_TIP_WIDTH / 2 + 0.4, CUE_TIP_COLOR);
  }

  /**
   * 停稳后的目标图标：高亮框 + 倒计时环 + 名字牌。
   *
   * 三样东西各有分工，缺一不可：
   *   · 高亮框   —— 「就是它」，明确框住哪一个图标
   *   · 倒计时环 —— 「还剩多久」，闭上的环一眼能看出进度，也说明随时能反悔
   *   · 名字牌   —— 「会打开什么」，有些图标的图案本身看不出来是啥，名字最实在
   *
   * 全部画在球**下面**：框和环的尺寸都在球之外，球自己始终清清楚楚。
   */
  function drawLaunchTarget(): void {
    if (!pendingLaunch) return;
    const icon = pendingLaunch.icon;
    const side = icon.size;
    const progress = clamp(1 - pendingLaunch.left / ICON_LAUNCH_DELAY_MS, 0, 1);

    const boxX = icon.x - ICON_HILITE_PAD;
    const boxY = icon.y - ICON_HILITE_PAD;
    const boxSide = side + ICON_HILITE_PAD * 2;
    // 圆角跟着图标大小走：大图标用大圆角才不显得方
    const boxRadius = clamp(boxSide * 0.18, 4, 12);

    // ---- 高亮框
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(boxX, boxY, boxSide, boxSide, boxRadius);
    } else {
      ctx.rect(boxX, boxY, boxSide, boxSide);
    }
    ctx.fillStyle = ICON_HILITE_FILL;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = ICON_HILITE_COLOR;
    ctx.stroke();

    // ---- 倒计时环：底环一直淡着，进度弧从正上方顺时针画满
    const cx = icon.x + side / 2;
    const cy = icon.y + side / 2;
    const ringR = side / 2 + ICON_HILITE_PAD + 9;
    ctx.lineWidth = 3;

    ctx.strokeStyle = ICON_RING_TRACK;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();

    if (progress > 0) {
      ctx.strokeStyle = ICON_HILITE_COLOR;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.stroke();
    }

    // ---- 名字牌
    if (!icon.name) return;
    ctx.font = ICON_LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const canMeasure = typeof ctx.measureText === 'function';
    const maxTextW = ICON_LABEL_MAX_W - ICON_LABEL_PAD_X * 2;
    let text = ICON_LABEL_PREFIX + icon.name;
    if (canMeasure) {
      const full = ctx.measureText(text).width;
      // 按比例先掐一刀，再量一次兜底 —— 避免「一个字一个字地试」把每帧都拖慢
      if (full > maxTextW) {
        const keep = Math.max(1, Math.floor(text.length * (maxTextW / full)) - 1);
        text = `${text.slice(0, keep)}…`;
        if (ctx.measureText(text).width > maxTextW && text.length > 2) {
          text = `${text.slice(0, Math.max(1, text.length - 3))}…`;
        }
      }
    }

    const textW = canMeasure ? ctx.measureText(text).width : text.length * 7;
    const pillW = textW + ICON_LABEL_PAD_X * 2;
    // 默认挂在图标下方；下方装不下就翻到上方（贴着屏幕底边的图标会遇到）
    const belowY = boxY + boxSide + ICON_LABEL_GAP;
    const pillY = Math.round(belowY + ICON_LABEL_H > height ? boxY - ICON_LABEL_GAP - ICON_LABEL_H : belowY);
    const pillX = Math.round(clamp(cx - pillW / 2, 4, Math.max(4, width - pillW - 4)));

    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(pillX, pillY, pillW, ICON_LABEL_H, ICON_LABEL_H / 2);
    } else {
      ctx.rect(pillX, pillY, pillW, ICON_LABEL_H);
    }
    ctx.fillStyle = ICON_LABEL_BG;
    ctx.fill();

    ctx.fillStyle = ICON_LABEL_FG;
    ctx.fillText(text, pillX + pillW / 2, pillY + ICON_LABEL_H / 2 + 0.5);
  }

  function draw(): void {
    ctx.clearRect(0, 0, width, height);

    // 高亮框 / 倒计时环 / 名字牌都画在球底下：它们的尺寸本来就在球之外，
    // 这样球本身永远干干净净
    drawLaunchTarget();

    const x = ball.x;
    const y = ball.y;
    // 这里必须用**未旋转**的半宽 / 半高：旋转交给画布变换去做，贴图自身尺寸不变。
    // （ballRx/ballRy 返回的是旋转后的外接框，那只用于碰撞，会随着角度摆动。）
    const a = spriteHalfW();
    const b = spriteHalfH();

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ball.spin);

    if (spriteReady) {
      // 贴图本身就是平面化的蛋形（没有光影、没有外发光），整张贴上去即可。
      // 这里缩放比常常远小于 1（贴图 448px 宽 → 屏幕上可能只有 48px），
      // 所以上面开了高质量重采样，边缘才不会发毛。
      ctx.drawImage(sprite, -a, -b, a * 2, b * 2);
    } else {
      // 贴图还没解码完的兜底：画个同色椭圆，避免第一帧闪出空白
      ctx.beginPath();
      ctx.ellipse(0, 0, a, b, 0, 0, Math.PI * 2);
      ctx.fillStyle = SPRITE_FALLBACK_COLOR;
      ctx.fill();
    }

    ctx.restore();

    // 球杆画在小球之后：杆头本来就在球面外侧，压上去也不打架
    drawCue();
  }

  let lastFrame = 0;
  let firstFrameDone = false;

  function frame(now: number): void {
    const dt = Math.min(now - lastFrame, MAX_STEP_MS);
    lastFrame = now;

    update(dt);
    draw();

    // 首帧画出来说明画布管线是通的（排查「窗口全透明什么都看不见」时很有用）
    if (!firstFrameDone) {
      firstFrameDone = true;
      console.log(
        `[ball] 首帧绘制完成  rx=${ballRx().toFixed(1)} ry=${ballRy().toFixed(1)}` +
          `  贴图=${spriteReady ? '已就绪' : '未加载(走兜底椭圆)'}`,
      );
    }

    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------- 来自主进程
  api?.onPaused((value) => {
    paused = value;
  });

  api?.onReset(() => {
    closeMenu();
    resetBall();
  });

  api?.onLayoutChanged(() => {
    resize();
  });

  // ------------------------------------------------------------------- 启动
  resize();
  resetBall();
  syncMenuMode();

  speedInput.min = String(SPEED_RANGE.min);
  speedInput.max = String(SPEED_RANGE.max);
  speedInput.step = String(SPEED_RANGE.step);
  sizeInput.min = String(RADIUS_RANGE.min);
  sizeInput.max = String(RADIUS_RANGE.max);
  sizeInput.step = String(RADIUS_RANGE.step);

  requestAnimationFrame((now) => {
    lastFrame = now;
    requestAnimationFrame(frame);
  });

  console.log(`[ball] renderer ready ${width}x${height} dpr=${window.devicePixelRatio}`);
})();
