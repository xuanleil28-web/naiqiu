#!/usr/bin/env node
/**
 * 启动自检：真正拉起一次 Electron，确认「主进程 → preload → 渲染页」整条链路是通的。
 * 补的是 typecheck 和 smoke-test 都覆盖不到的一段：窗口选项是否合法、
 * preload 路径是否解析得到、真实 Chromium 里画布能不能画出来。
 *
 *   node scripts/boot-check.js              # 默认隐藏窗口，6 秒后自动结束
 *   node scripts/boot-check.js --no-sandbox # 受限环境（虚拟机 / 沙箱 / CI）里可能需要
 *   node scripts/boot-check.js --show       # 真的把窗口显示出来看一眼
 *
 * 额外参数会原样透传给 electron。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DURATION_MS = Number(process.env.BOOT_CHECK_MS || 6000);

const passthrough = process.argv.slice(2);
const show = passthrough.includes('--show');
const extraArgs = passthrough.filter((a) => a !== '--show');

let electronPath;
try {
  electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
} catch {
  console.error('✗ 没装 electron，先执行 npm install');
  process.exit(1);
}

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
// 从 IDE 内置终端之类的 Electron 宿主里启动时会带上这个变量，
// 它会让 electron.exe 退化成纯 Node，require('electron') 拿不到 app。
delete env.ELECTRON_RUN_AS_NODE;
if (!show) env.BALL_HEADLESS = '1';

console.log(`▶ 启动自检（${DURATION_MS / 1000}s${show ? '，显示窗口' : '，隐藏窗口'}）\n`);

const child = spawn(electronPath, ['.', '--enable-logging', ...extraArgs], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
let finished = false;
child.stdout.on('data', (d) => (log += d.toString()));
child.stderr.on('data', (d) => (log += d.toString()));

const timer = setTimeout(() => {
  console.log('▶ 时间到，关闭进程树\n');
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}, DURATION_MS);

child.on('exit', () => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);

  const checks = [
    ['主进程窗口创建成功', /\[main\] window ready/],
    ['preload + 渲染脚本加载完成', /\[ball\] renderer ready/],
    ['真实 Chromium 里成功绘制首帧', /\[ball\] 首帧绘制完成/],
    ['小球贴图加载成功（448x521）', /\[ball\] 贴图已加载 448x521/],
  ];

  let ok = true;
  for (const [label, pattern] of checks) {
    const hit = pattern.test(log);
    console.log(`  ${hit ? '✓' : '✗'} ${label}`);
    if (!hit) ok = false;
  }

  // 应用名是**信息**不是断言：改个名字不该让自检失败，但每次跑都能看见实际生效的是哪个
  // （它来自 package.json 顶层的 productName，任务栏 / 托盘 / 快捷方式都用这个名字）
  const appName = log.match(/\[main\] window ready[^\n]*name=([^\s]+)/);
  if (appName) console.log(`  • 应用名：${appName[1]}`);

  // 笑声音频是可选的：命中就报一下，没有也不算失败（否则没放音频的人自检永远过不了）
  // 文件名只取字母数字点横线：--enable-logging 的 CONSOLE 行会在后面跟上引号和 source
  const laugh = log.match(/\[ball\] 笑声已就绪：([\w.-]+)/);
  const laughMissing = /\[ball\] 没找到笑声文件/.test(log);
  if (laugh) {
    console.log(`  ✓ 笑声音频已就绪（${laugh[1]}）`);
  } else if (laughMissing) {
    console.log('  • 笑声音频：未提供（可选）');
    console.log(
      '    把音频放到 src/renderer/laugh.mp3（也认 .wav / .ogg / .m4a）后重新 npm run build，',
    );
    console.log('    面板里的「播放笑声」按钮就会出声。');
  }

  if (/\[ball\] 贴图加载失败/.test(log)) {
    ok = false;
    console.log('\n✗ 小球贴图加载失败 —— dist/renderer/ball-sprite.png 在不在？');
    console.log('   先确认 src/renderer/ball-sprite.png 存在（没有就跑 python scripts/gen_sprite.py），再 npm run build');
  }

  const fatal = log.match(/FATAL:[^\n]*/g);
  if (fatal) {
    ok = false;
    console.log('\n✗ 检测到 Chromium 致命错误：');
    for (const line of [...new Set(fatal)]) console.log(`    ${line}`);
    if (/gpu/i.test(fatal.join(' '))) {
      console.log('    → 受限环境可试： node scripts/boot-check.js --no-sandbox');
      console.log('    → 或给应用设 BALL_DISABLE_GPU=1 关闭硬件加速');
    }
  }

  console.log(`\n${ok ? '✓ 启动自检通过' : '✗ 启动自检失败'}\n`);
  if (!ok) {
    console.log('--- 原始日志 ---');
    console.log(log.trim() || '(无输出)');
  }
  process.exit(ok ? 0 : 1);
});
