/**
 * 桌面图标：读取位置 + 按名字启动（仅 Windows）
 * ---------------------------------------------------------------------------
 * 干什么用的：台球模式下小球停稳后，看它压在哪一个桌面图标上，高亮那个图标、
 * 倒计时 1.5 秒，然后把对应的应用启动起来。
 *
 * 怎么读到的：Windows 的桌面图标并不是一堆独立窗口，而是 explorer.exe 里一个
 * `SysListView32`（就是「列表视图」控件）。所以顺序是：
 *
 *   Progman → SHELLDLL_DefView → SysListView32
 *   （换过壁纸 / 按过 Win+D 之后 DefView 会挂到某个 WorkerW 下，所以有兜底链路）
 *
 * ★ 最大的坑：LVM_GETITEMPOSITION / LVM_GETITEMTEXTW 这两个消息的 lParam 是
 *   **进程内指针，不做跨进程编组**。我们和 explorer 不是一个进程，直接把本地
 *   POINT 的地址传过去不会报错，只会静默失败（拿回全 0）。所以必须：
 *
 *     GetWindowThreadProcessId → OpenProcess
 *     → VirtualAllocEx        在 explorer.exe 里开内存
 *     → WriteProcessMemory    把 LVITEMW 结构体塞进去
 *     → SendMessageW          让 explorer 自己往那块内存里填
 *     → ReadProcessMemory     把结果拷回来
 *     → VirtualFreeEx / CloseHandle  收尾
 *
 * 为什么用 koffi：纯 FFI，N-API，有 win32-x64 预编译包，用户 npm install 时
 * 不需要任何 C++ 工具链（electron-builder 打包时也会打印 `no native dependencies`）。
 *
 * ★ 可移植性上刻意做的三件事（都是为了「别人装了也能用」）：
 *   1. **不硬编码图标尺寸。** 用户可以用 Ctrl+滚轮把桌面图标改成小(32)/中(48)/大(96)。
 *      实测图标在列内水平居中，所以 `边长 = 列宽 − 2 × (图标左边 − 列左边)` 能自己
 *      跟着变，不依赖任何写死的数值。
 *   2. **不靠「名字为空」判断虚拟项。** 实测「回收站」「此电脑」这类虚拟项**也有名字**，
 *      它们的特征是桌面上没有对应的 .lnk。所以按名字去用户桌面 / 公共桌面找快捷方式，
 *      找不到就标记成不可启动（不高亮、不启动），绝不猜。
 *   3. **整条链路全程不抛异常。** koffi 没装上、非 Windows、explorer 重启、权限不足……
 *      任何一步失败都只是「这个功能不可用」，绝不能让主进程崩掉。
 */

