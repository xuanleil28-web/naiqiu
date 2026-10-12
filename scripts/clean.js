#!/usr/bin/env node
/** 只做一件事：删掉 dist（构建产物目录） */
'use strict';

const fs = require('fs');
const path = require('path');

const dist = path.resolve(__dirname, '..', 'dist');

try {
  fs.rmSync(dist, { recursive: true, force: true });
  console.log('✓ 已清理 dist/');
} catch (err) {
  console.error('✗ 清理失败（可能有 Electron 进程正在占用）：', err.message);
  process.exitCode = 1;
}
