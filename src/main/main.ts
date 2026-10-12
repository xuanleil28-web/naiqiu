/**
 * 主进程
 * ---------------------------------------------------------------------------
 * 负责创建那块「铺满主屏工作区」的透明无边框窗口，并提供托盘菜单与鼠标穿透开关。
 *
 * 关键点：
 *  1. transparent + frame:false + skipTaskbar + alwaysOnTop('screen-saver')
 *  2. focusable:false —— 永不抢焦点（打字、游戏都不会被打断）
 *  3. 默认 setIgnoreMouseEvents(true, { forward: true })
 *     - ignore  = true  → 鼠标事件穿透到桌面
 *     - forward = true  → 仍然把 mousemove 转发给渲染进程，这样小球才能感知悬停
 *  4. 渲染进程通过 IPC 'set-interactive' 动态切换穿透状态
 *  5. 台球模式下小球停稳后「停在哪个图标就打开哪个应用」，读图标与启动都在这里
 *     做（见 icons.ts）—— 渲染进程只拿坐标和名字，不碰任何系统调用
 */
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  screen,
} from 'electron';
import * as path from 'path';

import {
  isIconLaunchSupported,
  launchDesktopIcon,
  readDesktopIcons,
} from './icons';

// --------------------------------------------------------------------------- 环境自检
// 如果本进程的 ELECTRON_RUN_AS_NODE=1，electron.exe 会被当成普通 Node 启动，
// require('electron') 只会返回一个「可执行文件路径字符串」，下面的 app 就是 undefined。
// 从某些 Electron 宿主（比如 IDE 内置终端）里启动时很容易踩到这个坑，这里给一句人话提示。
if (!app) {
  console.error(
    [
      '',
      '✗ Electron API 不可用：当前 electron.exe 是以「纯 Node 模式」启动的。',
      '  原因通常是环境变量 ELECTRON_RUN_AS_NODE=1（会被子进程继承）。',
      '',
      '  解决办法（任选其一）：',
      '    · 换一个系统终端（cmd / PowerShell / Windows Terminal）再执行 npm run dev',
      '    · 或先清掉该变量：  unset ELECTRON_RUN_AS_NODE   （PowerShell: $env:ELECTRON_RUN_AS_NODE=""）',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// dist/main/main.js → ../../assets   （打包后位于 app.asar/assets）
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');
const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'index.html');

/**
 * 兜底开关：极少数 Windows 环境下 `focusable:false` 会导致窗口收不到鼠标事件，
 * 此时用 BALL_FOCUSABLE=1 启动即可恢复交互（代价是窗口会被激活）。
 */
const FORCE_FOCUSABLE = process.env.BALL_FOCUSABLE === '1';

/**
 * 调试开关：BALL_HEADLESS=1 时创建窗口但不显示，用来在不打扰用户的前提下
 * 验证「主进程能否正常启动、preload 与页面能否正常加载」。
 */
const HEADLESS = process.env.BALL_HEADLESS === '1';

/**
 * 显卡兼容开关：BALL_DISABLE_GPU=1 时关闭硬件加速。
 * 透明窗口 + 某些老显卡驱动 / 远程桌面 / 虚拟机里，GPU 合成进程可能反复崩溃，
 * 表现为窗口全黑或整个应用直接退出。关掉硬件加速后走软件光栅化，
 * 对这种只有一个圆球的 2D 画布来说帧率完全够用。
 */
const DISABLE_GPU = process.env.BALL_DISABLE_GPU === '1';

// 必须在 app ready 之前调用
if (DISABLE_GPU) {
  app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

/** 是否暂停（暂停时小球不动，但仍可拖动/点击） */
let isPaused = false;
/** 当前是否处于「接收鼠标事件」模式；false = 穿透 */
let isInteractive = false;
/** 主动退出标记，避免 window-all-closed 干扰托盘常驻逻辑 */
let isQuitting = false;

// --------------------------------------------------------------------------- 单实例

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 重复启动时给个反馈：把小球重置回屏幕中央
    sendToRenderer('reset-ball');
  });
  bootstrap();
}