import { app, BrowserWindow, screen, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// --------------------------------------------------------------------------- 对外类型

export interface DesktopIcon {
  /** 图标显示名（＝快捷方式文件名去掉扩展名） */
  name: string;
  /** 图标矩形左上角，**窗口内 DIP 坐标**（可以直接和画布里的球心比较） */
  x: number;
  y: number;
  /** 图标图形边长（DIP）。是正方形，所以不用单独给宽高 */
  size: number;
  /** 桌面上找得到对应快捷方式才为 true —— 只有它才能启动 */
  launchable: boolean;
}

export interface LaunchResult {
  ok: boolean;
  /** 失败原因（给日志看，不给用户看）：not-found / unsupported / <shell 的错误串> */
  error?: string;
  /** 实际启动的快捷方式路径（成功时给日志用） */
  target?: string;
}

// --------------------------------------------------------------------------- Win32 常量

const LVM_FIRST = 0x1000;
const LVM_GETITEMCOUNT = LVM_FIRST + 4; // 0x1004
const LVM_GETITEMRECT = LVM_FIRST + 14; // 0x100E
const LVM_GETITEMPOSITION = LVM_FIRST + 16; // 0x1010
const LVM_GETITEMTEXTW = LVM_FIRST + 115; // 0x1073

/** LVITEMW.mask：这次读文本 */
const LVIF_TEXT = 0x0001;
/** LVM_GETITEMRECT 用 rect.left 当入参选区域；1 = 只要图标图形本身 */
const LVIR_ICON = 1;

const MEM_COMMIT = 0x1000;
const MEM_RESERVE = 0x2000;
const MEM_RELEASE = 0x8000;
const PAGE_READWRITE = 0x04;

const PROCESS_VM_OPERATION = 0x0008;
const PROCESS_VM_READ = 0x0010;
const PROCESS_VM_WRITE = 0x0020;
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_ACCESS =
  PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION;

/** 图标名的最大长度（Windows 文件名上限 255，留点余量） */
const NAME_CCH = 260;
const POINT_SIZE = 8; // 两个 int32
const RECT_SIZE = 16; // 四个 int32
/**
 * LVITEMW 在 x64 下是 88 字节，pszText 在偏移 24、cchTextMax 在 32。
 * 这个布局由 Windows SDK 定死，本应用只出 win32-x64，所以直接手写字节。
 * （npm run probe-icons 里会用 koffi 自己的 sizeof/offsetof 复核这几个数字。）
 */
const LVITEMW_SIZE = 88;
const LVITEMW_OFF_ITEM = 4;
const LVITEMW_OFF_PSZTEXT = 24;
const LVITEMW_OFF_CCHTEXTMAX = 32;

// --------------------------------------------------------------------------- koffi 装载

/**
 * koffi 的返回值类型是「指针是 bigint、整数是 number、字符串是 string」，
 * 一个个断言反而更吵，这里统一按 any 处理，调用点自己知道拿到的是什么。
 */
type KoffiFunc = (...args: unknown[]) => any;
interface KoffiLib {
  func(definition: string): KoffiFunc;
}
interface KoffiModule {
  load(file: string): KoffiLib;
}

let koffiModule: KoffiModule | null = null;
let koffiLoaded = false;
/** 首次读取成功的日志只打一次，免得每次停球都刷屏 */
let loggedFirstRead = false;

/**
 * 惰性加载 koffi，只尝试一次。
 *
 * 为什么必须包起来：koffi 是**可选能力**。它依赖 optionalDependencies 里的
 * `@koromix/koffi-win32-x64` 提供预编译二进制，万一用户那边 npm 没装上
 * （网络受限、镜像缺包、被杀软删了），require 就会抛。这时应用必须照常运行，
 * 只是「停到图标就启动」这个功能关掉 —— 不能因为一个彩蛋功能把整个桌面宠物搞崩。
 */
function loadKoffi(): KoffiModule | null {
  if (koffiLoaded) return koffiModule;
  koffiLoaded = true;
  try {
    koffiModule = require('koffi') as KoffiModule;
  } catch (err) {
    koffiModule = null;
    console.warn('[icons] koffi 未能加载，「停到图标就启动」功能已关闭。', err);
  }
  return koffiModule;
}

/** 这个平台上有没有能力读桌面图标 */
export function isIconLaunchSupported(): boolean {
  return process.platform === 'win32' && loadKoffi() !== null;
}

// --------------------------------------------------------------------------- 快捷方式索引

/**
 * 桌面上哪些东西算「可以启动的」。
 *   · 快捷方式  .lnk / .url —— 最常见，双击就启动目标
 *   · 可执行    .exe / .bat / .cmd —— 有些绿色软件直接往桌面丢 exe
 *   · 文件夹     —— 双击是用资源管理器打开，算「打开这个图标」的合理行为
 * 其它类型（文档、图片、压缩包）刻意不收：这个功能的定位是「打开桌面**应用**」，
 * 无意中把一份 100MB 的视频甩给播放器并不是用户想要的。
 */
const LAUNCHABLE_EXTS = new Set(['.lnk', '.url', '.exe', '.bat', '.cmd']);

/**
 * 扫用户桌面 + 公共桌面，建一张「图标显示名 → 实际路径」的表。
 *
 * 两个坑：
 *
 * 1. **顺序**：先扫公共桌面、再扫用户桌面，后者覆盖前者 —— 同名时以用户自己的为准。
 *
 * 2. **★ 标签到底带不带扩展名，取决于类型和系统设置，所以两个键都登记。**
 *    实测（本机 HideFileExt=0，即「显示扩展名」）：
 *      `PyCharm 2025.3.4.lnk`   → 图标标签是 `PyCharm 2025.3.4`（.lnk 被强制隐藏）
 *      `PUBG BATTLEGROUNDS.url` → 图标标签是 `PUBG BATTLEGROUNDS`（.url 同样被隐藏）
 *      `Plain Craft Launcher 2.exe` → 图标标签**带** `.exe`
 *    也就是说资源管理器会特殊隐藏快捷方式类扩展名，却不隐藏 .exe；而用户一旦把
 *    「隐藏已知扩展名」打开，连 .exe 的也会不见。与其猜，不如「原名」和「去扩展名」
 *    两个键都指向同一个路径 —— 两种情形都能命中。
 */
function buildLaunchers(): Map<string, string> {
  const map = new Map<string, string>();
  const dirs: string[] = [];

  const publicDir = process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : '';
  if (publicDir) dirs.push(publicDir);
  try {
    dirs.push(app.getPath('desktop'));
  } catch {
    // app 还没 ready 之类的情况，忽略即可
  }

  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在 / 没权限 → 跳过
    }
    for (const entry of entries) {
      const file = entry.name;
      const full = path.join(dir, file);
      const isDir = entry.isDirectory();
      const ext = path.extname(file).toLowerCase();
      if (!isDir && !LAUNCHABLE_EXTS.has(ext)) continue;

      map.set(file, full);
      if (!isDir) {
        const stem = file.slice(0, file.length - ext.length);
        if (stem) map.set(stem, full);
      }
    }
  }

  return map;
}

