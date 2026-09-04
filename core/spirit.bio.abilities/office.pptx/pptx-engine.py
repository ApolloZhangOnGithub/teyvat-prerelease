#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pptx-engine.py — office.pptx 引擎：python-pptx 递归遍历提取 .pptx 文本。
实测对比胜出方案（vs 仅顶层遍历 / unstructured，见 word_reader_research/output/CONCLUSION.md）：
  - 递归遍历 GROUP 形状（unstructured 丢备注，仅顶层遍历漏分组/表格）
  - 表格行 | 连接
  - 演讲者备注单独成块（PPT 最值钱的信息，特意保留）
用法: python3 pptx-engine.py <path> [--mode text|json]
输出: --mode text → {"text": "..."} ; --mode json → {"text": "...", "blocks": [...], "truncated": bool}
"""
import argparse
import json
import sys
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

MAX_BLOCK_CHARS = 20_000


def extract(path):
    prs = Presentation(path)
    blocks = []

    def walk(shapes, depth=0):
        for shape in shapes:
            if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                walk(shape.shapes, depth + 1)
            elif shape.has_table:
                rows = []
                for row in shape.table.rows:
                    rows.append(" | ".join(c.text.strip() for c in row.cells))
                blocks.append(("table", "\n".join(rows)))
            elif shape.has_text_frame:
                txt = shape.text_frame.text.strip()
                if txt:
                    blocks.append(("text", txt))

    for i, slide in enumerate(prs.slides):
        blocks.append(("section", f"slide {i+1}"))
        walk(slide.shapes)
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                blocks.append(("notes", notes))

    truncated = False
    cut = []
    for typ, text in blocks:
        if len(text) > MAX_BLOCK_CHARS:
            text = text[:MAX_BLOCK_CHARS] + "\n… [truncated]"
            truncated = True
        cut.append((typ, text))

    lines = []
    for typ, text in cut:
        if typ == "section":
            lines.append(f"\n===== {text} =====")
        elif typ in ("textbox", "notes"):
            lines.append(f"[{typ}] {text}")
        else:
            lines.append(text)
    return "\n".join(lines).strip(), [{"type": t, "text": x} for t, x in cut], truncated


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--mode", choices=["text", "json"], default="text")
    args = ap.parse_args()

    try:
        text, blocks, truncated = extract(args.path)
        if args.mode == "json":
            print(json.dumps({"text": text, "blocks": blocks, "truncated": truncated}, ensure_ascii=False))
        else:
            print(json.dumps({"text": text}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
