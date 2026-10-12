#!/usr/bin/env node
/**
 * 视觉验证：用 Electron 打开渲染页，自动派发鼠标事件，
 * 依次把七张截图存到 docs/：
 *   1. screenshot-ball.png             —— 只有小球（默认大小）
 *   2. screenshot-menu.png             —— 单击后设置面板展开
 *   3. screenshot-ball-zoom.png        —— 拉到最大尺寸后裁切放大的贴图特写
 *   4. screenshot-ball-spin.png        —— 向右甩出去、旋转中的小球特写
 *   5. screenshot-billiard-menu.png    —— 勾上「台球模式」后面板的样子
 *   6. screenshot-billiard.png         —— 台球模式：小球静止 + 右键按住时的球杆
 *   7. screenshot-ball-icon-countdown.png —— 球停在真实桌面图标上：高亮框 + 倒计时环 + 名字牌
 *
 * 第 4 张是靠「按贴图主体色在整窗截图里找小球」自动取景的（见 locateBall）：
 * 甩出去之后球在哪不好预测，直接扫像素找黄色蛋身最稳。第 5、6、7 张也复用它 ——
 * 勾上台球模式之后小球会当场冻住，先冻住再扫位置，就不会出现「量完又飘走」。
 * 第 6 张只做存在性检查（图里有没有深色像素＝球杆），精确几何由冒烟测试负责。
 *
 * 第 7 张要在**真实桌面**上拍（让用户看见框住的确实是那个图标），所以流程不一样：
 * 另开一个真·透明窗口 + 系统抓屏，并且靠「先打一杆量落点、再把窗口挪过去」来
 * 精确对位。详见文末那一段的注释。
 *
 *   npm run shot                                   # 常规环境
 *   npm run shot -- --no-sandbox --disable-gpu     # 受限环境（虚拟机 / 容器 / CI）
 *
 * 额外参数会原样透传给 electron。
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const passthrough = process.argv.slice(2).filter((a) => !a.startsWith('--enable-logging'));

/**
 * 在整窗截图里按「贴图主体色」找到小球，返回它的轴对齐包围盒（单位：截图像素）。
 *
 * 贴图是纯色平面蛋（#EFC96C），在浅色背景上非常好认 —— 扫一遍 BGRA 位图，
 * 把偏黄的像素圈起来就行。眼睛（绿）/ 瞳孔（黑）/ 嘴巴（棕）在蛋身内部，
 * 不参与匹配也不影响包围盒（蛋的最外圈一定是黄色）。
 *
 * 返回的宽高本身就是一条有用的证据：蛋未旋转时是 120x140（竖着），
 * 转起来之后轴对齐包围盒会在「竖高」和「横宽」之间摆动。
 *
 * @returns {{width:number,height:number,hits:number,minX:number,minY:number,maxX:number,maxY:number}|null}
 */
function locateBall(img) {
  const size = img.getSize();
  const bmp = img.toBitmap(); // BGRA，每像素 4 字节
  let minX = size.width;
  let minY = size.height;
  let maxX = -1;
  let maxY = -1;
  let hits = 0;

  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const i = (y * size.width + x) * 4;
      const b = bmp[i];
      const g = bmp[i + 1];
      const r = bmp[i + 2];
      // 偏黄的蛋身：红最高、蓝最低；阈值放宽一点，抗住边缘抗锯齿
      if (r > 190 && g > 150 && b < 175 && r - b > 70 && g - b > 40) {
        hits++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (hits < 200 || maxX < 0) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1, hits };
}

/**
 * 数一数图里有多少「高亮红」的像素 —— 用来判断倒计时是不是已经开始了。
 *
 * 判据必须能把高亮红和小球贴图分开：贴图是黄蛋 #EFC96C，也是「红高蓝低」，
 * 区别在绿通道 —— 黄蛋 r-g≈38，高亮红 #d1462f 的 r-g≈139。卡 r-g>55 就干净了。
 * 环的底圈是 0.22 透明度的同一色，可能被预乘压暗而漏掉；框的描边是不透明的，
 * 单靠它一帧就有几千像素，所以阈值给 300 很宽松。
 */