// --------------------------------------------------------------------------- 读图标（原始）

interface RawIcon {
  name: string;
  /** 物理像素 */
  left: number;
  top: number;
  /** 图标边长，物理像素；<= 0 表示量不出来，这个图标不参与命中 */
  side: number;
}

/**
 * 定位桌面图标的列表视图控件。
 * 主链路是 Progman 那条；兜底链路是逐个 WorkerW 找 —— 换过壁纸或按过 Win+D
 * 之后 SHELLDLL_DefView 会从 Progman 挪到某个 WorkerW 下面，只认主链路会突然读不到。
 */
function findListView(FindWindowW: KoffiFunc, FindWindowExW: KoffiFunc): bigint | null {
  const progman = FindWindowW('Progman', null) as bigint | null;
  if (progman) {
    const defView = FindWindowExW(progman, null, 'SHELLDLL_DefView', null) as bigint | null;
    if (defView) {
      const listView = FindWindowExW(defView, null, 'SysListView32', null) as bigint | null;
      if (listView) return listView;
    }
  }

  // 兜底：按 FindWindowEx 的「同级遍历」玩法把顶层 WorkerW 一个个过一遍
  let worker = null as bigint | null;
  for (let guard = 0; guard < 64; guard++) {
    worker = FindWindowExW(null, worker, 'WorkerW', null) as bigint | null;
    if (!worker) break;
    const def = FindWindowExW(worker, null, 'SHELLDLL_DefView', null) as bigint | null;
    if (!def) continue;
    const listView = FindWindowExW(def, null, 'SysListView32', null) as bigint | null;
    if (listView) return listView;
  }

  return null;
}

/**
 * 把桌面图标一条条读出来（物理像素）。
 * 失败（任何原因）返回 null，调用方据此降级。
 */
