#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 README 用的三张 GIF。

- docs/images/flow-en.gif、flow-zh.gif：派单、打分、验收的流程
- docs/images/scoring.gif：Codex 与 Grok 的五项加权几何平均

画布 960×420，约 12 帧/秒，无限循环。
打分示例用固定分项，总分按加权几何平均现算，保留三位小数。
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 960, 420
FPS = 12
# 约 6 秒：流程多留几帧给盖章和可靠度提示
FLOW_FRAMES = 78
SCORE_FRAMES = 72

BG = (250, 250, 247)
WHITE = (255, 255, 255)
INK = (55, 65, 81)
MUTED = (107, 114, 128)
LINE = (226, 223, 214)
TRACK = (236, 234, 227)
ORANGE = (217, 119, 87)
ORANGE_SOFT = (252, 236, 228)
ORANGE_DEEP = (176, 90, 60)
BLUE = (59, 130, 246)
BLUE_SOFT = (232, 241, 254)
GREEN = (16, 185, 129)
GREEN_SOFT = (220, 247, 236)
GROK = (55, 65, 81)
GROK_SOFT = (236, 237, 239)

FONT_ZH = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_EN = "/System/Library/Fonts/Helvetica.ttc"

# 权重：擅长度、可靠度、额度、速度、负载
WEIGHTS = (3, 3, 0.25, 0.5, 0.5)
# 分项是示例真实值。总分不写死，由 geom() 计算：exp(Σ w·ln(part) / Σ w)
CODEX_PARTS = (1.00, 0.94, 0.55, 1.00, 1.00)
GROK_PARTS = (0.85, 0.99, 1.00, 0.88, 1.00)

OUT_DIR = Path(__file__).resolve().parents[1] / "images"

_FONTS: dict[tuple[str, int, int], ImageFont.FreeTypeFont] = {}


