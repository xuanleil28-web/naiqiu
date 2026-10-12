#!/usr/bin/env node
/**
 * 构建脚本：清 dist → 编译主进程/preload → 编译渲染进程 → 拷贝静态资源
 * 用 node 串起来是为了避免 Windows 上 `&&` / `rm -rf` / 引号转义的坑。
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);

const isWin = process.platform === 'win32';
const tsc = path.join(root, 'node_modules', '.bin', isWin ? 'tsc.cmd' : 'tsc');

function run(label, command) {
  process.stdout.write(`\n▶ ${label}\n`);
  execSync(command, { stdio: 'inherit', cwd: root });
}

// 1) 清理
try {
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
} catch (err) {
  console.warn('⚠ 清理 dist 失败（可能有 Electron 进程占用）：', err.message);
}

// 2) 编译
run('编译 主进程 / preload', `"${tsc}" -p tsconfig.main.json`);
run('编译 渲染进程', `"${tsc}" -p tsconfig.renderer.json`);

// 3) 静态资源（ball-sprite.png 是小球贴图，由 scripts/gen_sprite.py 生成）
const srcDir = path.join(root, 'src', 'renderer');
const outDir = path.join(root, 'dist', 'renderer');
fs.mkdirSync(outDir, { recursive: true });
for (const file of ['index.html', 'style.css', 'ball-sprite.png']) {
  fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
}

// 4) 笑声音频（可选）：src/renderer/laugh.mp3 之类。
//    放哪个扩展名就拷哪个，一个都没有也照样构建得起来 ——
//    渲染层会探测不到并提示用户去放文件，而不是让构建失败。
const LAUGH_RE = /^laugh\.(mp3|wav|ogg|m4a)$/i;
const laughFiles = fs.readdirSync(srcDir).filter((name) => LAUGH_RE.test(name));
for (const file of laughFiles) {
  fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
}

process.stdout.write('\n▶ 拷贝渲染层静态资源\n');
if (laughFiles.length) {
  process.stdout.write(`   笑声音频：${laughFiles.join(', ')}\n`);
} else {
  process.stdout.write(
    '   笑声音频：（未提供，可把文件放到 src/renderer/laugh.mp3 后再构建）\n',
  );
}

process.stdout.write('\n✓ 构建完成 → dist/\n');