function bootstrap(): void {
  app.whenReady().then(() => {
    createWindow();
    createTray();

    // 启动时先探一次「读桌面图标」的能力并写进日志。
    // 用户那边万一 koffi 没装上（网络 / 镜像 / 被杀软删了），这一行就能直接说明问题，
    // 而不是等小球停到图标上毫无反应、只能猜。
    console.log(
      `[main] 桌面图标启动：${isIconLaunchSupported() ? '可用' : '不可用（koffi 未加载，或不是 Windows）'}`,
    );

    // 分辨率 / 缩放变化时重新铺满主屏工作区
    screen.on('display-metrics-changed', fitToPrimaryDisplay);
    screen.on('display-added', fitToPrimaryDisplay);
    screen.on('display-removed', fitToPrimaryDisplay);
  });

  // 渲染进程切换鼠标穿透 ----------------------------------------------------
  // 'set-interactive' true  → 窗口接收鼠标事件（可以拖动小球）
  // 'set-interactive' false → 恢复穿透，鼠标操作落到桌面
  ipcMain.on('set-interactive', (event, value: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    setInteractive(Boolean(value));
  });

  // 渲染进程读桌面图标（台球模式停稳后看停在哪个图标上） ----------------------
  // 用 handle 而不是 on：渲染进程要拿到结果。失败一律返回空数组 ——
  // 「桌面没有图标」和「读不到图标」在渲染进程那边走同一条路径（都不高亮），
  // 这样渲染层不需要区分错误类型。
  ipcMain.handle('read-desktop-icons', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return [];
    try {
      return readDesktopIcons(mainWindow);
    } catch (err) {
      console.error('[main] 读桌面图标出错：', err);
      return [];
    }
  });

  // 渲染进程请求启动某个图标对应的应用 ---------------------------------------
  // ★ 只收「名字」，不收路径。真正打开哪个文件由主进程自己在桌面上找，
  //   渲染进程这边即使被注入了什么也没有「给个路径就执行」的口子。
  ipcMain.handle('launch-desktop-icon', async (event, name: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return { ok: false, error: 'forbidden' };
    }
    try {
      const result = await launchDesktopIcon(name);
      if (result.ok) console.log(`[main] 已启动桌面图标「${String(name)}」→ ${result.target}`);
      else console.warn(`[main] 启动桌面图标「${String(name)}」失败：${result.error}`);
      return result;
    } catch (err) {
      console.error('[main] 启动桌面图标时出错：', err);
      return { ok: false, error: String(err) };
    }
  });

  app.on('window-all-closed', () => {
    // 这是一块常驻桌面挂件，窗口没了就直接退出
    app.quit();
  });

  // GPU 合成进程反复崩溃时给一句可执行的提示（不自动重启，避免陷入重启循环）
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU' || DISABLE_GPU) return;
    console.error(
      `[main] GPU 进程异常退出（reason=${details.reason}）。\n` +
        '       如果窗口发黑或应用反复退出，请用 BALL_DISABLE_GPU=1 启动以关闭硬件加速。',
    );
  });

  app.on('before-quit', () => {
    isQuitting = true;
    tray?.destroy();
    tray = null;
  });
}

// --------------------------------------------------------------------------- 窗口

