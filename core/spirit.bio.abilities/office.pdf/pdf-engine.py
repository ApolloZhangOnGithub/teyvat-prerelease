#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pdf-engine.py — office.pdf 引擎：PyMuPDF(fitz) 逐页提取 PDF 文本。
PyMuPDF 是 MuPDF 的 C 绑定，get_text 快且准。
边界：扫描版/图片型 PDF 无文本层 → 需 vision.ocr 配合（本引擎不处理）。
用法: python3 pdf-engine.py <path> [--mode text|json]
输出: --mode text → {"text": "..."} ; --mode json → {"text": "...", "blocks": [...], "pageCount": N, "truncated": bool}
"""
import argparse
import json
import sys

MAX_BLOCK_CHARS = 20_000


def extract(path):
    import fitz  # PyMuPDF

    doc = fitz.open(path)
    page_count = doc.page_count
    blocks = []
    for i, page in enumerate(doc):
        text = page.get_text("text").strip()
        if text:
            blocks.append(("page", text, i + 1))  # 2026-09-13：带真实页号——空白/扫描页被跳过后，之前用 cut 的下标当页号，后面全部错位

    truncated = False
    cut = []
    for typ, text, pno in blocks:
        if len(text) > MAX_BLOCK_CHARS:
            text = text[:MAX_BLOCK_CHARS] + "\n… [truncated]"
            truncated = True
        cut.append((typ, text, pno))

    lines = []
    for typ, text, pno in cut:
        if typ == "section":
            lines.append(f"\n===== {text} =====")
        else:
            lines.append(f"----- page {pno} -----\n{text}")
    return "\n".join(lines).strip(), [{"type": t, "text": x, "page": p} for t, x, p in cut], page_count, truncated


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--mode", choices=["text", "json"], default="text")
    args = ap.parse_args()

    try:
        text, blocks, page_count, truncated = extract(args.path)
        if args.mode == "json":
            print(json.dumps({"text": text, "blocks": blocks, "pageCount": page_count, "truncated": truncated}, ensure_ascii=False))
        else:
            print(json.dumps({"text": text}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
