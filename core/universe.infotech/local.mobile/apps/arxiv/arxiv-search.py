#!/usr/bin/env python3
"""arxiv-search.py — arXiv 论文搜索（arxiv MobileApp 的助手脚本）
2026-09-11（prime-agent）：原脚本在目录重构中丢失（全仓与 git 近 400 个 commit 都找不到），
arxiv app 因此一直返回"搜索失败"。此处按 app 的调用约定重写最小可用版本：
    python3 arxiv-search.py "<关键词>" [-n N]
只用标准库（urllib + xml.etree），不引入新依赖。
"""
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

API = "http://export.arxiv.org/api/query"
NS = {"a": "http://www.w3.org/2005/Atom"}


def search(query: str, limit: int = 5) -> str:
    url = API + "?" + urllib.parse.urlencode(
        {"search_query": f"all:{query}", "start": 0, "max_results": max(1, min(limit, 20)), "sortBy": "relevance"}
    )
    req = urllib.request.Request(url, headers={"User-Agent": "teyvat-arxiv-search/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            xml = r.read()
    except Exception as e:  # 网络不可达时给出可读错误，而不是堆栈
        return f"搜索失败: {e}"
    try:
        root = ET.fromstring(xml)
    except Exception as e:
        return f"结果解析失败: {e}"

    out = []
    for i, entry in enumerate(root.findall("a:entry", NS), 1):
        title = " ".join((entry.findtext("a:title", "", NS) or "").split())
        authors = [a.findtext("a:name", "", NS) for a in entry.findall("a:author", NS)][:3]
        pub = (entry.findtext("a:published", "", NS) or "")[:10]
        link = entry.findtext("a:id", "", NS)
        who = ", ".join(authors) + (" 等" if len(entry.findall("a:author", NS)) > 3 else "")
        out.append(f"{i}. {title}\n   {who} | {pub}\n   {link}")
    return "\n".join(out) if out else "（无结果）"


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print("用法: arxiv-search.py <关键词> [-n N]")
        return 1
    limit, words, i = 5, [], 0
    while i < len(args):
        if args[i] == "-n" and i + 1 < len(args):
            try:
                limit = int(args[i + 1])
            except ValueError:
                pass
            i += 2
            continue
        words.append(args[i])
        i += 1
    print(search(" ".join(words).strip(), limit))
    return 0


if __name__ == "__main__":
    sys.exit(main())