def font(path: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    key = (path, size, index)
    hit = _FONTS.get(key)
    if hit is None:
        hit = ImageFont.truetype(path, size, index=index)
        _FONTS[key] = hit
    return hit


def zh(size: int) -> ImageFont.FreeTypeFont:
    return font(FONT_ZH, size, 0)


def en(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return font(FONT_EN, size, 1 if bold else 0)


def text_width(fnt: ImageFont.FreeTypeFont, text: str) -> int:
    box = fnt.getbbox(text)
    return 0 if box is None else box[2] - box[0]


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def clamp01(t: float) -> float:
    return 0.0 if t < 0 else 1.0 if t > 1 else t


def ease_out_cubic(t: float) -> float:
    t = clamp01(t)
    return 1 - (1 - t) ** 3


def ease_in_out(t: float) -> float:
    t = clamp01(t)
    return 4 * t * t * t if t < 0.5 else 1 - ((-2 * t + 2) ** 3) / 2


def ease_out_back(t: float) -> float:
    t = clamp01(t)
    c1 = 1.70158
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


def seg(frame: int, start: int, length: int) -> float:
    """段内进度。段的第一帧为 0，最后一帧为 1，段后保持 1。"""
    if frame <= start:
        return 0.0
    if length <= 1:
        return 1.0
    if frame >= start + length - 1:
        return 1.0
    return (frame - start) / (length - 1)


def rrect(draw: ImageDraw.ImageDraw, box, radius: int, fill, outline=None, width: int = 1) -> None:
    draw.rounded_rectangle(list(box), radius=radius, fill=fill, outline=outline, width=width)


def draw_check(draw: ImageDraw.ImageDraw, x: float, y: float, size: float, color, width: int = 3) -> None:
    """手画对勾。黑体和 Helvetica 都没有这个字形。"""
    p1 = (x, y + size * 0.55)
    p2 = (x + size * 0.38, y + size * 0.95)
    p3 = (x + size, y + size * 0.12)
    draw.line([p1, p2, p3], fill=color, width=width, joint="curve")


def draw_arrow_right(draw: ImageDraw.ImageDraw, x0: float, x1: float, y: float, color, width: int = 3) -> None:
    draw.line([(x0, y), (x1 - 7, y)], fill=color, width=width)
    draw.polygon([(x1 - 9, y - 5), (x1, y), (x1 - 9, y + 5)], fill=color)


def draw_arrow_down(draw: ImageDraw.ImageDraw, x: float, y0: float, y1: float, color, width: int = 3) -> None:
    draw.line([(x, y0), (x, y1 - 7)], fill=color, width=width)
    draw.polygon([(x - 5, y1 - 8), (x + 5, y1 - 8), (x, y1)], fill=color)


def vbar(draw: ImageDraw.ImageDraw, x: float, baseline: float, width: float, height: float, max_h: float, color) -> None:
    track = [x, baseline - max_h, x + width, baseline]
    rrect(draw, track, 8, TRACK)
    if height < 1.5:
        return
    radius = min(8, width / 2, height / 2)
    rrect(draw, [x, baseline - height, x + width, baseline], radius, color)


def blit(base: Image.Image, overlay: Image.Image, cx: float, cy: float) -> None:
    x = int(round(cx - overlay.width / 2))
    y = int(round(cy - overlay.height / 2))
    if overlay.mode == "RGBA":
        base.paste(overlay, (x, y), overlay)
    else:
        base.paste(overlay, (x, y))


def packet(text: str, fnt: ImageFont.FreeTypeFont, fill) -> Image.Image:
    tw = text_width(fnt, text)
    w, h = tw + 28, 34
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=12, fill=fill + (255,))
    d.text((w / 2, h / 2), text, font=fnt, fill=(255, 255, 255, 255), anchor="mm")
    return im


def stamp_image(text: str, fnt: ImageFont.FreeTypeFont, scale: float) -> Image.Image:
    tw = text_width(fnt, text)
    check = 16
    pad_x, pad_y = 14, 10
    w = int(tw + check + pad_x * 2 + 8)
    h = int(pad_y * 2 + 22)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([1, 1, w - 2, h - 2], radius=12, fill=(255, 255, 255, 255), outline=ORANGE + (255,), width=3)
    d.text((pad_x, h / 2), text, font=fnt, fill=ORANGE + (255,), anchor="lm")
    draw_check(d, pad_x + tw + 8, h / 2 - 9, check, ORANGE + (255,), 3)
    if abs(scale - 1) > 0.01:
        nw = max(1, int(round(im.width * scale)))
        nh = max(1, int(round(im.height * scale)))
        im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    return im.rotate(-8, expand=True, resample=Image.Resampling.BICUBIC)


def toast_image(text: str, fnt: ImageFont.FreeTypeFont, alpha: float) -> Image.Image:
    tw = text_width(fnt, text)
    pad_x, h = 14, 30
    w = tw + pad_x * 2
    a = int(clamp01(alpha) * 255)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=10, fill=ORANGE_SOFT + (a,))
    d.text((w / 2, h / 2), text, font=fnt, fill=ORANGE_DEEP + (a,), anchor="mm")
    return im


def pill(draw: ImageDraw.ImageDraw, cx: float, cy: float, text: str, fnt, fill, text_fill) -> None:
    tw = text_width(fnt, text)
    w, h = tw + 16, 22
    rrect(draw, [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], 8, fill)
    draw.text((cx, cy), text, font=fnt, fill=text_fill, anchor="mm")


def geom(parts: tuple[float, ...], count: int) -> float:
    weights = WEIGHTS[:count]
    vals = parts[:count]
    total_w = sum(weights)
    return math.exp(sum(w * math.log(v) for w, v in zip(weights, vals)) / total_w)


def copy_of(parts: tuple[float, ...]) -> str:
    return f"{geom(parts, len(parts)):.3f}"


# ---------- 流程 ----------

