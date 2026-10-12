'use strict';
/**
 * 桌面图标诊断工具
 * ---------------------------------------------------------------------------
 * 用法： npm run probe-icons
 *
 * 台球模式里「停到哪个图标就打开哪个应用」这个功能，靠 koffi 直接调 Win32
 * 读 explorer.exe 里的桌面图标列表。这件事依赖不少环境前提（explorer 在跑、
 * 桌面是经典 Progman/DefView 结构、koffi 的原生模块加载得起来……），
 * 出问题时很难从应用界面看出卡在哪一步。
 *
 * 这个脚本把整条链路拆开逐步自检，任何一步失败都能直接定位：
 *
 *   T1  koffi 本体 + 预编译二进制
 *   T2  LVITEMW 结构体布局（用 koffi 自己校验，防止我手写偏移量想当然）
 *   T4  物理屏幕尺寸
 *   T5  定位 SysListView32（Progman 链路 + WorkerW 兜底）
 *   T6  图标数量
 *   T7  OpenProcess explorer.exe
 *   T8  在 explorer 里分配远程内存
 *   T9  读每个图标的坐标 / 矩形
 *   T10 读每个图标的显示名
 *   T11 释放
 *
 * 为什么必须跨进程：LVM_GETITEMPOSITION / LVM_GETITEMTEXTW 的 lParam 是
 * **进程内指针**，不做跨进程编组。直接把本地 POINT 的地址传过去会静默失败
 * （拿回全 0，不报错），所以必须走：
 *   GetWindowThreadProcessId → OpenProcess
 *   → VirtualAllocEx 在 explorer.exe 里开内存
 *   → WriteProcessMemory 把 LVITEMW 结构体塞进去
 *   → SendMessageW 让 explorer 自己去填
 *   → ReadProcessMemory 把结果读回来
 *
 * 输出：打屏 + 一份 JSON 报告（默认写到系统临时目录，可用 PROBE_OUT 覆盖）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const koffi = require('koffi');

// ---------------------------------------------------------------- 常量
const LVM_FIRST = 0x1000;
const LVM_GETITEMCOUNT = LVM_FIRST + 4; // 0x1004
const LVM_GETITEMRECT = LVM_FIRST + 14; // 0x100E
const LVM_GETITEMPOSITION = LVM_FIRST + 16; // 0x1010
const LVM_GETITEMTEXTW = LVM_FIRST + 115; // 0x1073
const LVIF_TEXT = 0x0001;
/** LVM_GETITEMRECT 靠 rect.left 作为入参选区域：
 *  0 = LVIR_BOUNDS（整个条目）、1 = LVIR_ICON（只有图标图形）、2 = LVIR_LABEL */
const LVIR_BOUNDS = 0;
const LVIR_ICON = 1;

const MEM_COMMIT = 0x1000;
const MEM_RESERVE = 0x2000;
const MEM_RELEASE = 0x8000;
const PAGE_READWRITE = 0x04;

const PROCESS_VM_OPERATION = 0x0008;
const PROCESS_VM_READ = 0x0010;
const PROCESS_VM_WRITE = 0x0020;
const PROCESS_QUERY_INFORMATION = 0x0400;

const NAME_CCH = 260;
const POINT_SIZE = 8; // 两个 int32
const RECT_SIZE = 16; // 四个 int32

const report = {
  koffi: { version: null, ok: false, error: null },
  screen: {},
  layout: {},
  handles: {},
  icons: { count: -1, positions: 0, names: 0, items: [], error: null },
  timings: {},
};
const problems = [];
function fail(where, err) {
  const msg = err && err.stack ? String(err.stack).split('\n')[0] : String(err);
  problems.push(where + ': ' + msg);
  console.log('  [FAIL] ' + where + ' → ' + msg);
  return msg;
}
function ok(where, extra) {
  console.log('  [ ok ] ' + where + (extra === undefined ? '' : ' → ' + extra));
}