function countHighlightRed(img) {
  const bmp = img.toBitmap();
  let n = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    const b = bmp[i];
    const g = bmp[i + 1];
    const r = bmp[i + 2];
    if (r > 100 && r - g > 55 && r - b > 70) n++;
  }
  return n;
}

app.commandLine.appendSwitch('disable-features', 'Vulkan');

app.whenReady().then(async () => {
  fs.mkdirSync(DOCS, { recursive: true });

  // 第七张要用到主进程那两条链路。这个截图进程里**没有加载 dist/main/main.js**，
  // 所以得自己把 handler 接上；接的时候只复用已经验证过的 icons 模块。
  //
  // ★ 启动这条**故意不真的启动** —— 只记账。截图跑完我们还靠这份账单确认
  //   「倒计时确实走到了启动那一步」，而不是靠肉眼看图猜。
  const launchCalls = [];
  let readDesktopIcons = null;
  try {
    readDesktopIcons = require(path.join(ROOT, 'dist', 'main', 'icons.js')).readDesktopIcons;
  } catch (err) {
    console.warn('[shot] 加载 dist/main/icons.js 失败，第七张会跳过：', err.message);
  }

  ipcMain.handle('read-desktop-icons', (event) => {
    if (!readDesktopIcons) return [];
    return readDesktopIcons(BrowserWindow.fromWebContents(event.sender));
  });
  ipcMain.handle('launch-desktop-icon', (_event, name) => {
    launchCalls.push(String(name));
    return { ok: true, target: `（截图进程拦下了，没有真的启动：${String(name)}）` };
  });

  const win = new BrowserWindow({
    width: 900,
    height: 560,
    show: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    // 正常运行时这个窗口是透明的；截图时给个底色，不然看不到边界
    backgroundColor: '#c9d6e2',
    webPreferences: {
      preload: path.join(ROOT, 'dist', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message}`);
  });

  await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'));
  await wait(600);

  fs.writeFileSync(path.join(DOCS, 'screenshot-ball.png'), (await win.webContents.capturePage()).toPNG());
  console.log('✓ docs/screenshot-ball.png');

  // 把小球归位到正中，再在正中派发一次短按 → 触发「停下 + 弹面板」
  win.webContents.send('reset-ball');
  await wait(60);
  await win.webContents.executeJavaScript(`
    (() => {
      const at = { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2, button: 0, bubbles: true };
      window.dispatchEvent(new MouseEvent('mousedown', at));
      window.dispatchEvent(new MouseEvent('mouseup', at));
      return true;
    })()
  `);
  await wait(700);

  const state = await win.webContents.executeJavaScript(`
    (() => {
      const menu = document.getElementById('menu');
      const r = menu.getBoundingClientRect();
      return {
        面板已展开: !menu.hidden,
        面板位置: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        速度: document.getElementById('speed-value').textContent,
        大小: document.getElementById('size-value').textContent,
        显示继续按钮: !document.getElementById('resume').hidden,
        缺少笑声音频: !document.getElementById('laugh-hint').hidden,
      };
    })()
  `);
  console.log('面板状态:', JSON.stringify(state, null, 0));

  fs.writeFileSync(path.join(DOCS, 'screenshot-menu.png'), (await win.webContents.capturePage()).toPNG());
  console.log('✓ docs/screenshot-menu.png');

  if (!state.面板已展开) {
    console.error('✗ 单击小球后面板没有展开');
    app.exit(1);
    return;
  }

  // ---- 第三张：放大版，用来检查贴图本身画得对不对 ----
  // 先把速度拉到 0 再归位 → 小球会静静停在屏幕正中，方便裁剪
  await win.webContents.executeJavaScript(`
    (() => {
      const speed = document.getElementById('speed');
      speed.value = '0';
      speed.dispatchEvent(new Event('input'));
      document.getElementById('menu-close').click();
      return true;
    })()
  `);
  win.webContents.send('reset-ball');
  await wait(80);
  await win.webContents.executeJavaScript(`
    (() => {
      const size = document.getElementById('size');
      size.value = '60';
      size.dispatchEvent(new Event('input'));
      return true;
    })()
  `);
  await wait(400);

  const full = await win.webContents.capturePage();
  const bounds = win.getContentBounds();
  // 截图像素与窗口 DIP 之间差一个缩放比（高分屏下是 2），裁切前先换算
  const scale = full.getSize().width / bounds.width;
  const cw = 340;
  const ch = 320;
  const rect = {
    x: Math.max(0, Math.round((bounds.width / 2 - cw / 2) * scale)),
    y: Math.max(0, Math.round((bounds.height / 2 - ch / 2) * scale)),
    width: Math.round(cw * scale),
    height: Math.round(ch * scale),
  };
  const zoom = full.crop(rect).resize({ width: cw * 3, height: ch * 3 });
  fs.writeFileSync(path.join(DOCS, 'screenshot-ball-zoom.png'), zoom.toPNG());
  console.log(`✓ docs/screenshot-ball-zoom.png  （裁 ${cw}x${ch} DIP 再放大 3 倍）`);

  // ---- 第四张：旋转中的小球 ----
  // 长按向右甩 → 旋转方向是确定的（向右飞 = 顺时针），
  // 截图里蛋应该是斜的：眼睛和嘴巴跟着贴图一起转过来，而不是各转各的。
  // 第四张要用它左键拖拽，第五张要用它按右键（button = 2）
  const dispatchMouse = (type, x, y, button = 0) =>
    win.webContents.executeJavaScript(`
      (() => {
        window.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
          clientX: ${x}, clientY: ${y}, button: ${button}, bubbles: true,
        }));
        return true;
      })()
    `);

  // 回到正中、速度 0、脉冲归零：小球会静静停在屏幕中央
  win.webContents.send('reset-ball');
  await wait(420);

  const center = await win.webContents.executeJavaScript(
    '({ x: window.innerWidth / 2, y: window.innerHeight / 2 })',
  );

  await dispatchMouse('mousedown', center.x, center.y);
  await wait(200); // 越过 100ms 长按阈值 → 进入拖拽
  let dragX = center.x;
  for (let i = 0; i < 6; i++) {
    dragX += 30;
    await wait(16);
    await dispatchMouse('mousemove', dragX, center.y);
  }
  await dispatchMouse('mouseup', dragX, center.y);
  await wait(110); // 松手后让它边飞边转一小段角度再截图

  const spinning = await win.webContents.capturePage();
  const shotSize = spinning.getSize();
  const box = locateBall(spinning);
  if (!box) {
    console.error('✗ 在截图里没找到小球（按主体色定位失败），第四张跳过');
    app.exit(1);
    return;
  }

  const side = Math.round(Math.max(box.width, box.height) * 1.6);
  const crop = {
    x: Math.min(Math.max(Math.round((box.minX + box.maxX) / 2 - side / 2), 0), Math.max(0, shotSize.width - side)),
    y: Math.min(Math.max(Math.round((box.minY + box.maxY) / 2 - side / 2), 0), Math.max(0, shotSize.height - side)),
    width: side,
    height: side,
  };
  fs.writeFileSync(
    path.join(DOCS, 'screenshot-ball-spin.png'),
    spinning.crop(crop).resize({ width: side * 2, height: side * 2 }).toPNG(),
  );
  console.log(
    `✓ docs/screenshot-ball-spin.png  （贴图包围盒 ${box.width}x${box.height}px` +
      ` 宽高比 ${(box.width / box.height).toFixed(2)}，裁 ${side}px 放大 2 倍）`,
  );

  // ---- 第五 / 六张：台球模式 ----
  const openMenu = (x, y) => dispatchMouse('mousedown', x, y).then(() => dispatchMouse('mouseup', x, y));
  const closeMenu = () =>
    win.webContents.executeJavaScript("document.getElementById('menu-close').click(); true");
  const screenCenter = () =>
    win.webContents.executeJavaScript('({ x: window.innerWidth / 2, y: window.innerHeight / 2 })');

  // 把上两张留下的「速度 0 / 大小 60」恢复成默认值
  await win.webContents.executeJavaScript(`
    (() => {
      const size = document.getElementById('size');
      size.value = '24';
      size.dispatchEvent(new Event('input'));
      const speed = document.getElementById('speed');
      speed.value = '6';
      speed.dispatchEvent(new Event('input'));
      document.getElementById('menu-close').click();
      return true;
    })()
  `);
  win.webContents.send('reset-ball');
  await wait(300);

  // 勾上台球模式 → 小球当场冻住。先冻再找位置，免得它在「测量」和「点击」之间又飘走
  const modeState = await win.webContents.executeJavaScript(`
    (() => {
      const box = document.getElementById('billiard');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      return {
        台球模式: box.checked,
        模式说明: !document.getElementById('billiard-hint').hidden,
        正常提示已隐藏: document.getElementById('hint').hidden,
        继续按钮已隐藏: document.getElementById('resume').hidden,
      };
    })()
  `);
  console.log('台球模式状态:', JSON.stringify(modeState, null, 0));
  await wait(500); // 等缩放脉冲散尽（脉冲会让小球显得比实际大）

  // 靠贴图主体色在整窗截图里把小球找出来，换算回 DIP
  const probe = await win.webContents.capturePage();
  const probeScale = probe.getSize().width / win.getContentBounds().width;
  const found = locateBall(probe);
  const ball = found
    ? {
        x: (found.minX + found.maxX) / 2 / probeScale,
        y: (found.minY + found.maxY) / 2 / probeScale,
      }
    : await screenCenter();

  // 第六张：勾着「台球模式」的面板（整行点亮 + 模式说明 + 「让它动起来」已收起）
  await openMenu(ball.x, ball.y);
  await wait(400);
  fs.writeFileSync(path.join(DOCS, 'screenshot-billiard-menu.png'), (await win.webContents.capturePage()).toPNG());
  console.log('✓ docs/screenshot-billiard-menu.png');
  await closeMenu();
  await wait(150);

  // 第五张：按住右键拉满杆 —— 球杆在球的左后方，瞄准虚线指向右方。
  // 144 = 球半径 24 + CUE_MAX_PULL 120，正好是「指针离球心的距离 = 满力拉距」的那一点
  await dispatchMouse('mousedown', ball.x - 144, ball.y, 2);
  await wait(220);
  const cueShot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(DOCS, 'screenshot-billiard.png'), cueShot.toPNG());

  // 顺手数一下深色像素（球杆是接近纯黑的 #111111）：只做存在性检查，
  // 精确几何留给冒烟测试，截图这里只要能证明「杆确实画出来了」就够了
  const bmp = cueShot.toBitmap();
  const shotW = cueShot.getSize().width;
  const shotH = cueShot.getSize().height;
  let dark = 0;
  for (let y = 0; y < shotH; y++) {
    for (let x = 0; x < shotW; x++) {
      const i = (y * shotW + x) * 4;
      if (bmp[i] < 60 && bmp[i + 1] < 60 && bmp[i + 2] < 60) dark++;
    }
  }
  console.log(
    `✓ docs/screenshot-billiard.png  （右键按住时截取；深色像素 ${dark} 个` +
      `${dark > 300 ? '，球杆已画出' : '，⚠ 没看到球杆'}）`,
  );


  // ---- 第七张：停稳在真实桌面图标上（高亮框 + 倒计时环 + 名字牌）----
  //
  // 这一张的难点不是「怎么画」，而是「怎么让小球正好停在一个图标上」。
  // 这里**不预测物理**：帧长一抖落点就差几像素，算出来的坐标迟早对不上。改成两步走 ——
  //   ① 先打一杆校准杆，用像素扫描**量出**球到底停在哪（记作 L）；
  //   ② 再把**窗口挪过去**，让目标图标的中心落到 L 上。
  // 第 ② 步只用到「图标坐标是相对窗口的」这一条性质：窗口平移 (sx,sy)，图标的窗口内
  // 坐标就平移 (−sx,−sy)，所以想让 icon_center' = L，只要
  //     新原点 = 旧原点 + (icon_center − L)
  // 挪完用同一杆再打一次，落点会回到 L（复现误差几像素），而命中判定有 ±(24.5+6)，
  // 宽裕得很。
  //
  // 两个取舍：
  //   · 背景还是这块灰，没有把真实桌面图标拍进来。真透明窗口 + 系统抓屏本来能做到，
  //     但抓屏会把用户当时屏幕上的一切都拍进去 —— 这张图是要进开源仓库 docs/ 的，
  //     不能这么干；何况桌面十有八九被全屏窗口盖着，抓出来只是别人的 IDE。
  //   · 停稳后 1.5 秒就真启动了。一旦看见高亮就先把渲染进程**暂停**（暂停会冻住
  //     倒计时，但照样每帧画高亮），把节奏拿回来。
  if (readDesktopIcons) {
    // 先把上一张举着的杆收掉：指针挪回球心 = 拉杆量 0，松手只是把杆收回，
    // 不会顺手补一杆
    await dispatchMouse('mousemove', ball.x, ball.y, 2);
    await dispatchMouse('mouseup', ball.x, ball.y, 2);
    await wait(150);

    const WA = screen.getPrimaryDisplay().workArea;
    const TW = 900;
    const TH = 560;
    const BALL_R = 24; // 面板里「球的大小」的默认值，也是贴图半宽
    const TC = { x: TW / 2, y: TH / 2 };
    const CAL_PULL = 15; // 校准杆不用大力：球滚 ~110px，既不撞墙又好测

    // 挪到工作区左上角 —— 桌面图标都堆在左上，落点附近才挑得到图标
    win.setBounds({ x: WA.x, y: WA.y, width: TW, height: TH });
    await wait(400);
    win.webContents.send('reset-ball');
    await wait(300);
    console.log(`第七张：窗口挪到工作区左上 (${WA.x},${WA.y})，画布 ${TW}x${TH}`);

    /** 按「球半径 + 拉距」把指针放到球的左侧，松手就是一记朝右的杆 */
    const shootRight = async (pull) => {
      const px = TC.x - (BALL_R + pull);
      await dispatchMouse('mousedown', px, TC.y, 2);
      await wait(220); // 按住不动 → 杆跟着指针拉到位
      await dispatchMouse('mouseup', px, TC.y, 2);
    };

    /** 抓到小球不再动为止，返回它在窗口内的 DIP 坐标（贴图包围盒中心 = 球心） */
    const waitRest = async (maxMs = 5000) => {
      let prev = null;
      let stable = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        await wait(110);
        const img = await win.webContents.capturePage();
        const s = img.getSize().width / win.getContentBounds().width;
        const box = locateBall(img);
        if (!box) continue;
        const cur = { x: (box.minX + box.maxX) / 2 / s, y: (box.minY + box.maxY) / 2 / s };
        if (prev && Math.hypot(cur.x - prev.x, cur.y - prev.y) < 0.6) {
          if (++stable >= 2) return cur;
        } else {
          stable = 0;
        }
        prev = cur;
      }
      return prev;
    };

    // ① 校准杆：量出落点
    await shootRight(CAL_PULL);
    const L = await waitRest();
    if (!L) {
      console.warn('⚠ 校准杆之后没在截图里找到小球，第七张跳过');
    } else {
      console.log(`第七张：校准落点 L = (${L.x.toFixed(1)}, ${L.y.toFixed(1)})（窗口内 DIP）`);

      // ② 挑一个能对上的图标：挪完窗口既不能跑出工作区，图标也不能贴到窗口边上
      //    （倒计时环半径 37，名字牌还要挂在下面，四周得留够地方）
      const RING_R = BALL_R + 4 + 9 + 3; // 环半径 + 线宽，跟 renderer 里的公式一致
      const LABEL_ROOM = 26 + 10 + 6; // 名字牌高度 + 间距 + 一点余量
      let pick = null;
      let pickD = Infinity;
      for (const icon of readDesktopIcons(win)) {
        if (!icon.launchable) continue;
        const cx = icon.x + icon.size / 2;
        const cy = icon.y + icon.size / 2;
        const sx = cx - L.x;
        const sy = cy - L.y;
        if (sx < 0 || sy < 0) continue; // 会把窗口推出屏幕左上角
        if (WA.x + sx + TW > WA.x + WA.width) continue;
        if (WA.y + sy + TH > WA.y + WA.height) continue;
        if (L.x - RING_R < 0 || L.y - RING_R < 0) continue;
        if (L.x + RING_R > TW || L.y + RING_R + LABEL_ROOM > TH) continue;
        const d = Math.hypot(sx, sy);
        if (d < pickD) {
          pickD = d;
          pick = { icon, sx, sy, cx, cy };
        }
      }

      if (!pick) {
        console.warn('⚠ 落点附近没有可启动的桌面图标，第七张跳过');
      } else {
        console.log(
          `第七张：目标图标「${pick.icon.name}」 中心=(${pick.cx.toFixed(1)}, ${pick.cy.toFixed(1)})` +
            ` → 窗口平移 (${pick.sx.toFixed(1)}, ${pick.sy.toFixed(1)})`,
        );
        win.setBounds({
          x: Math.round(WA.x + pick.sx),
          y: Math.round(WA.y + pick.sy),
          width: TW,
          height: TH,
        });
        await wait(300);

        // 挪完复核一次：图标中心应该正好压在 L 上（这一步也顺手验证了
        // 「图标坐标是相对窗口的」这条前提）
        const after = readDesktopIcons(win).find((item) => item.name === pick.icon.name);
        if (after) {
          const ox = after.x + after.size / 2 - L.x;
          const oy = after.y + after.size / 2 - L.y;
          console.log(
            `第七张：复核「${after.name}」中心 (${(after.x + after.size / 2).toFixed(1)}, ` +
              `${(after.y + after.size / 2).toFixed(1)})，与 L 偏差 (${ox.toFixed(1)}, ${oy.toFixed(1)})`,
          );
        }

        // ③ 同一杆再打一次：球会回到 L，而图标中心现在就在 L 上
        win.webContents.send('reset-ball');
        await wait(250);
        await shootRight(CAL_PULL);

        // 等高亮冒头 —— 一出现就说明「停稳 → 找到图标 → 开始倒计时」整条链走通了。
        // 停稳后只有 1.5s，所以每 40ms 抓一帧。
        let lit = false;
        const t0 = Date.now();
        while (Date.now() - t0 < 4000) {
          const img = await win.webContents.capturePage();
          if (countHighlightRed(img) > 300) {
            lit = true;
            break;
          }
          await wait(40);
        }

        if (!lit) {
          console.warn('⚠ 球停稳后一直没等到高亮，第七张跳过（图标没对上 / 倒计时被提前吃掉）');
        } else {
          await wait(620); // 让环走到半满，进度一眼能看出来
          // 冻住倒计时：后面还要复核、写文件，别在这中间把应用真启动了
          win.webContents.send('set-paused', true);
          await wait(200);

          const shot7 = await win.webContents.capturePage();
          const red = countHighlightRed(shot7);
          fs.writeFileSync(path.join(DOCS, 'screenshot-ball-icon-countdown.png'), shot7.toPNG());
          console.log(
            `✓ docs/screenshot-ball-icon-countdown.png  （高亮红像素 ${red} 个` +
              `${red > 300 ? '，高亮框 / 倒计时环 / 名字牌已画出' : '，⚠ 没看到高亮'}）`,
          );

          // ④ 恢复时间，让倒计时走完 —— 验证「到点真的会去启动」。
          //    这里必须轮询而不能睡固定时长：暂停那一刻已经走了多久，取决于高亮被
          //    发现的快慢，剩下的倒计时是个变量；睡死一个数就会间歇性地
          //    「看起来没启动」（实测差 700ms 就会）。
          win.webContents.send('set-paused', false);
          const wanted = pick.icon.name;
          let got = null;
          for (let i = 0; i < 24 && got === null; i++) {
            await wait(200);
            if (launchCalls.length > 0) got = launchCalls[launchCalls.length - 1];
          }
          console.log(
            got === wanted
              ? `✓ 倒计时结束 → 发起了启动请求「${wanted}」`
              : `⚠ 倒计时结束没有发起启动请求（记录到的是 ${JSON.stringify(launchCalls)}，期望「${wanted}」）`,
          );
        }
      }
    }
  }

  app.exit(0);
});