function createWindow(): void {
  const area = screen.getPrimaryDisplay().workArea;

  mainWindow = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,

    // 外观：透明、无边框、无阴影
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: '#00000000',

    // 行为：不进任务栏、不可缩放移动、不抢焦点、始终置顶
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: FORCE_FOCUSABLE,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    show: false,
    title: '奶球',
    // 窗口图标 = 那颗黄色蛋形小生物。打包后 Windows 一般直接用 exe 里嵌的图标，
    // 但 dev（npm run dev，跑的是 node_modules 里的 electron.exe）和免安装版都得靠这一份，
    // 否则任务栏按钮 / Alt+Tab 会显示 Electron 的默认图标
    icon: loadAppIcon(),

    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 窗口失焦也要保持动画流畅
      devTools: !app.isPackaged,
    },
  });

  // 'screen-saver' 层级能压住大多数普通窗口（Windows 上该参数会被忽略，无副作用）
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  // 多桌面跟随只在 macOS / Linux 上有实现，Windows 调用会报 Not implemented
  if (process.platform !== 'win32') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  mainWindow.setMenuBarVisibility(false);

  // ★ 默认全屏穿透：鼠标从窗口「穿过去」，但 mousemove 仍转发给渲染进程
  applyMouseIgnore();

  mainWindow.loadFile(RENDERER_HTML);

  mainWindow.once('ready-to-show', () => {
    // showInactive：显示但不抢焦点
    if (!HEADLESS) mainWindow?.showInactive();
    mainWindow?.setAlwaysOnTop(true, 'screen-saver');
    applyMouseIgnore();
    console.log(
      `[main] window ready  ${area.width}x${area.height} @ (${area.x}, ${area.y})  ` +
        `focusable=${FORCE_FOCUSABLE}  headless=${HEADLESS}  name=${app.getName()}`,
    );
  });

  // 透明窗口在某些全屏应用切换后可能丢掉置顶 / 穿透状态，这里补一刀
  mainWindow.on('show', () => {
    mainWindow?.setAlwaysOnTop(true, 'screen-saver');
    applyMouseIgnore();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    // 渲染进程刚起来时同步一次暂停状态
    sendToRenderer('set-paused', isPaused);
  });
}

/** 重新贴回主屏工作区（不含任务栏） */
function fitToPrimaryDisplay(): void {
  if (!mainWindow) return;
  const area = screen.getPrimaryDisplay().workArea;
  mainWindow.setBounds({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
  });
  applyMouseIgnore();
  sendToRenderer('layout-changed');
}

// --------------------------------------------------------------------------- 鼠标穿透

function setInteractive(next: boolean): void {
  if (isInteractive === next) return;
  isInteractive = next;
  applyMouseIgnore();
}

function applyMouseIgnore(): void {
  if (!mainWindow) return;
  mainWindow.setIgnoreMouseEvents(!isInteractive, { forward: true });
}

// --------------------------------------------------------------------------- 托盘

function createTray(): void {
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('奶球');
  tray.on('click', () => tray?.popUpContextMenu());
  refreshTrayMenu();
}

function refreshTrayMenu(): void {
  if (!tray) return;

  const menu = Menu.buildFromTemplate([
    {
      label: isPaused ? '继续' : '暂停',
      click: () => togglePause(),
    },
    { type: 'separator' },
    {
      label: '重置小球',
      click: () => sendToRenderer('reset-ball'),
    },
    {
      label: '重新贴合主屏',
      click: () => fitToPrimaryDisplay(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => quitApp(),
    },
  ]);

  tray.setContextMenu(menu);
}

function loadTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray.png'));
  // 图标缺失时不要直接崩，退化成空图标（系统仍会保留一个可右键的托盘项）
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

/** 窗口图标。和托盘一样，缺文件就返回 undefined（Electron 会退回默认图标），不抛错 */
function loadAppIcon(): Electron.NativeImage | undefined {
  const icon = nativeImage.createFromPath(path.join(ASSETS_DIR, 'app.png'));
  return icon.isEmpty() ? undefined : icon;
}

function togglePause(): void {
  isPaused = !isPaused;
  sendToRenderer('set-paused', isPaused);
  refreshTrayMenu();
  tray?.setToolTip(isPaused ? '奶球 · 已暂停' : '奶球');
}

function quitApp(): void {
  isQuitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  app.quit();
}

// --------------------------------------------------------------------------- 工具

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (isQuitting) return;
  mainWindow?.webContents.send(channel, ...args);
}