function main() {
  // ================================================================ T1 加载
  console.log('\n[T1] koffi 本体');
  try {
    const koffiDir = path.dirname(require.resolve('koffi'));
    // 不能用 require('koffi/package.json')：koffi 的 exports 白名单不放行子路径
    const pkg = JSON.parse(fs.readFileSync(path.join(koffiDir, 'package.json'), 'utf8'));
    report.koffi.version = pkg.version;
    report.koffi.ok = true;
    ok('require("koffi")', 'v' + pkg.version);
    console.log('       入口: ' + require.resolve('koffi'));
    const bin = path.join(koffiDir, '..', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node');
    console.log('       预编译二进制: ' + (fs.existsSync(bin) ? '存在 (' + fs.statSync(bin).size + ' B)' : '缺失 → ' + bin));
  } catch (e) {
    report.koffi.error = fail('require("koffi")', e);
    return;
  }

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  ok('koffi.load', 'user32.dll + kernel32.dll');

  // ================================================================ T2 类型布局
  console.log('\n[T2] 类型布局（用 koffi 自己校验我手写的偏移量假设）');
  const PI = koffi.struct('PROBE_POINT', { x: 'int32_t', y: 'int32_t' });
  const LVITEMW = koffi.struct('PROBE_LVITEMW', {
    mask: 'uint32_t',
    iItem: 'int32_t',
    iSubItem: 'int32_t',
    state: 'uint32_t',
    stateMask: 'uint32_t',
    pszText: 'void *',
    cchTextMax: 'int32_t',
    iImage: 'int32_t',
    lParam: 'void *',
    iIndent: 'int32_t',
    iGroupId: 'int32_t',
    cColumns: 'uint32_t',
    puColumns: 'void *',
    piColFmt: 'void *',
    iGroup: 'int32_t',
  });
  const lvSize = koffi.sizeof(LVITEMW);
  const lvOffText = koffi.offsetof(LVITEMW, 'pszText');
  const lvOffCch = koffi.offsetof(LVITEMW, 'cchTextMax');
  const lvOffParam = koffi.offsetof(LVITEMW, 'lParam');
  report.layout = {
    sizeof_POINT: koffi.sizeof(PI),
    sizeof_LVITEMW: lvSize,
    offsetof_pszText: lvOffText,
    offsetof_cchTextMax: lvOffCch,
    offsetof_lParam: lvOffParam,
  };
  console.log('       sizeof(LVITEMW)=' + lvSize + '  pszText@' + lvOffText + '  cchTextMax@' + lvOffCch + '  lParam@' + lvOffParam);
  // x64 下 LVITEMW 应当是 88 字节，pszText 在偏移 24
  const layoutExpected = lvSize === 88 && lvOffText === 24 && lvOffCch === 32;
  if (layoutExpected) ok('LVITEMW 布局与 x64 预期一致');
  else fail('LVITEMW 布局', 'EXPECTED 88/24/32');

  // ================================================================ T3 函数声明
  const GetSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)');
  const GetDesktopWindow = user32.func('void *GetDesktopWindow()');
  const FindWindowW = user32.func('void *FindWindowW(str16 lpClassName, str16 lpWindowName)');
  const FindWindowExW = user32.func('void *FindWindowExW(void *hWndParent, void *hWndChildAfter, str16 lpszClass, str16 lpszWindow)');
  const SendMessageW = user32.func('intptr_t SendMessageW(void *hWnd, uint32_t Msg, uintptr_t wParam, void *lParam)');
  const GetWindowThreadProcessId = user32.func('uint32_t GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)');

  const OpenProcess = kernel32.func('void *OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)');
  const CloseHandle = kernel32.func('bool CloseHandle(void *hObject)');
  const VirtualAllocEx = kernel32.func('void *VirtualAllocEx(void *hProcess, void *lpAddress, size_t dwSize, uint32_t flAllocationType, uint32_t flProtect)');
  const VirtualFreeEx = kernel32.func('bool VirtualFreeEx(void *hProcess, void *lpAddress, size_t dwSize, uint32_t dwFreeType)');
  const WriteProcessMemory = kernel32.func('bool WriteProcessMemory(void *hProcess, void *lpBaseAddress, const void *lpBuffer, size_t nSize, void *lpNumberOfBytesWritten)');
  const ReadProcessMemory = kernel32.func('bool ReadProcessMemory(void *hProcess, const void *lpBaseAddress, _Out_ void *lpBuffer, size_t nSize, void *lpNumberOfBytesWritten)');
  ok('12 个函数声明全部建立');

  // ================================================================ T4 屏幕尺寸
  console.log('\n[T4] 物理屏幕尺寸');
  try {
    report.screen.physicalW = GetSystemMetrics(0);
    report.screen.physicalH = GetSystemMetrics(1);
    ok('GetSystemMetrics', report.screen.physicalW + ' x ' + report.screen.physicalH + ' (物理像素)');
  } catch (e) {
    fail('GetSystemMetrics', e);
  }

  // ================================================================ T5 找 SysListView32
  console.log('\n[T5] 定位桌面图标列表视图');
  let hListView = null;
  try {
    const hProgman = FindWindowW('Progman', null);
    report.handles.progman = hProgman === null ? null : String(hProgman);
    console.log('       Progman        = ' + hProgman);
    if (hProgman) {
      const hDefView = FindWindowExW(hProgman, null, 'SHELLDLL_DefView', null);
      report.handles.defView = hDefView === null ? null : String(hDefView);
      console.log('       SHELLDLL_DefView = ' + hDefView);
      if (hDefView) {
        hListView = FindWindowExW(hDefView, null, 'SysListView32', null);
        report.handles.listView = hListView === null ? null : String(hListView);
        console.log('       SysListView32  = ' + hListView);
      }
    }
    // 兜底：某些情况下 DefView 挂在 WorkerW 下（换过壁纸 / 按过 Win+D 之后）
    if (!hListView) {
      console.log('       Progman 链路没拿到，改走 WorkerW 逐个找 …');
      let w = null;
      let guard = 0;
      while (guard++ < 64) {
        w = FindWindowExW(null, w, 'WorkerW', null);
        if (!w) break;
        const def = FindWindowExW(w, null, 'SHELLDLL_DefView', null);
        if (def) {
          const lv = FindWindowExW(def, null, 'SysListView32', null);
          if (lv) {
            hListView = lv;
            report.handles.workerW = String(w);
            console.log('       命中 WorkerW=' + w + ' → SysListView32=' + lv);
            break;
          }
        }
      }
    }
    if (hListView) ok('拿到 SysListView32');
    else fail('定位 SysListView32', '两条链路都没找到');
  } catch (e) {
    fail('定位 SysListView32', e);
  }

  if (hListView) {
    // ============================================================== T6 条目数
    console.log('\n[T6] LVM_GETITEMCOUNT');
    let count = -1;
    try {
      count = Number(SendMessageW(hListView, LVM_GETITEMCOUNT, 0, null));
      report.icons.count = count;
      if (count > 0) ok('图标数量', count);
      else fail('LVM_GETITEMCOUNT', '返回 ' + count);
    } catch (e) {
      fail('LVM_GETITEMCOUNT', e);
    }

    // ============================================================== T7 OpenProcess
    console.log('\n[T7] 跨进程准备');
    let pid = 0;
    let hProc = null;
    let pPoint = null;
    let pItem = null;
    let pText = null;
    let pRect = null;
    try {
      const buf = [0];
      GetWindowThreadProcessId(hListView, buf);
      pid = buf[0];
      report.handles.pid = pid;
      ok('GetWindowThreadProcessId', 'pid=' + pid + '  (_Out_ uint32_t* 回填成功)');

      const access = PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION;
      hProc = OpenProcess(access, 0, pid);
      report.handles.process =
        hProc === null || hProc === 0n ? null : (typeof hProc === 'bigint' ? hProc.toString() : String(hProc));
      if (hProc) ok('OpenProcess', 'handle=' + hProc);
      else fail('OpenProcess', '返回 NULL（权限不足？）');
    } catch (e) {
      fail('OpenProcess', e);
    }

    // ============================================================== T8 VirtualAllocEx
    if (hProc) {
      try {
        pPoint = VirtualAllocEx(hProc, null, POINT_SIZE, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        pItem = VirtualAllocEx(hProc, null, lvSize, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        pText = VirtualAllocEx(hProc, null, NAME_CCH * 2, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        pRect = VirtualAllocEx(hProc, null, RECT_SIZE, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        console.log('       VirtualAllocEx → POINT=' + pPoint + '  LVITEMW=' + pItem + '  TEXT=' + pText + '  RECT=' + pRect);
        if (pPoint && pItem && pText && pRect) {
          ok('三块远程内存分配成功');
          console.log('       注意返回类型: ' + typeof pPoint + '（应为 bigint，koffi 用 BigInt 表示指针）');
          if (typeof pPoint !== 'bigint') fail('VirtualAllocEx 返回类型', typeof pPoint);
        } else fail('VirtualAllocEx', '有分配返回 0');
      } catch (e) {
        fail('VirtualAllocEx', e);
      }
    }

    // ============================================================== T9 读坐标
    const positions = [];
    if (pPoint) {
      console.log('\n[T8] LVM_GETITEMPOSITION（逐个图标）');
      const t0 = Date.now();
      try {
        const ptBuf = Buffer.alloc(POINT_SIZE);
        for (let i = 0; i < count; i++) {
          const ret = Number(SendMessageW(hListView, LVM_GETITEMPOSITION, i, pPoint));
          const read = ReadProcessMemory(hProc, pPoint, ptBuf, POINT_SIZE, null);
          if (!read) {
            fail('ReadProcessMemory#' + i, '返回 0');
            break;
          }
          positions.push({ x: ptBuf.readInt32LE(0), y: ptBuf.readInt32LE(4) });
        }
        report.icons.positions = positions.length;
        const dt = Date.now() - t0;
        report.timings.readPositionsMs = dt;
        ok('读到坐标', positions.length + '/' + count + ' 个，耗时 ' + dt + 'ms');
        const xs = positions.map((p) => p.x);
        const ys = positions.map((p) => p.y);
        console.log(
          '       x 范围 ' +
            Math.min.apply(null, xs) +
            '~' +
            Math.max.apply(null, xs) +
            '   y 范围 ' +
            Math.min.apply(null, ys) +
            '~' +
            Math.max.apply(null, ys),
        );
      } catch (e) {
        fail('LVM_GETITEMPOSITION', e);
      }
    }

    // ============================================================== T9b 读矩形
    const rectsBounds = [];
    const rects = [];
    if (pRect) {
      console.log('\n[T9] LVM_GETITEMRECT（图标真实矩形）');
      const t0 = Date.now();
      try {
        const rectBuf = Buffer.alloc(RECT_SIZE);
        const readRect = function (i, lvir) {
          // 入参：rect.left 必须是区域代号
          const seed = Buffer.alloc(RECT_SIZE);
          seed.writeInt32LE(lvir, 0);
          WriteProcessMemory(hProc, pRect, seed, RECT_SIZE, null);
          const ret = Number(SendMessageW(hListView, LVM_GETITEMRECT, i, pRect));
          if (!ret) return null;
          ReadProcessMemory(hProc, pRect, rectBuf, RECT_SIZE, null);
          return {
            l: rectBuf.readInt32LE(0),
            t: rectBuf.readInt32LE(4),
            r: rectBuf.readInt32LE(8),
            b: rectBuf.readInt32LE(12),
          };
        };
        for (let i = 0; i < count; i++) {
          rects.push(readRect(i, LVIR_ICON));
          rectsBounds.push(readRect(i, LVIR_BOUNDS));
        }
        report.icons.rects = rects.filter((r) => r).length;
        report.timings.readRectsMs = Date.now() - t0;
        const iconSizes = Array.from(new Set(rects.filter((r) => r).map((r) => r.r - r.l + 'x' + (r.b - r.t))));
        report.icons.iconSizes = iconSizes;
        report.icons.boundsSizes = Array.from(
          new Set(rectsBounds.filter((r) => r).map((r) => r.r - r.l + 'x' + (r.b - r.t))),
        );
        ok('读到矩形', report.icons.rects + '/' + count + ' 个，耗时 ' + report.timings.readRectsMs + 'ms');
        console.log('       LVIR_ICON  尺寸: ' + iconSizes.join(', '));
        console.log('       LVIR_BOUNDS 尺寸: ' + report.icons.boundsSizes.join(', '));

        // LVIR_ICON 的 left 是「列的左边界」，POS.x 是「图标图形的左边界」，
        // 两者**本来就该差一个水平留白**。真正该验证的是：这个留白对所有图标是否一致
        // （一致就说明图标在列内居中，应用才能用「列宽 − 2×留白」推边长）。
        const insets = new Set();
        const cellWs = new Set();
        for (let i = 0; i < count; i++) {
          const r = rects[i];
          const p = positions[i];
          if (!r || !p) continue;
          insets.add(p.x - r.l);
          cellWs.add(r.r - r.l);
        }
        report.icons.insets = Array.from(insets);
        report.icons.cellWidths = Array.from(cellWs);
        console.log('       水平留白取值: ' + Array.from(insets).join(', ') + '   列宽取值: ' + Array.from(cellWs).join(', '));
        if (insets.size === 1 && cellWs.size === 1) {
          ok('图标在列内水平居中（留白统一）→ 可用「列宽 − 2×留白」推图标边长');
        } else {
          console.log('       注意：留白或列宽不统一，应用会用兜底值处理');
        }
      } catch (e) {
        fail('LVM_GETITEMRECT', e);
      }
    }

    // ============================================================== T10 读名字
    const names = [];
    if (pItem && pText) {
      console.log('\n[T10] LVM_GETITEMTEXTW（逐个图标）');
      const t0 = Date.now();
      try {
        const textBuf = Buffer.alloc(NAME_CCH * 2);
        for (let i = 0; i < count; i++) {
          // 手写 LVITEMW 字节：x64 布局已由 T2 的 koffi.sizeof/offsetof 校验过
          const item = Buffer.alloc(lvSize);
          item.writeUInt32LE(LVIF_TEXT, 0); // mask
          item.writeInt32LE(i, 4); // iItem
          item.writeInt32LE(0, 8); // iSubItem
          item.writeUInt32LE(0, 12); // state
          item.writeUInt32LE(0, 16); // stateMask
          item.writeBigUInt64LE(BigInt(pText), 24); // pszText → 远程缓冲（关键！）
          item.writeInt32LE(NAME_CCH, 32); // cchTextMax
          item.writeInt32LE(0, 36); // iImage
          item.writeBigUInt64LE(0n, 40); // lParam

          const wrote = WriteProcessMemory(hProc, pItem, item, lvSize, null);
          if (!wrote) {
            fail('WriteProcessMemory#' + i, '返回 0');
            break;
          }
          const ret = Number(SendMessageW(hListView, LVM_GETITEMTEXTW, i, pItem));
          if (ret <= 0) {
            names.push('');
            continue;
          }
          const read = ReadProcessMemory(hProc, pText, textBuf, NAME_CCH * 2, null);
          if (!read) {
            fail('ReadProcessMemory(text)#' + i, '返回 0');
            break;
          }
          let end = 0;
          while (end + 1 < NAME_CCH && textBuf.readUInt16LE(end * 2) !== 0) end++;
          names.push(textBuf.toString('utf16le', 0, end * 2));
        }
        report.icons.names = names.filter((n) => n.length > 0).length;
        const dt = Date.now() - t0;
        report.timings.readNamesMs = dt;
        ok('读到名字', report.icons.names + '/' + count + ' 个，耗时 ' + dt + 'ms');
      } catch (e) {
        fail('LVM_GETITEMTEXTW', e);
      }
    }

    // 汇总每条
    for (let i = 0; i < count; i++) {
      const p = positions[i] || null;
      report.icons.items.push({
        i: i,
        name: names[i] || '',
        x: p ? p.x : null,
        y: p ? p.y : null,
        rect: rects[i] || null,
        bounds: rectsBounds[i] || null,
      });
    }
    report.icons.sample = report.icons.items.slice(0, 12);

    // ============================================================== T11 清理
    console.log('\n[T11] 释放');
    try {
      if (pPoint) VirtualFreeEx(hProc, pPoint, 0, MEM_RELEASE);
      if (pItem) VirtualFreeEx(hProc, pItem, 0, MEM_RELEASE);
      if (pText) VirtualFreeEx(hProc, pText, 0, MEM_RELEASE);
      if (pRect) VirtualFreeEx(hProc, pRect, 0, MEM_RELEASE);
      if (hProc) CloseHandle(hProc);
      ok('四块内存 + 进程句柄已释放');
    } catch (e) {
      fail('释放', e);
    }
  }

  report.icons.error = problems.length ? problems.join(' | ') : null;
}

const tStart = Date.now();
try {
  main();
} catch (e) {
  problems.push('顶层异常: ' + (e && e.stack ? e.stack : e));
  fail('顶层', e);
}
report.timings.totalMs = Date.now() - tStart;
report.problems = problems;

const outPath = process.env.PROBE_OUT || path.join(os.tmpdir(), 'desktop-icons-probe.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

const okAll =
  problems.length === 0 &&
  report.icons.count > 0 &&
  report.icons.positions === report.icons.count &&
  report.icons.names === report.icons.count;

console.log('\n================ 结论 ================');
console.log('koffi 版本        : ' + report.koffi.version);
console.log('图标总数          : ' + report.icons.count);
console.log('读到坐标          : ' + report.icons.positions);
console.log('读到矩形          : ' + (report.icons.rects === undefined ? 'n/a' : report.icons.rects));
console.log('读到名字          : ' + report.icons.names);
console.log('总耗时            : ' + report.timings.totalMs + 'ms');

// 图标边长是「停到哪个图标」的命中判定要用到的关键量，顺手算出来给用户看
const probe = (report.icons.items || []).find(function (it) {
  return it.rect && it.x !== null;
});
if (probe) {
  const cellW = probe.rect.r - probe.rect.l;
  const inset = probe.x - probe.rect.l;
  const side = cellW - 2 * inset;
  console.log('列宽 / 留白        : ' + cellW + ' / ' + inset + ' 物理像素');
  console.log('推出图标边长      : ' + side + ' 物理像素 = ' + side / 2 + ' DIP（仅供参考，应用会自行推导）');
}

console.log('问题              : ' + (problems.length ? problems.length + ' 个' : '无'));
problems.forEach(function (p) {
  console.log('   - ' + p);
});
console.log('JSON 报告         : ' + outPath);
console.log('');
console.log(
  okAll
    ? '✅ 全绿：这台机器上「小球停到哪个图标就打开哪个应用」可以正常工作。'
    : '❌ 有环节失败：上面带 [FAIL] 的行就是断点，把整份输出贴给开发者即可。',
);