function readRawIcons(): RawIcon[] | null {
  const koffi = loadKoffi();
  if (!koffi) return null;

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  const FindWindowW = user32.func('void *FindWindowW(str16 lpClassName, str16 lpWindowName)');
  const FindWindowExW = user32.func(
    'void *FindWindowExW(void *hWndParent, void *hWndChildAfter, str16 lpszClass, str16 lpszWindow)',
  );
  const SendMessageW = user32.func(
    'intptr_t SendMessageW(void *hWnd, uint32_t Msg, uintptr_t wParam, void *lParam)',
  );
  const GetWindowThreadProcessId = user32.func(
    'uint32_t GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)',
  );

  const OpenProcess = kernel32.func(
    'void *OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)',
  );
  const CloseHandle = kernel32.func('bool CloseHandle(void *hObject)');
  const VirtualAllocEx = kernel32.func(
    'void *VirtualAllocEx(void *hProcess, void *lpAddress, size_t dwSize, uint32_t flAllocationType, uint32_t flProtect)',
  );
  const VirtualFreeEx = kernel32.func(
    'bool VirtualFreeEx(void *hProcess, void *lpAddress, size_t dwSize, uint32_t dwFreeType)',
  );
  const WriteProcessMemory = kernel32.func(
    'bool WriteProcessMemory(void *hProcess, void *lpBaseAddress, const void *lpBuffer, size_t nSize, void *lpNumberOfBytesWritten)',
  );
  const ReadProcessMemory = kernel32.func(
    'bool ReadProcessMemory(void *hProcess, const void *lpBaseAddress, _Out_ void *lpBuffer, size_t nSize, void *lpNumberOfBytesRead)',
  );

  let hProc: bigint | null = null;
  let pPoint: bigint | null = null;
  let pItem: bigint | null = null;
  let pText: bigint | null = null;
  let pRect: bigint | null = null;

  const icons: RawIcon[] = [];

  try {
    const listView = findListView(FindWindowW, FindWindowExW);
    if (!listView) return null;

    const total = Number(SendMessageW(listView, LVM_GETITEMCOUNT, 0, null));
    if (!(total > 0)) return null;

    // explorer 的 pid：_Out_ uint32_t * 用单元素数组接
    const pidHolder = [0];
    GetWindowThreadProcessId(listView, pidHolder);
    const pid = pidHolder[0];
    if (!pid) return null;

    hProc = OpenProcess(PROCESS_ACCESS, 0, pid) as bigint | null;
    if (!hProc) return null;

    // 四块远程内存：POINT / LVITEMW / 名字缓冲 / RECT
    pPoint = VirtualAllocEx(hProc, null, POINT_SIZE, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    pItem = VirtualAllocEx(hProc, null, LVITEMW_SIZE, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    pText = VirtualAllocEx(hProc, null, NAME_CCH * 2, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    pRect = VirtualAllocEx(hProc, null, RECT_SIZE, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!pPoint || !pItem || !pText || !pRect) return null;

    // 这几块本地缓冲复用一整轮，避免每条图标都 alloc 一次
    const pointBuf = Buffer.alloc(POINT_SIZE);
    const rectBuf = Buffer.alloc(RECT_SIZE);
    const textBuf = Buffer.alloc(NAME_CCH * 2);
    const itemBuf = Buffer.alloc(LVITEMW_SIZE);

    for (let i = 0; i < total; i++) {
      // ---- 图标左边 / 上边（LVM_GETITEMPOSITION）
      SendMessageW(listView, LVM_GETITEMPOSITION, i, pPoint);
      if (!ReadProcessMemory(hProc, pPoint, pointBuf, POINT_SIZE, null)) continue;
      const left = pointBuf.readInt32LE(0);
      const top = pointBuf.readInt32LE(4);

      // ---- 图标带（LVM_GETITEMRECT + LVIR_ICON）：用来推边长
      let side = 0;
      const seed = Buffer.alloc(RECT_SIZE);
      seed.writeInt32LE(LVIR_ICON, 0); // 入参：rect.left 选区域
      WriteProcessMemory(hProc, pRect, seed, RECT_SIZE, null);
      SendMessageW(listView, LVM_GETITEMRECT, i, pRect);
      if (ReadProcessMemory(hProc, pRect, rectBuf, RECT_SIZE, null)) {
        const bandLeft = rectBuf.readInt32LE(0);
        const bandTop = rectBuf.readInt32LE(4);
        const bandRight = rectBuf.readInt32LE(8);
        const bandBottom = rectBuf.readInt32LE(12);
        // 图标在列内水平居中 → 列宽减去两侧留白就是图标边长
        side = bandRight - bandLeft - 2 * (left - bandLeft);
        // 推不出来就退回「图标带高度」：它是系统给的真实值，只比边长略大一点点
        if (!(side > 0)) side = bandBottom - bandTop;
      }
      if (!(side > 0)) side = 0;

      // ---- 名字（LVM_GETITEMTEXTW）：必须先手写一个 LVITEMW 塞进 explorer
      itemBuf.fill(0);
      itemBuf.writeUInt32LE(LVIF_TEXT, 0); // mask
      itemBuf.writeInt32LE(i, LVITEMW_OFF_ITEM); // iItem
      itemBuf.writeBigUInt64LE(pText, LVITEMW_OFF_PSZTEXT); // pszText → 远程名字缓冲
      itemBuf.writeInt32LE(NAME_CCH, LVITEMW_OFF_CCHTEXTMAX); // cchTextMax
      WriteProcessMemory(hProc, pItem, itemBuf, LVITEMW_SIZE, null);

      let name = '';
      if (Number(SendMessageW(listView, LVM_GETITEMTEXTW, i, pItem)) > 0) {
        if (ReadProcessMemory(hProc, pText, textBuf, NAME_CCH * 2, null)) {
          let end = 0;
          while (end + 1 < NAME_CCH && textBuf.readUInt16LE(end * 2) !== 0) end++;
          name = textBuf.toString('utf16le', 0, end * 2);
        }
      }

      icons.push({ name, left, top, side });
    }
  } catch (err) {
    console.warn('[icons] 读取桌面图标失败（功能降级，不影响小球本身）：', err);
    return null;
  } finally {
    // 无论怎么退出都要把 explorer 里的内存和句柄还回去，否则每读一次泄一次
    try {
      if (hProc) {
        if (pPoint) VirtualFreeEx(hProc, pPoint, 0, MEM_RELEASE);
        if (pItem) VirtualFreeEx(hProc, pItem, 0, MEM_RELEASE);
        if (pText) VirtualFreeEx(hProc, pText, 0, MEM_RELEASE);
        if (pRect) VirtualFreeEx(hProc, pRect, 0, MEM_RELEASE);
        CloseHandle(hProc);
      }
    } catch {
      // 释放失败也只能算了，不要因此把已经读到的结果丢掉
    }
  }

  return icons;
}

// --------------------------------------------------------------------------- 对外：读

/**
 * 读出桌面图标（名字 + 窗口内 DIP 矩形 + 能不能启动）。
 *
 * 坐标转换：图标位置是**物理像素**，而画布用的是 DIP，所以要换一次。
 * 用 `screen.screenToDipRect(mainWindow, rect)` 而不是自己除 scaleFactor ——
 * 它会按窗口所在的那块显示器取缩放比，多显示器 / 混合 DPI 下才是对的。
 * 再把窗口原点减掉，就得到画布坐标。
 *
 * 每次调用都重新读：图标会被拖动、新增、删除，缓存下来的坐标迟早是错的。
 * 实测 54 个图标整轮不到 15ms，够便宜。
 */
export function readDesktopIcons(win: BrowserWindow | null): DesktopIcon[] {
  if (!isIconLaunchSupported()) return [];

  const raw = readRawIcons();
  if (!raw || raw.length === 0) return [];

  const launchers = buildLaunchers();
  const origin = win ? win.getBounds() : { x: 0, y: 0 };

  const out: DesktopIcon[] = [];
  for (const icon of raw) {
    if (icon.side <= 0) continue; // 量不出大小的条目没法做命中判定，直接不要
    const dip = screen.screenToDipRect(win, {
      x: icon.left,
      y: icon.top,
      width: icon.side,
      height: icon.side,
    });
    out.push({
      name: icon.name,
      x: dip.x - origin.x,
      y: dip.y - origin.y,
      size: dip.width,
      launchable: icon.name !== '' && launchers.has(icon.name),
    });
  }

  // 只在第一次读的时候打一行：用户遇到「停在图标上没反应」时，看日志就能判断
  // 是压根没读到图标，还是读到了但没有可启动的项。
  if (!loggedFirstRead) {
    loggedFirstRead = true;
    const launchable = out.filter((icon) => icon.launchable).length;
    console.log(`[icons] 读到 ${out.length} 个桌面图标，其中 ${launchable} 个可启动`);
  }

  return out;
}

// --------------------------------------------------------------------------- 对外：启动

/**
 * 按图标名启动对应应用。
 *
 * ★ 渲染进程**只传名字**，绝不传路径。真正打开哪个文件由主进程自己在桌面上找
 * —— 这样即使渲染进程被注入了什么，也没有「任意路径执行」的口子。
 *
 * 用 shell.openPath 而不是 spawn：它就是 ShellExecute，对 .lnk 的行为和双击一致
 * （会执行快捷方式指向的目标），也不会给我们的进程留下常驻的子进程。
 */
export async function launchDesktopIcon(name: unknown): Promise<LaunchResult> {
  if (!isIconLaunchSupported()) return { ok: false, error: 'unsupported' };
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'bad-name' };

  const target = buildLaunchers().get(name);
  if (!target) return { ok: false, error: 'not-found' };

  try {
    // 返回空串代表成功，非空是错误描述
    const message = await shell.openPath(target);
    if (message) return { ok: false, error: message, target };
    return { ok: true, target };
  } catch (err) {
    return { ok: false, error: String(err), target };
  }
}