# 时间轴（帧，含首帧）
FLY_AT, FLY_LEN = 6, 10
BAR_AT, BAR_DUR, BAR_GAP = 16, 10, 3
PICK_AT, PICK_LEN = 38, 8
WORK_AT, WORK_LEN = 46, 10
BACK_AT, BACK_LEN = 56, 8
STAMP_AT = 64
TOAST_AT = 68


def worker_boxes() -> list[tuple[int, int, int, int]]:
    x, w, h, gap = 652, 280, 112, 14
    y = 28
    boxes = []
    for _ in range(3):
        boxes.append((x, y, x + w, y + h))
        y += h + gap
    return boxes


def draw_dots(draw: ImageDraw.ImageDraw, x: float, y: float, frame: int, color) -> None:
    step = (frame // 2) % 4
    for i in range(3):
        on = i < step
        r = 3.5 if on else 2.5
        c = color if on else mix(color, WHITE, 0.65)
        draw.ellipse([x + i * 14 - r, y - r, x + i * 14 + r, y + r], fill=c)


def draw_flow(frame: int, lang: str) -> Image.Image:
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    en_ui = lang == "en"
    f_title = en(22, True) if en_ui else zh(22)
    f_role = en(16, True) if en_ui else zh(16)
    f_small = en(14) if en_ui else zh(14)
    f_bar = en(13) if en_ui else zh(13)
    f_name = en(18, True) if en_ui else zh(18)
    f_sub = en(14) if en_ui else zh(14)
    f_packet = en(15, True) if en_ui else zh(15)
    f_stamp = en(16, True) if en_ui else zh(16)
    f_toast = en(14, True) if en_ui else zh(14)
    f_badge = en(12, True) if en_ui else zh(12)
    f_head = en(18, True) if en_ui else zh(18)
    f_mid = en(13) if en_ui else zh(13)

    you_box = (28, 28, 268, 100)
    claude_box = (28, 132, 268, 392)
    mid_box = (284, 28, 636, 392)
    rrect(d, you_box, 16, WHITE, LINE, 2)
    rrect(d, claude_box, 18, WHITE, LINE, 2)
    rrect(d, mid_box, 18, WHITE, LINE, 2)
    draw_arrow_down(d, (you_box[0] + you_box[2]) / 2, you_box[3] + 4, claude_box[1] - 4, ORANGE, 3)

    you_label = "You" if en_ui else "你"
    d.text(((you_box[0] + you_box[2]) / 2, (you_box[1] + you_box[3]) / 2), you_label, font=f_title, fill=INK, anchor="mm")

    d.text((148, 176), "Claude", font=f_title, fill=INK, anchor="mm")
    d.text((148, 208), "Lead" if en_ui else "主管", font=f_role, fill=ORANGE, anchor="mm")

    # 打分条
    d.text((460, 58), "relay", font=f_head, fill=ORANGE, anchor="rm")
    d.text((468, 58), "score" if en_ui else "打分", font=f_head, fill=INK, anchor="lm")
    d.text((460, 84), "five weights" if en_ui else "五项权重", font=f_mid, fill=MUTED, anchor="mm")

    labels = ["Fit", "Rel", "Quota", "Speed", "Load"] if en_ui else ["擅长", "可靠", "额度", "速度", "负载"]
    weight_text = ["3", "3", "0.25", "0.5", "0.5"]
    bar_w, gap = 36, 16
    total = 5 * bar_w + 4 * gap
    x0 = 460 - total / 2
    baseline, max_h = 318, 176
    progresses = []
    for i in range(5):
        raw = seg(frame, BAR_AT + i * BAR_GAP, BAR_DUR)
        # 还没轮到这根柱子时 seg 会因为 frame<=start 变成 0；轮到之后才生长
        if frame < BAR_AT + i * BAR_GAP:
            raw = 0.0
        progresses.append(ease_out_cubic(raw))
        bh = max_h * (WEIGHTS[i] / 3) * progresses[-1]
        vx = x0 + i * (bar_w + gap)
        vbar(d, vx, baseline, bar_w, bh, max_h, ORANGE)
        num_color = ORANGE if progresses[-1] > 0.98 else MUTED
        d.text((vx + bar_w / 2, baseline - max_h - 16), weight_text[i], font=f_bar, fill=num_color, anchor="mm")
        d.text((vx + bar_w / 2, baseline + 22), labels[i], font=f_bar, fill=INK, anchor="mm")

    workers = [
        ("Codex", BLUE, BLUE_SOFT),
        ("Antigravity (Gemini)", GREEN, GREEN_SOFT),
        ("Grok", GROK, GROK_SOFT),
    ]
    boxes = worker_boxes()
    pick_t = 0.0 if frame < PICK_AT else ease_out_cubic(seg(frame, PICK_AT, PICK_LEN))
    for i, ((name, color, soft), box) in enumerate(zip(workers, boxes)):
        win = i == 0
        t = pick_t if win else 0.0
        fill = mix(WHITE, soft, t)
        border = mix(LINE, color, t)
        bw = 2 if t < 0.5 else 3
        rrect(d, box, 16, fill, border, bw)
        cx = box[0] + 28
        d.ellipse([box[0] + 18, box[1] + 28, box[0] + 32, box[1] + 42], fill=color)
        d.text((cx + 10, box[1] + 36), name, font=f_name, fill=INK, anchor="lm")
        if win and frame >= WORK_AT and frame < BACK_AT:
            status = "Working" if en_ui else "工作中"
            status_color = color
        elif win and frame >= BACK_AT:
            status = "Done" if en_ui else "完成"
            status_color = color
        else:
            status = "worker" if en_ui else "员工"
            status_color = MUTED
        d.text((cx + 10, box[1] + 68), status, font=f_sub, fill=status_color, anchor="lm")
        if win and WORK_AT <= frame < BACK_AT:
            sw = text_width(f_sub, status)
            draw_dots(d, cx + 18 + sw, box[1] + 68, frame, color)
        if win and t > 0:
            badge = "Top" if en_ui else "最高"
            scale = min(1.08, ease_out_back(t))
            pw = text_width(f_badge, badge) + 16
            ph = 22
            bw_img = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
            bd = ImageDraw.Draw(bw_img)
            bd.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=8, fill=color + (255,))
            bd.text((pw / 2, ph / 2), badge, font=f_badge, fill=(255, 255, 255, 255), anchor="mm")
            if abs(scale - 1) > 0.02:
                bw_img = bw_img.resize((max(1, int(pw * scale)), max(1, int(ph * scale))), Image.Resampling.LANCZOS)
            blit(im, bw_img, box[2] - 36, box[1] + 24)

    # 派单从主管飞向柱子中部。轨迹压低，避免盖住上方的权重数字。
    if FLY_AT <= frame < FLY_AT + FLY_LEN:
        t = ease_in_out(seg(frame, FLY_AT, FLY_LEN))
        p0 = (274, 210)
        p2 = (410, 236)
        p1 = (340, 250)
        u = 1 - t
        cx = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0]
        cy = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]
        fade = 1.0 if t < 0.82 else (1 - t) / 0.18
        chip = packet("Brief" if en_ui else "派单", f_packet, ORANGE)
        if fade < 0.999:
            alpha = chip.split()[-1].point(lambda v, f=fade: int(v * f))
            chip.putalpha(alpha)
        blit(im, chip, cx, cy)

    # 结果从 Codex 飞回盖章处，先下探再横穿柱身，不压住权重数字和类目标签。
    if BACK_AT <= frame < BACK_AT + BACK_LEN:
        t = ease_in_out(seg(frame, BACK_AT, BACK_LEN))
        p0 = (720, 110)
        p2 = (168, 286)
        p1 = (520, 340)
        u = 1 - t
        cx = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0]
        cy = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]
        blit(im, packet("Result" if en_ui else "结果", f_packet, BLUE), cx, cy)

    if frame >= STAMP_AT:
        t = ease_out_back(seg(frame, STAMP_AT, 6))
        scale = 0.45 + 0.55 * t
        # 回弹可能略大于 1，盖章停住后固定为 1
        if frame >= STAMP_AT + 5:
            scale = 1.0
        label = "Verified" if en_ui else "已验收"
        blit(im, stamp_image(label, f_stamp, scale), 148, 286)

    if frame >= TOAST_AT:
        t = ease_out_cubic(seg(frame, TOAST_AT, 6))
        label = "Reliability +1" if en_ui else "可靠度 +1"
        blit(im, toast_image(label, f_toast, t), 148, 286 + 52 - (1 - t) * 10)

    return im


