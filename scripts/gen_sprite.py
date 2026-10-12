#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成小球贴图 src/renderer/ball-sprite.png
---------------------------------------------------------------------------
原图是一张带 3D 渲染光影的黄色蛋形小生物。本脚本把它「平面化」：

  1. 轮廓  —— 不描摹照片像素，而是用两段半椭圆拼出蛋形：
              上半椭圆的竖直半轴 = 0.583H，下半 = 0.417H，共用 0.5W 的水平半轴。
              这与原图逐行量出来的宽度曲线几乎完全重合（最宽处在 58.3% 高度），
              同时天然排除了原图底部的灰色投影。
  2. 颜色  —— 主体填充单一黄色，去掉高光 / 明暗渐变。
  3. 眼睛  —— 换成两个纯色圆：绿色虹膜 + 黑瞳孔。
  4. 嘴巴  —— 原来的浅褐色「透镜」整体抹掉，只留一道下弯的弧线（抛物线）。

所有几何参数都来自对原图的实测，注释里标了出处，方便以后微调。

用法：
    python scripts/gen_sprite.py            # 生成正式贴图 + 预览图
    python scripts/gen_sprite.py --preview  # 只生成预览图，不覆盖正式贴图
"""

import argparse
import os
import struct

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PNG = os.path.join(ROOT, "src", "renderer", "ball-sprite.png")
PREVIEW = os.path.join(ROOT, "docs", "sprite-preview.png")

# --------------------------------------------------------------- 实测几何参数
# 原图中蛋的外接矩形：x[172,946] y[100,1001] → 775 x 902
EGG_W, EGG_H = 775.0, 902.0
# 最宽的那一行在 y=625，即从蛋顶往下 58.3%
WAIST_F = 0.583

# 左眼中心 (436,271)、右眼中心 (682,271)，虹膜 84x91 / 85x89
EYE_CX = (436.0 - 172.0, 682.0 - 172.0)   # → (264, 510)
EYE_CY = 271.0 - 100.0                    # → 171
EYE_RX, EYE_RY = 42.0, 45.0
# 瞳孔实测 44x48，原图偏左下；这里取正圆并只保留下移，做成对称的「看着你」
PUPIL_R = 23.0
PUPIL_DY = 4.0

# 嘴巴实测：最宽处 y=346 时 x[483,631]，底边最低 y=362
MOUTH_X0, MOUTH_X1 = 483.0 - 172.0, 631.0 - 172.0   # → (311, 459)
MOUTH_Y = 346.0 - 100.0                             # 两端高度 → 246
MOUTH_MID_Y = 361.0 - 100.0                         # 弧线最低点 → 261
MOUTH_STROKE = 12.0

# ------------------------------------------------------------------ 平面化配色
BODY = (239, 201, 108)     # #EFC96C  主体（原图黄色中位色 #EAC367 略提亮）
IRIS = (106, 144, 66)      # #6A9042  虹膜（左右眼实测中位色平均）
IRIS_RIM = (77, 108, 45)   # #4D6C2D  虹膜外圈，可选
PUPIL = (20, 20, 20)       # #141414
MOUTH = (143, 90, 30)      # #8F5A1E  取原图嘴底边最深色

# ------------------------------------------------------------------- 贴图精度
SPRITE_W = 448                                   # 输出宽度（px）
SPRITE_H = int(round(SPRITE_W * EGG_H / EGG_W))  # → 521
SS = 4                                           # 超采样倍数，用来做抗锯齿


def bezier(p0, p1, p2, n=160):
    """二次贝塞尔采样成折线"""
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1.0 - t
        pts.append((
            u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
        ))
    return pts


def egg_mask(w, h, waist_f, n_up=1.9, n_low=2.0):
    """两段超椭圆拼成的蛋形，返回 L 模式的蒙版（255 = 蛋内）

    上半段用 n=1.9、下半段用 n=2.0：这是拿原图逐行宽度曲线拟合出来的结果。
    纯椭圆（n=2）在上半段会比原图宽 3~5%（头顶显得钝），n=1.9 把这段误差
    压到 1% 上下；下半段 n=2 反而更贴合，所以两边取不同的指数。
    两段在最宽处汇合，且该处斜率都为 0，不会出现折角。
    """
    buf = bytearray(w * h)
    cx = w / 2.0
    for py in range(h):
        v = (py + 0.5) / h
        if v <= waist_f:
            n, b = n_up, waist_f
        else:
            n, b = n_low, 1.0 - waist_f
        dv = abs(v - waist_f) / b
        if dv >= 1.0:
            continue
        half = 0.5 * (1.0 - dv ** n) ** (1.0 / n)
        x0 = max(0, int(round(cx - half * w)))
        x1 = min(w, int(round(cx + half * w)))
        row = py * w
        for px in range(x0, x1):
            buf[row + px] = 255
    return Image.frombytes("L", (w, h), bytes(buf))


def build_sprite(rim=False):
    """渲染一张平面化贴图"""
    Wb, Hb = SPRITE_W * SS, SPRITE_H * SS
    k = Wb / EGG_W                      # 原图像素 → 画布像素

    canvas = Image.new("RGBA", (Wb, Hb), (0, 0, 0, 0))
    mask = egg_mask(Wb, Hb, WAIST_F)
    body = Image.new("RGBA", (Wb, Hb), BODY + (255,))
    canvas = Image.composite(body, canvas, mask)

    draw = ImageDraw.Draw(canvas)

    # ---- 眼睛 ----
    for ecx in EYE_CX:
        cx = ecx * k
        cy = EYE_CY * k
        rx, ry = EYE_RX * k, EYE_RY * k
        if rim:
            pad = 3.5 * k
            draw.ellipse([cx - rx - pad, cy - ry - pad, cx + rx + pad, cy + ry + pad], fill=IRIS_RIM + (255,))
        draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=IRIS + (255,))

        pr = PUPIL_R * k
        pcy = cy + PUPIL_DY * k
        draw.ellipse([cx - pr, pcy - pr, cx + pr, pcy + pr], fill=PUPIL + (255,))

    # ---- 嘴巴：一道下弯的弧线 ----
    p0 = (MOUTH_X0, MOUTH_Y)
    p2 = (MOUTH_X1, MOUTH_Y)
    # 二次贝塞尔中点 = 0.25*P0 + 0.5*P1 + 0.25*P2，反解控制点让中点落在 MOUTH_MID_Y
    p1 = ((MOUTH_X0 + MOUTH_X1) / 2.0, 2.0 * MOUTH_MID_Y - MOUTH_Y)
    pts = [(x * k, y * k) for x, y in bezier(p0, p1, p2)]

    width = max(1, int(round(MOUTH_STROKE * k)))
    draw.line(pts, fill=MOUTH + (255,), width=width, joint="curve")
    # 两端补圆头，避免出现方角
    r = width / 2.0
    for (ex, ey) in (pts[0], pts[-1]):
        draw.ellipse([ex - r, ey - r, ex + r, ey + r], fill=MOUTH + (255,))

    return canvas.resize((SPRITE_W, SPRITE_H), Image.LANCZOS)


def make_preview(sprite_rim, sprite_plain):
    """预览：浅底 / 深底 / 桌面蓝底 上各种真实尺寸"""
    def at(img, w):
        h = int(round(w * img.height / img.width))
        return img.resize((w, h), Image.LANCZOS)

    sizes = [48, 72, 96, 120, 200]
    pad = 28
    cellw = max(sizes) + pad
    rowh = max(int(round(s * sprite_plain.height / sprite_plain.width)) for s in sizes) + pad

    rows = [
        ("带虹膜外圈 / 浅底", sprite_rim, (245, 246, 248)),
        ("纯平面 / 浅底", sprite_plain, (245, 246, 248)),
        ("纯平面 / 深底", sprite_plain, (34, 36, 40)),
        ("纯平面 / 桌面蓝", sprite_plain, (58, 92, 142)),
    ]
    sheet = Image.new("RGB", (cellw * len(sizes), rowh * len(rows)), (245, 246, 248))
    for r, (_label, sprite, bg) in enumerate(rows):
        layer = Image.new("RGB", (cellw * len(sizes), rowh), bg)
        for c, s in enumerate(sizes):
            sp = at(sprite, s)
            x = c * cellw + (cellw - sp.width) // 2
            y = (rowh - sp.height) // 2          # 层内居中，不要再加 r*rowh
            layer.paste(sp, (x, y), sp)
        sheet.paste(layer, (0, r * rowh))
    os.makedirs(os.path.dirname(PREVIEW), exist_ok=True)
    sheet.save(PREVIEW)


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    w, h = struct.unpack(">II", head[16:24])
    return w, h, os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true", help="只出预览图")
    ap.add_argument("--no-rim", action="store_true", help="虹膜不带深色外圈（更极简）")
    args = ap.parse_args()

    plain = build_sprite(rim=False)
    rim = build_sprite(rim=True)
    make_preview(rim, plain)

    if not args.preview:
        chosen = plain if args.no_rim else rim
        chosen.save(OUT_PNG, optimize=True)
        w, h, n = png_size(OUT_PNG)
        style = "纯双色" if args.no_rim else "虹膜带深色外圈"
        print(f"✓ 贴图已生成  {os.path.relpath(OUT_PNG, ROOT)}  {w}x{h}  {n/1024:.1f} KB  ({style})")
        print(f"  宽高比 h/w = {h/w:.4f}")

    print(f"✓ 预览图      {os.path.relpath(PREVIEW, ROOT)}")
    print(f"  四行依次：带外圈/浅底、纯双色/浅底、纯双色/深底、纯双色/桌面蓝")
    print(f"  列宽 = 真实渲染宽度 {[48, 72, 96, 120, 200]} px")


if __name__ == "__main__":
    main()
