#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""xlsx-engine.py — office.xlsx 引擎：openpyxl 提取 .xlsx 文本。
实测对比胜出方案（vs pandas / unstructured，见 word_reader_research/output/CONCLUSION.md）：
  - data_only=False 保留公式原文（pandas/unstructured 都丢公式）
  - 逐 sheet 逐行 | 连接，合并单元格/长文本天然支持
  - 无 pandas to_string 的对齐空格噪音
用法: python3 xlsx-engine.py <path> [--mode text|json]
输出: --mode text → {"text": "..."} ; --mode json → {"text": "...", "blocks": [...], "truncated": bool}
"""
import argparse
import json
import sys
from openpyxl import load_workbook

MAX_BLOCK_CHARS = 20_000

# 老格式 .xls 用 xlrd（2.x，只读）；缺失时给出可安装提示
_HAS_XLRD = True
try:
    import xlrd
except ImportError:
    _HAS_XLRD = False


def extract(path):
    ext = path.lower().rsplit(".", 1)[-1] if "." in path else ""
    if ext == "xls":
        return _extract_xls(path)
    return _extract_xlsx(path)


def _cell_str(v):
    """单元格值 → 字符串。ArrayFormula 等 openpyxl 特殊对象取 .text，其余 str()。"""
    if v is None:
        return None
    if isinstance(v, str):
        return v
    # openpyxl 的 ArrayFormula / Formula 对象：取公式文本
    for attr in ("text",):
        if hasattr(v, attr) and getattr(v, attr) is not None:
            try:
                return str(getattr(v, attr))
            except Exception:
                pass
    return str(v)


def _extract_xlsx(path):
    wb = load_workbook(path, data_only=False)
    blocks = []
    for ws in wb.worksheets:
        blocks.append(("section", f"sheet: {ws.title}"))
        for row in ws.iter_rows():
            cells = []
            for c in row:
                s = _cell_str(c.value)
                if s is not None and s.strip() != "":
                    cells.append(s)
            if cells:
                blocks.append(("row", " | ".join(cells)))
    return _finalize(blocks)


def _extract_xls(path):
    """老格式 .xls：xlrd 2.x 直读（实测 248ms/16万格，比 pandas 引擎快 2.6x）。"""
    if not _HAS_XLRD:
        raise RuntimeError("xlrd 未安装，无法读 .xls。安装: pip3 install xlrd")
    wb = xlrd.open_workbook(path)
    blocks = []
    for ws in wb.sheets():
        blocks.append(("section", f"sheet: {ws.name}"))
        for r in range(ws.nrows):
            cells = []
            for c in range(ws.ncols):
                v = ws.cell_value(r, c)
                if v is not None and str(v).strip() != "":
                    cells.append(str(v))
            if cells:
                blocks.append(("row", " | ".join(cells)))
    return _finalize(blocks)


def _finalize(blocks):
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