# ---------- 打分 ----------

TERM_AT = 8
TERM_LEN = 10
TERMS = (
    ("擅长", "Fit"),
    ("可靠", "Reliability"),
    ("额度", "Quota"),
    ("速度", "Speed"),
    ("负载", "Load"),
)


def card_metrics(name_font: ImageFont.FreeTypeFont, score_font: ImageFont.FreeTypeFont) -> dict[str, int]:
    """结果卡片的纵向位置。

    名字行包含左侧色点。名字行下沿到分数字框上沿至少 8px，
    分数字框下沿到卡片底边至少 12px。
    """
    _left, name_top, _right, name_bot = name_font.getbbox("Codex", anchor="lm")
    _left, score_top, _right, score_bot = score_font.getbbox("0.000", anchor="lm")
    dot_half = 7
    row_above = max(-name_top, dot_half)
    row_below = max(name_bot, dot_half)
    line_gap = 12
    top_pad = 16
    bottom_pad = 18
    card_top = 316
    name_cy = card_top + top_pad + row_above
    score_cy = name_cy + row_below + line_gap + (-score_top)
    card_bottom = score_cy + score_bot + bottom_pad
    actual_gap = (score_cy + score_top) - (name_cy + row_below)
    actual_bottom = card_bottom - (score_cy + score_bot)
    if actual_gap < 8 or actual_bottom < 12:
        raise SystemExit(f"卡片间距不符合要求：行距 {actual_gap}px，底边距 {actual_bottom}px")
    if card_bottom > H - 8:
        raise SystemExit(f"结果卡片超出画布：bottom={card_bottom}，画布高度={H}")
    return {
        "card_top": card_top,
        "card_bottom": card_bottom,
        "name_cy": name_cy,
        "score_cy": score_cy,
    }


