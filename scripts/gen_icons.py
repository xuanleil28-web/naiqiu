#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成应用 / 窗口 / 托盘图标 —— 图案就是那颗黄色蛋形小生物本身。

    python scripts/gen_icons.py

产物：
    build/icon.png   512x512   给 electron-builder 转 .ico（exe / 安装包 / 快捷方式都用它）
    assets/app.png   256x256   运行时窗口图标（任务栏按钮、Alt+Tab）
    assets/tray.png   32x32    托盘图标

**为什么不是把 ball-sprite.png 放大**：贴图只有 448x521，往大放会糊。
这里直接调 `gen_sprite.build_sprite()` 让几何**按目标尺寸重算**一遍 ——
蛋形轮廓、眼睛、嘴巴全是同一套实测曲线，只是把画布换成更大的，
所以从 16px 到 512px 都是原生分辨率，不存在放大损失。

> 角色本身（形状 / 配色 / 五官位置）以 `gen_sprite.py` 为唯一来源，
> 这里只负责排版：把角色按比例缩放、居中放进正方形透明画布。
> 想改角色长相就改 `gen_sprite.py`，然后两个脚本一起重跑。
"""

from __future__ import annotations

import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gen_sprite  # noqa: E402  同目录，直接复用角色的渲染代码

# 先按最大的需求渲染一次（宽 512 → 高 596），后面各尺寸都是**缩小**，
# 所以一次渲染就够，不必每个尺寸各渲一遍
RENDER_W = 512

# (输出路径, 边长, 留白比例)。留白小一点角色更饱满；托盘那么小就别留白了
TARGETS = [
    ("build/icon.png", 512, 0.06),
    ("assets/app.png", 256, 0.06),
    ("assets/tray.png", 32, 0.02),
]


def render_character() -> Image.Image:
    """按 RENDER_W 重新渲染一遍角色，返回 RGBA 图。

    只改 `gen_sprite.SPRITE_W / SPRITE_H` 这两个模块级常量，再调它的
    `build_sprite()` —— 它会用新尺寸重算蛋形蒙版和所有五官，图形本身一行都不用动。
    """
    gen_sprite.SPRITE_W = RENDER_W
    gen_sprite.SPRITE_H = int(round(RENDER_W * gen_sprite.EGG_H / gen_sprite.EGG_W))
    return gen_sprite.build_sprite()


def compose(sprite: Image.Image, size: int, margin: float) -> Image.Image:
    """把角色按比例缩到「边长 ×(1−2×留白)」的方框内，居中贴到透明画布上"""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    inner = size * (1.0 - 2.0 * margin)
    sw, sh = sprite.size
    scale = min(inner / sw, inner / sh)
    w = max(1, int(round(sw * scale)))
    h = max(1, int(round(sh * scale)))

    canvas.paste(sprite.resize((w, h), Image.LANCZOS), ((size - w) // 2, (size - h) // 2))
    return canvas


def main() -> None:
    sprite = render_character()
    print(f"  角色渲染完成 {sprite.size[0]}x{sprite.size[1]}（原生分辨率，不是放大）")

    for rel, size, margin in TARGETS:
        path = os.path.join(ROOT, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        compose(sprite, size, margin).save(path, optimize=True)
        print(
            f"  ✓ {rel}  {size}x{size}  {os.path.getsize(path) / 1024:.1f} KB"
            f"  角色占边长 {1 - 2 * margin:.0%}"
        )


if __name__ == "__main__":
    main()
