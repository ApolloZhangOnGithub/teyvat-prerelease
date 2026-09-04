#!/usr/bin/env python3
"""vision.ocr 引擎 —— macOS Vision 本地 OCR（由 ocr-vision.ts 调用）

文字模式（默认）: python3 ocr-vision-engine.py <image> [--lang zh-Hans en] [--upscale N]
结构模式        : python3 ocr-vision-engine.py <image> --mode json [--group] [--gap N] [...]

--upscale: 0=auto（小图自动 2x；实验结论：10-12px 小字 1x 会漏行/错字，2x 全部识别）
           1=不放大  N=强制 N 倍（1~4）。
           自动放大时输出坐标已折算回原图坐标系，调用方无感知。
"""
import argparse
import json
import os
import sys
import tempfile
import time

try:
    import Quartz
    import Vision
    from Foundation import NSURL
except ImportError:
    print("缺少 PyObjC：pip3 install pyobjc-framework-Quartz pyobjc-framework-Vision", file=sys.stderr)
    sys.exit(2)


def load_cgimage(path, upscale):
    """加载图片为 CGImage；返回 (cg, 原图宽, 原图高, 放大倍数, 待清理临时文件)。
    注意：CGImage 是懒解码（image provider 仍指向源文件），临时文件必须等 OCR
    取完像素后才能删（删早了 Vision 静默拿到 0 个结果）。"""
    url = NSURL.fileURLWithPath_(os.path.abspath(path))
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    if src is None:
        raise RuntimeError(f"无法打开图片: {path}")
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    if cg is None:
        raise RuntimeError(f"图片解码失败: {path}")
    w = Quartz.CGImageGetWidth(cg)
    h = Quartz.CGImageGetHeight(cg)

    factor = upscale
    if factor == 0:
        factor = 2 if w * h <= 2_000_000 else 1
    if factor <= 1:
        return cg, w, h, 1, None
    factor = min(factor, 4)

    try:
        from PIL import Image
    except ImportError:
        return cg, w, h, 1, None  # 无 PIL 时退回原图（放大是优化不是必需）

    img = Image.open(path).convert("RGB")
    img = img.resize((img.width * factor, img.height * factor), Image.LANCZOS)
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    img.save(tmp)
    url2 = NSURL.fileURLWithPath_(tmp)
    src2 = Quartz.CGImageSourceCreateWithURL(url2, None)
    cg2 = Quartz.CGImageSourceCreateImageAtIndex(src2, 0, None) if src2 else None
    if cg2 is None:
        os.unlink(tmp)
        return cg, w, h, 1, None
    return cg2, w, h, factor, tmp


def recognize(cg, langs):
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setRecognitionLanguages_(langs)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    ok, _ = handler.performRequests_error_([req], None)
    if not ok:
        raise RuntimeError("Vision OCR 执行失败")
    return req.results() or []


def to_blocks(results, cg_w, cg_h, factor):
    """Vision bbox（左下原点、归一化）→ 原图像素坐标（左上原点）。"""
    blocks = []
    for obs in results:
        cand = obs.topCandidates_(1)[0]
        text = cand.string()
        if not text or not text.strip():
            continue
        bb = obs.boundingBox()
        x = int(bb.origin.x * cg_w / factor)
        y = int((1.0 - bb.origin.y - bb.size.height) * cg_h / factor)
        bw = max(1, int(bb.size.width * cg_w / factor))
        bh = max(1, int(bb.size.height * cg_h / factor))
        blocks.append({
            "text": text,
            "x": x, "y": y, "w": bw, "h": bh,
            "centerX": x + bw // 2, "centerY": y + bh // 2,
            "area": bw * bh,
        })
    blocks.sort(key=lambda b: (b["y"], b["x"]))
    return blocks


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
    """相邻行垂直间隙 < gap 的聚合成区域（沿用 struct_ocr 实验）。"""
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
    """启发式区域分类（GUI→TUI 化用）：menubar/statusbar/sidebar/content/button。"""
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
    ap = argparse.ArgumentParser(description="macOS Vision 本地 OCR（teyvat vision.ocr 引擎）")
    ap.add_argument("image", help="图片路径")
    ap.add_argument("--mode", choices=["text", "json"], default="text", help="text=纯文本（默认）json=结构化")
    ap.add_argument("--lang", nargs="*", default=["zh-Hans", "en"], help="识别语言，默认 zh-Hans en")
    ap.add_argument("--upscale", type=int, default=0, help="0=auto 1=不放大 N=强制 N 倍（1~4）")
    ap.add_argument("--group", action="store_true", help="json 模式额外输出区域聚合+分类")
    ap.add_argument("--gap", type=int, default=30, help="区域聚合垂直间隙阈值(px)，默认 30")
    args = ap.parse_args()

    t0 = time.time()
    tmp_cleanup = None
    try:
        cg, ow, oh, factor, tmp_cleanup = load_cgimage(args.image, args.upscale)
        cg_w, cg_h = Quartz.CGImageGetWidth(cg), Quartz.CGImageGetHeight(cg)
        blocks = to_blocks(recognize(cg, args.lang), cg_w, cg_h, factor)
        lines = group_lines(blocks)
    except Exception as e:
        print(f"OCR 失败: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        if tmp_cleanup and os.path.exists(tmp_cleanup):
            os.unlink(tmp_cleanup)
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