def score_state(frame: int, parts: tuple[float, ...]) -> float | None:
    if frame < TERM_AT:
        return None
    if frame >= TERM_AT + 5 * TERM_LEN:
        return geom(parts, 5)
    idx = (frame - TERM_AT) // TERM_LEN
    local = (frame - TERM_AT) % TERM_LEN
    t = ease_out_cubic(local / (TERM_LEN - 1))
    cur = geom(parts, idx + 1)
    if idx == 0:
        return cur * t
    prev = geom(parts, idx)
    return prev + (cur - prev) * t


def draw_scoring(frame: int) -> Image.Image:
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    f_title = zh(26)
    f_sub = zh(15)
    f_label = zh(15)
    f_num = zh(13)
    f_name = zh(16)
    f_big = zh(30)
    f_badge = zh(13)
    card = card_metrics(f_name, f_big)

    d.text((32, 34), "relay", font=zh(15), fill=ORANGE, anchor="lm")
    relay_w = text_width(zh(15), "relay")
    d.text((32 + relay_w + 10, 32), "打分 Score", font=f_title, fill=INK, anchor="lm")
    d.text((32, 68), "加权几何平均    geometric mean", font=f_sub, fill=MUTED, anchor="lm")

    # 图例
    legend_y = 36
    d.rounded_rectangle([700, legend_y - 8, 714, legend_y + 6], radius=3, fill=BLUE)
    d.text((722, legend_y), "Codex", font=zh(15), fill=INK, anchor="lm")
    d.rounded_rectangle([800, legend_y - 8, 814, legend_y + 6], radius=3, fill=GROK)
    d.text((822, legend_y), "Grok", font=zh(15), fill=INK, anchor="lm")

    col_w, gap = 172, 12
    left = (W - (5 * col_w + 4 * gap)) // 2
    baseline, max_h = 292, 132
    bar_w, inner = 40, 8
    done_until = -1
    if frame >= TERM_AT:
        done_until = min(4, (frame - TERM_AT) // TERM_LEN)
        # 当前项还在长，算作未完成；最后一帧才算完成
        local_start = TERM_AT + done_until * TERM_LEN
        if frame < local_start + TERM_LEN - 1 and frame < TERM_AT + 5 * TERM_LEN:
            done_until -= 1

    for i, (z, e) in enumerate(TERMS):
        x = left + i * (col_w + gap)
        cx = x + col_w / 2
        label = f"{z} {e}"
        d.text((cx, 102), label, font=f_label, fill=INK, anchor="mm")
        d.text((cx, 122), f"×{WEIGHTS[i]:g}", font=f_num, fill=MUTED, anchor="mm")
        pair = bar_w * 2 + inner
        bx = cx - pair / 2
        start = TERM_AT + i * TERM_LEN
        raw = 0.0 if frame < start else ease_out_cubic(seg(frame, start, TERM_LEN))
        for j, (parts, color) in enumerate(((CODEX_PARTS, BLUE), (GROK_PARTS, GROK))):
            bh = max_h * parts[i] * raw
            vbar(d, bx + j * (bar_w + inner), baseline, bar_w, bh, max_h, color)
        if i <= done_until:
            d.text((bx + bar_w / 2, baseline - max_h - 12), f"{CODEX_PARTS[i]:.2f}", font=f_num, fill=BLUE, anchor="mm")
            d.text((bx + bar_w + inner + bar_w / 2, baseline - max_h - 12), f"{GROK_PARTS[i]:.2f}", font=f_num, fill=INK, anchor="mm")

    win_start = TERM_AT + 5 * TERM_LEN
    win_t = 0.0 if frame < win_start else ease_out_cubic(seg(frame, win_start, 8))
    cards = [
        (32, "Codex", BLUE, BLUE_SOFT, score_state(frame, CODEX_PARTS), True),
        (496, "Grok", GROK, GROK_SOFT, score_state(frame, GROK_PARTS), False),
    ]
    for x, name, color, soft, value, is_win in cards:
        box = (x, card["card_top"], x + 432, card["card_bottom"])
        t = win_t if is_win else 0.0
        rrect(d, box, 16, mix(WHITE, soft, t), mix(LINE, color, max(t, 0.15)), 3 if t > 0.4 else 2)
        name_cy = card["name_cy"]
        score_cy = card["score_cy"]
        d.ellipse([x + 18, name_cy - 7, x + 32, name_cy + 7], fill=color)
        d.text((x + 42, name_cy), name, font=f_name, fill=INK, anchor="lm")
        shown = "—" if value is None else f"{value:.3f}"
        d.text((x + 28, score_cy), shown, font=f_big, fill=color if value is not None else MUTED, anchor="lm")
        if is_win and t > 0:
            badge = "胜出 Winner"
            scale = min(1.06, ease_out_back(t))
            tw = text_width(f_badge, badge)
            pw, ph = tw + 18, 24
            bw_img = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
            bd = ImageDraw.Draw(bw_img)
            bd.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=8, fill=BLUE + (255,))
            bd.text((pw / 2, ph / 2), badge, font=f_badge, fill=(255, 255, 255, 255), anchor="mm")
            if abs(scale - 1) > 0.02:
                bw_img = bw_img.resize((max(1, int(pw * scale)), max(1, int(ph * scale))), Image.Resampling.LANCZOS)
            blit(im, bw_img, box[2] - 16 - pw / 2, name_cy)

    return im


