"""命名来由（2026-09-09 dev-01）：本文件是 OCR engine 的 py 引擎本体（engine 词后缀）——
与 ts 封装（ocr-macvision.ts / ocr-rapidocr.ts——不带 engine 词）不同名（NORM 001 同名不同扩展禁止）。
engine 是 OCR 主概念——macvision/rapidocr 是 engine 的两种实现（非平行 provider 层）。
"""
#!/usr/bin/env python3
# ocr-rapidocr-engine.py — vision.ocr 供应商：Linux rapidocr（PP-OCRv3，onnxruntime 本地）
# 2026-09-09（用户定稿：Linux 默认装 rapidocr + eyes ocr 用它——"慢就只能慢，先能用"）
# macOS 用 ocr-vision-engine.py（Vision 框架）；Linux 无 Vision → 本引擎兜底（质量 ~90%、复杂图 2.4s/张）。
# group_lines/group_regions/classify_region 是纯几何算法（复用自 ocr-vision-engine.py——不依赖 Vision）。
# 输出格式与 ocr-vision-engine.py 对齐（text=纯文本 / json={image,blocks,lines,regions?}）——ts 端复用同解析。
import argparse
import json
import os
import sys
import time


def group_lines(blocks):
    """同一视觉行（y 区间重叠 ≥ 较小块高的一半）合并，行内按 x 排序 —— 阅读顺序。"""
    lines = []
    for b in blocks:
        placed = False
        for line in lines:
            overlap = min(line["y"] + line["h"], b["y"] + b["h"]) - max(line["y"], b["y"])
            if overlap >= 0.5 * min(line["h"], b["h"]):
                new_y = min(line["y"], b["y"])
                new_y2 = max(line["y"] + line["h"], b["y"] + b["h"])
                line["y"], line["h"] = new_y, new_y2 - new_y
                line["items"].append(b)
                placed = True
                break
        if not placed:
            lines.append({"items": [b], "y": b["y"], "h": b["h"]})
    out = []
    for line in sorted(lines, key=lambda l: l["y"]):
        items = sorted(line["items"], key=lambda b: b["x"])
        out.append({
            "text": " ".join(i["text"] for i in items),
            "x": min(i["x"] for i in items),
            "y": line["y"],
            "w": max(i["x"] + i["w"] for i in items) - min(i["x"] for i in items),
            "h": line["h"],
        })
    return out


def group_regions(lines, gap):
    """相邻行垂直间隙 < gap 的聚合成区域（与 ocr-vision-engine 同算法）。"""
    if not lines:
        return []
    regions = []
    cur = {"texts": [lines[0]["text"]], "x": lines[0]["x"], "y": lines[0]["y"],
           "w": lines[0]["w"], "h": lines[0]["h"]}
    for ln in lines[1:]:
        if ln["y"] - (cur["y"] + cur["h"]) < gap:
            cur["texts"].append(ln["text"])
            x2, bx2 = cur["x"] + cur["w"], ln["x"] + ln["w"]
            cur["x"] = min(cur["x"], ln["x"])
            cur["w"] = max(x2, bx2) - cur["x"]
            y2, by2 = cur["y"] + cur["h"], ln["y"] + ln["h"]
            cur["y"] = min(cur["y"], ln["y"])
            cur["h"] = max(y2, by2) - cur["y"]
        else:
            regions.append(cur)
            cur = {"texts": [ln["text"]], "x": ln["x"], "y": ln["y"], "w": ln["w"], "h": ln["h"]}
    regions.append(cur)
    return regions


def classify_region(r, img_w, img_h):
    """启发式区域分类（纯几何——GUI→TUI 化用；rapidocr 无界面语义，分类是几何近似）。"""
    x, y, w, h = r["x"], r["y"], r["w"], r["h"]
    rx, rw = x / img_w, w / img_w
    ry, rh = y / img_h, h / img_h
    if ry < 0.06 and rh < 0.09:
        return "menubar"
    if ry > 0.9:
        return "statusbar"
    if rw < 0.3 and rx < 0.15:
        return "sidebar"
    if rh > 0.06 and len(r["texts"]) > 1:
        return "content"
    if rh < 0.04 and rw < 0.35:
        return "button"
    return "unknown"


def main():
    ap = argparse.ArgumentParser(description="Linux rapidocr 本地 OCR（teyvat vision.ocr Linux 供应商）")
    ap.add_argument("image", help="图片路径")
    ap.add_argument("--mode", choices=["text", "json"], default="text", help="text=纯文本（默认）json=结构化")
    ap.add_argument("--group", action="store_true", help="json 模式额外输出区域聚合+分类")
    ap.add_argument("--gap", type=int, default=30, help="区域聚合垂直间隙阈值(px)，默认 30")
    args = ap.parse_args()

    t0 = time.time()
    try:
        from rapidocr_onnxruntime import RapidOCR
        engine = RapidOCR()
        result, _ = engine(args.image)
        from PIL import Image
        with Image.open(args.image) as im:
            ow, oh = im.size
        blocks = []
        for item in (result or []):
            box, text = item[0], item[1]
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            x, y = int(min(xs)), int(min(ys))
            blocks.append({"text": str(text), "x": x, "y": y, "w": int(max(xs)) - x, "h": int(max(ys)) - y})
        lines = group_lines(blocks)
    except Exception as e:
        print(f"OCR 失败: {e}", file=sys.stderr)
        sys.exit(1)
    elapsed_ms = int((time.time() - t0) * 1000)

    if args.mode == "text":
        for line in lines:
            print(line["text"])
        return

    result = {
        "image": {"width": ow, "height": oh},
        "elapsedMs": elapsed_ms,
        "totalBlocks": len(blocks),
        "blocks": blocks,
        "lines": lines,
    }
    if args.group:
        regions = group_regions(lines, args.gap)
        for r in regions:
            r["type"] = classify_region(r, ow, oh)
        result["regions"] = regions
        result["totalRegions"] = len(regions)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
