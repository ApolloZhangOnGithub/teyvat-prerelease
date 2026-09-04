#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docx-engine.py — office.docx 引擎：python-docx 全量遍历提取 .docx 文本。
实测对比胜出方案（vs docx2txt/mammoth/pandoc/unstructured，见 word_reader_research/output/CONCLUSION.md）：
  - python-docx 简单循环漏页眉/页脚/表格/文本框 → 本引擎全量遍历补齐
  - unstructured 丢文本框 → 本引擎用 XML 遍历 w:txbxContent 补齐
用法: python3 docx-engine.py <path> [--mode text|json]
输出: --mode text → {"text": "..."} ; --mode json → {"text": "...", "blocks": [...], "truncated": bool}
"""
import argparse
import json
import sys
from docx import Document
from docx.oxml.ns import qn

MAX_BLOCK_CHARS = 20_000  # 单块截断，防上下文爆炸


def walk_container(container):
    """收集容器(正文/页眉/页脚)内的段落与表格。"""
    out = []
    for p in container.paragraphs:
        if p.text.strip():
            style = (p.style.name or "").lower() if p.style else ""
            if "heading" in style or "标题" in style:
                out.append(("title", p.text.strip()))
            else:
                out.append(("text", p.text.strip()))
    for t in container.tables:
        rows = []
        for row in t.rows:
            rows.append(" | ".join(c.text.strip() for c in row.cells))
        out.append(("table", "\n".join(rows)))
    return out


def extract(path):
    doc = Document(path)
    blocks = []

    blocks.append(("section", "正文"))
    blocks.extend(walk_container(doc))

    # 页眉/页脚（多个 section）
    for i, sec in enumerate(doc.sections):
        h = walk_container(sec.header)
        if h:
            blocks.append(("section", f"页眉{i}"))
            blocks.extend(h)
        f = walk_container(sec.footer)
        if f:
            blocks.append(("section", f"页脚{i}"))
            blocks.extend(f)

    # 文本框：遍历 body 所有 w:txbxContent（python-docx 不直接暴露，XML 补齐）
    for txbx in doc.element.body.iter(qn("w:txbxContent")):
        texts = [t.text or "" for t in txbx.iter(qn("w:t"))]
        joined = "".join(texts).strip()
        if joined:
            blocks.append(("textbox", joined))

    # 截断 + 组装纯文本
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