def quantize_shared(frames: list[Image.Image], colors: int = 128) -> list[Image.Image]:
    step = max(1, len(frames) // 8)
    samples = frames[::step]
    sheet = Image.new("RGB", (frames[0].width, frames[0].height * len(samples)))
    for i, sample in enumerate(samples):
        sheet.paste(sample, (0, i * frames[0].height))
    ref = sheet.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    return [frame.quantize(palette=ref, dither=Image.Dither.NONE) for frame in frames]


def save_gif(path: Path, frames: list[Image.Image]) -> None:
    duration = int(round(1000 / FPS))
    paletted = quantize_shared(frames)
    paletted[0].save(
        path,
        save_all=True,
        append_images=paletted[1:],
        duration=duration,
        loop=0,
        optimize=True,
        disposal=1,
    )


def assert_scores() -> None:
    if WEIGHTS != (3, 3, 0.25, 0.5, 0.5):
        raise SystemExit(f"权重与约定不一致：{WEIGHTS}")
    if CODEX_PARTS != (1.00, 0.94, 0.55, 1.00, 1.00):
        raise SystemExit(f"Codex 分项与约定不一致：{CODEX_PARTS}")
    if GROK_PARTS != (0.85, 0.99, 1.00, 0.88, 1.00):
        raise SystemExit(f"Grok 分项与约定不一致：{GROK_PARTS}")

    def formula(parts: tuple[float, ...]) -> str:
        total_w = sum(WEIGHTS)
        raw = math.exp(sum(w * math.log(v) for w, v in zip(WEIGHTS, parts)) / total_w)
        return f"{raw:.3f}"

    codex = copy_of(CODEX_PARTS)
    grok = copy_of(GROK_PARTS)
    if codex != formula(CODEX_PARTS) or grok != formula(GROK_PARTS):
        raise SystemExit(f"展示用总分与公式不一致：Codex {codex}，Grok {grok}")
    print(f"weighted geometric mean: Codex {codex}, Grok {grok}")


def main(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    preview: Path | None = None
    if "--preview" in argv:
        idx = argv.index("--preview")
        if idx + 1 >= len(argv):
            raise SystemExit("用法：--preview <目录>")
        preview = Path(argv[idx + 1])
        preview.mkdir(parents=True, exist_ok=True)

    assert_scores()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    jobs = {
        "flow-en.gif": [draw_flow(i, "en") for i in range(FLOW_FRAMES)],
        "flow-zh.gif": [draw_flow(i, "zh") for i in range(FLOW_FRAMES)],
        "scoring.gif": [draw_scoring(i) for i in range(SCORE_FRAMES)],
    }
    if preview is not None:
        picks = {
            "flow-en.gif": (0, 10, 28, 42, 50, 60, 66, 76),
            "flow-zh.gif": (0, 10, 28, 42, 50, 60, 66, 76),
            "scoring.gif": (0, 16, 36, 52, 62, 71),
        }
        for name, frames in jobs.items():
            for i in picks[name]:
                frames[i].save(preview / f"{name}-{i:02d}.png")

    limit = int(1.5 * 1024 * 1024)
    for name, frames in jobs.items():
        path = OUT_DIR / name
        save_gif(path, frames)
        size = path.stat().st_size
        with Image.open(path) as gif:
            loop = gif.info.get("loop")
            frames_n = gif.n_frames
        print(f"{path.name}: {size} bytes ({size / 1024:.1f} KiB), frames={frames_n}, loop={loop}")
        if size >= limit:
            raise SystemExit(f"{path.name} 超过 1.5MB")
        if loop != 0:
            raise SystemExit(f"{path.name} 没有设置为循环播放")


if __name__ == "__main__":
    main()
