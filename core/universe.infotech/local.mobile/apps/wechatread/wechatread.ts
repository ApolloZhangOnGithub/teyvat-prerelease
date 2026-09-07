import type { MobileApp } from "../../system.kernel/kernel.ts";
import { execSync } from "node:child_process";
import { readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { logerr, serviceKey, apiFetch } from "#paths";

const PAGE = 18;
const SKILL_VER = "1.0.4";
const API = "https://i.weread.qq.com/api/agent/gateway";
const ANNAS_API = "https://zh.annas-archive.gl";
let _pd = "";

// ── WeRead API（仅公共接口，不涉及个人数据）──
async function wereadApi(apiName: string, params: Record<string, any> = {}): Promise<any> {
  const key = serviceKey("weread");
  if (!key) throw new Error("weread 未配置，使用 /config 编辑");
  const body = { api_name: apiName, skill_version: SKILL_VER, ...params };
  const r = await apiFetch(API, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }, { service: "weread", api: apiName, key });
  if (!r.ok) throw new Error(`WeRead API ${r.status}`);
  return r.json();
}

// ── Tab 定义 ─────────────────────────────────────────────────
type Tab = "weread" | "local" | "shared";

function tabBar(active: Tab): string {
  const wr = active === "weread" ? "[微信读书]" : " 微信读书 ";
  const lo = active === "local" ? "[本地书架]" : " 本地书架 ";
  const sh = active === "shared" ? "[共享书架]" : " 共享书架 ";
  return `  ${wr}  |  ${lo}  |  ${sh}\n${"─".repeat(40)}`;
}

// ── 微信读书 Tab ─────────────────────────────────────────────
async function wereadHome(): Promise<string> {
  const key = serviceKey("weread");
  if (!key) return "微信读书\n\n  weread 未配置，使用 /config 编辑";
  return "微信读书\n\n命令: 搜索 xxx | 详情 书名 | 目录 书名";
}

async function wereadAction(cmd: string): Promise<string> {
  try {
    if (cmd.startsWith("搜索 ") || cmd.startsWith("search ")) {
      const kw = cmd.replace(/^(搜索 |search )/, "");
      const r = await wereadApi("/store/search", { keyword: kw, count: 8, scope: 10 });
      const results = r.results || [];
      const books = results.flatMap((g: any) => g.books || []);
      if (!books.length) return `搜索: ${kw}\n\n  无结果`;
      let s = `搜索: ${kw}\n\n`;
      for (const b of books.slice(0, 8)) {
        const info = b.bookInfo || b;
        const rating = info.newRatingDetail?.title ? ` [${info.newRatingDetail.title}]` : "";
        s += `  📖 ${info.title || "?"} — ${info.author || ""}${rating}\n`;
      }
      return s;
    }
    if (cmd.startsWith("详情 ") || cmd.startsWith("info ")) {
      const name = cmd.replace(/^(详情 |info )/, "").trim();
      const sr = await wereadApi("/store/search", { keyword: name, count: 1, scope: 10 });
      const results = sr.results || [];
      const books = results.flatMap((g: any) => g.books || []);
      const book = books[0]?.bookInfo || books[0];
      if (!book) return `未找到「${name}」`;
      const info = await wereadApi("/book/info", { bookId: book.bookId });
      const rating = info.newRatingDetail?.title || "";
      const ratingCount = info.newRatingCount ? `(${info.newRatingCount}人评)` : "";
      let s = `${info.title || book.title}\n\n`;
      s += `  作者: ${info.author || ""}\n`;
      if (info.publisher) s += `  出版: ${info.publisher}\n`;
      if (info.isbn) s += `  ISBN: ${info.isbn}\n`;
      if (info.wordCount) s += `  字数: ${Math.round(info.wordCount / 10000)}万\n`;
      if (rating) s += `  评价: ${rating} ${ratingCount}\n`;
      if (info.intro) s += `\n  ${(info.intro).slice(0, 400)}`;
      return s;
    }
    if (cmd.startsWith("目录 ") || cmd.startsWith("toc ")) {
      const name = cmd.replace(/^(目录 |toc )/, "").trim();
      const sr = await wereadApi("/store/search", { keyword: name, count: 1, scope: 10 });
      const results = sr.results || [];
      const books = results.flatMap((g: any) => g.books || []);
      const book = books[0]?.bookInfo || books[0];
      if (!book) return `未找到「${name}」`;
      const ch = await wereadApi("/book/chapterinfo", { bookId: book.bookId });
      const chapters = ch.chapters || [];
      if (!chapters.length) return `「${book.title}」无章节信息`;
      let s = `${book.title} · 目录 (${chapters.length} 章)\n\n`;
      for (const c of chapters.slice(0, 30)) {
        s += `  ${c.chapterIdx != null ? c.chapterIdx + ". " : ""}${c.title || ""}\n`;
      }
      if (chapters.length > 30) s += `  ... 共 ${chapters.length} 章\n`;
      return s;
    }
    if (cmd.startsWith("安娜搜 ") || cmd.startsWith("annas ")) {
      const kw = cmd.replace(/^(安娜搜 |annas )/, "");
      return await annaSearchCmd(kw);
    }
    return "微信读书\n\n  搜索 xxx | 详情 书名 | 目录 书名 | 安娜搜 xxx";
  } catch (e: any) { return `错误: ${e.message}`; }
}

// ── Anna's Archive ──
// 搜索免费(走HTML)，下载走 fast_download API (25次/天)

interface AnnaResult { md5: string; title: string; author: string; lang: string; ext: string; filesize: number; }

let _annaKey = "";
function annaResults(s?: AnnaResult[]): AnnaResult[] {
  const key = '_annaResults';
  if (s) { (globalThis as any)[key] = s; return s; }
  return (globalThis as any)[key] || [];
}

function annaKey(): string {
  if (_annaKey) return _annaKey;
  try { _annaKey = serviceKey("anna") || ""; } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechatread/wechatread.ts] " + ((e as any)?.message || e)); _annaKey = ""; }
  return _annaKey;
}

function safeName(s: string): string {
  return s.replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80);
}

async function annaSearchCmd(query: string): Promise<string> {
  const key = annaKey();
  const url = `${ANNAS_API}/search?q=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return `Anna's Archive HTTP ${r.status}`;
  const html = await r.text();
  
  // 提取书名: class="break-words" 的 <a> 标签
  const titleRe = /href="\/md5\/([a-f0-9]{32})[^"]*"[^>]*break-words[^>]*>([^<]+)<\/a>/g;
  const results: {md5:string; title:string}[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    if (results.length >= 8) break;
    results.push({md5: m[1], title: m[2].trim()});
  }
  
  const list = results.map(b => ({
    md5: b.md5,
    title: b.title,
    author: "?",
    lang: "?",
    ext: "?",
    filesize: 0,
  }));
  
  if (!list.length) return `"${query}" 无结果`;
  const hasKey = key ? "" : "\n⚠️ 未配 Fast key，只能搜不能下。用 /config 配 anna.apiKey";
  annaResults(list);
  return `安娜搜: ${query}\n\n` + list.map((b, i) =>
    `${i+1}. ${b.title.slice(0,70)}\n   md5:${b.md5.slice(0,8)}…`
  ).join("\n") + `\n\n输入「安娜下 序号」下载${hasKey}`;
}

async function annaDownloadCmd(idx: number): Promise<string> {
  const results = annaResults();
  if (!results.length) return "请先「安娜搜 xxx」搜索";
  const b = results[idx - 1];
  if (!b) return `序号 ${idx} 无效 (1-${results.length})`;
  
  const key = annaKey();
  if (!key) return "未配置 Anna's Archive Fast key。使用 /config 编辑 anna.apiKey";
  
  // 1. 获取下载链接
  const apiUrl = `${ANNAS_API}/dyn/api/fast_download.json?md5=${b.md5}&key=${encodeURIComponent(key)}`;
  const r1 = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
  const data = await r1.json() as any;
  if (!data.download_url) return `下载失败: ${data.error || '无下载链接'}`;
  
  // 2. 下载文件
  const r2 = await fetch(data.download_url, { signal: AbortSignal.timeout(120000) });
  if (!r2.ok) return `下载失败: HTTP ${r2.status}`;
  const buf = Buffer.from(await r2.arrayBuffer());
  
  // 3. 存到 books 目录，防重命名
  const dir = booksDir();
  const ext = b.ext === "epub" ? ".epub" : b.ext === "pdf" ? ".pdf" : ".epub";
  let name = `${safeName(b.title)}_${b.md5.slice(0,6)}${ext}`;
  let dest = join(dir, name);
  let counter = 1;
  while (existsSync(dest)) {
    name = `${safeName(b.title)}_${b.md5.slice(0,6)}_${counter}${ext}`;
    dest = join(dir, name);
    counter++;
  }
  writeFileSync(dest, buf);
  
  // 从搜索结果移除
  results.splice(idx - 1, 1);
  annaResults(results);
  
  // 4. 解析剩余额度
  let quotaStr = "";
  const info = data.account_fast_download_info;
  if (info) {
    const dl = info.downloads_total || info.dl_total || 0;
    const used = info.downloads_used || info.dl_used || 0;
    if (dl > 0) quotaStr = ` | 剩余 ${dl - used}/${dl} 次`;
  }
  
  return `✅ 已下载: ${name}\n   ${(buf.length/1024/1024).toFixed(1)}MB → 本地书架${quotaStr}`;
}

// ── 本地 EPUB Tab（保留原有功能）────────────────────────────
interface Chapter { title: string; content: string }
interface Book { file: string; title: string; author: string; chs: Chapter[] }

function stripHtml(html: string): string {
  return html.replace(/<head[\s\S]*?<\/head>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<[^>]+>/g,"").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\n{3,}/g,"\n\n").trim();
}

function epubUnzip(epub: string, innerPath: string): string {
  return execSync(`unzip -p ${JSON.stringify(epub)} ${JSON.stringify(innerPath)}`,{encoding:"utf8",maxBuffer:10*1024*1024,timeout:15000});
}

function parseEpub(epub: string): Book|null {
  try{
    const container=epubUnzip(epub,"META-INF/container.xml");
    const opfRel=container.match(/full-path="([^"]+)"/)?.[1]||"";if(!opfRel)return null;
    const opf=epubUnzip(epub,opfRel);const base=opfRel.includes('/')?opfRel.replace(/\/[^/]+$/,''):'';
    const title=opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.replace(/<[^>]+>/g,"").trim()||"Unknown";
    const author=opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)?.[1]?.replace(/<[^>]+>/g,"").trim()||"Unknown";
    const idHref=new Map<string,string>();for(const m of opf.matchAll(/<item[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"/gi))idHref.set(m[1],m[2]);for(const m of opf.matchAll(/<item[^>]*\bhref="([^"]+)"[^>]*\bid="([^"]+)"/gi))idHref.set(m[2],m[1]);
    const spine:string[]=[];for(const m of opf.matchAll(/<itemref[^>]*idref="([^"]+)"/gi))spine.push(m[1]);
    const chs:Chapter[]=[];
    for(const idref of spine){
      const href=idHref.get(idref);if(!href)continue;
      const fullPath=base?base+"/"+href:href;
      try{const html=epubUnzip(epub,fullPath);const text=stripHtml(html);if(text.length<20)continue;
        const titleTag=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g,'').trim();
        const chTitle=(titleTag&&titleTag!=='未知'&&titleTag!=='Unknown')?titleTag:(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1]||'').replace(/<[^>]+>/g,'').trim();
        const cleanTitle=chTitle||`Ch${chs.length+1}`;
        chs.push({title:cleanTitle,content:text});}catch (e) { console.error("[universe.infotech/local.mobile/apps/wechatread/wechatread.ts] " + ((e as any)?.message || e));continue;}
    }
    if(chs.length===0)return null;return{file:epub,title,author,chs};
  }catch (e) { console.error("[universe.infotech/local.mobile/apps/wechatread/wechatread.ts] " + ((e as any)?.message || e));return null;}
}

function booksDir(){const d=join(_pd,"wechatread","books");try{mkdirSync(d,{recursive:true});}catch (e) { console.error("[universe.infotech/local.mobile/apps/wechatread/wechatread.ts] " + ((e as any)?.message || e)); }return d;}
const SHARED_BOOKS = join(homedir(), ".teyvat", "AppData", "shared", "wechatread", "books");
const SHARED_META = join(homedir(), ".teyvat", "AppData", "shared", "wechatread", "shared.json");
function sharedBooksDir(){try{mkdirSync(SHARED_BOOKS,{recursive:true});}catch (e) { console.error("[universe.infotech/local.mobile/apps/wechatread/wechatread.ts] " + ((e as any)?.message || e)); }return SHARED_BOOKS;}
function scanEpubs():string[]{try{return readdirSync(booksDir()).filter(f=>f.endsWith(".epub"));}catch (e) { console.error("[universe.infotech/local.mobile/apps/wechatread/wechatread.ts] " + ((e as any)?.message || e));return[];}}
function scanSharedEpubs():string[]{try{return readdirSync(sharedBooksDir()).filter(f=>f.endsWith(".epub"));}catch (e) { console.error("[universe.infotech/local.mobile/apps/wechatread/wechatread.ts] " + ((e as any)?.message || e));return[];}}
function isSymlink(dir:string, file:string):boolean{try{return lstatSync(join(dir,file)).isSymbolicLink();}catch (e) { console.error("[universe.infotech/local.mobile/apps/wechatread/wechatread.ts] " + ((e as any)?.message || e));return false;}}
interface SharedEntry { from: string; ts: number }
function loadSharedMeta(): Record<string, SharedEntry> { try { return JSON.parse(readFileSync(SHARED_META, "utf8")).books || {}; } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechatread/wechatread.ts] " + ((e as any)?.message || e)); return {}; } }
function saveSharedMeta(books: Record<string, SharedEntry>) { try { mkdirSync(join(homedir(), ".teyvat", "AppData", "shared", "wechatread"), { recursive: true }); writeFileSync(SHARED_META, JSON.stringify({ books }, null, 2)); } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechatread/wechatread.ts] " + ((e as any)?.message || e)); } }
function fmtTime(ts: number): string { const d = new Date(ts); return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }
function agentName(): string { return process.env.PAIMON_AGENT_NAME || "unknown"; }
const _cache=new Map<string,Book>();
function getBook(file:string):Book|null{if(_cache.has(file))return _cache.get(file)!;const b=parseEpub(join(booksDir(),file));if(b)_cache.set(file,b);return b;}
function fmtBar(cur:number,total:number):string{const p=Math.min(100,Math.round(Math.min(cur,total)/Math.max(total,1)*100));const f=Math.max(0,Math.floor(p/10));return`[ ${"█".repeat(f)}${"░".repeat(10-f)} ] ${p}%`;}

function sharedHome(): string {
  const files=scanSharedEpubs();
  const meta=loadSharedMeta();
  let s="共享书架\n\n";
  if(files.length===0){s+="  共享书架为空。\n  在本地书架用「分享 N」分享书到共享书架\n";}
  else{s+=`  ${files.length} 本:\n`;files.forEach((f,i)=>{
    const m=meta[f];
    const info=m?` — ${m.from} · ${fmtTime(m.ts)}`:"";
    s+=`  ${i+1}. ${f}${info}\n`;
  });}
  s+="\n输入「打开 书名」或序号";
  return s;
}

function localHome(): string {
  const files=scanEpubs();
  let s="本地书架\n\n";
  if(files.length===0){s+="  书架为空。\n  把 .epub 放到 wechatread/books/\n";}
  else{s+=`  ${files.length} 本:\n`;files.forEach((f,i)=>s+=`  ${i+1}. ${f}${isSymlink(booksDir(),f)?" 🔗":""}\n`);}
  s+="\n输入「打开 书名」或序号 | 「分享 N」分享到共享书架";
  return s;
}

// 分享：移实体到共享目录，本地建 symlink，记录到 shared.json
function shareBook(idx: number): string {
  const files=scanEpubs();
  if(idx<1||idx>files.length) return `序号 ${idx} 无效 (1-${files.length})`;
  const f=files[idx-1];
  const localPath=join(booksDir(),f);
  const sharedPath=join(sharedBooksDir(),f);
  if(lstatSync(localPath).isSymbolicLink()) return `「${f}」已是共享链接`;
  if(existsSync(sharedPath)) return `共享书架已有同名文件，请先处理: ${f}`;
  renameSync(localPath, sharedPath);
  symlinkSync(sharedPath, localPath);
  _cache.delete(f);
  const meta=loadSharedMeta();
  meta[f]={from:agentName(),ts:Date.now()};
  saveSharedMeta(meta);
  return `✅ 已分享: ${f}\n   来自 ${agentName()} · ${fmtTime(Date.now())}`;
}

function localAction(cmd: string, st: any): { screen: string; state: any } {
  const files=scanEpubs();
  const shareMatch=cmd.match(/^(分享|share)\s+(.+)$/i);
  if(shareMatch){
    const arg=shareMatch[2].trim();
    const n=parseInt(arg);
    if(!isNaN(n)) return{screen:shareBook(n),state:{tab:"local"}};
    const idx=files.findIndex(f=>{const b=getBook(f);return b&&b.title.toLowerCase().includes(arg.toLowerCase());});
    if(idx<0) return{screen:`未找到「${arg}」`,state:{tab:"local"}};
    return{screen:shareBook(idx+1),state:{tab:"local"}};
  }
  if(st?.file&&st?.ci!=null){
    if(cmd==="返回"||cmd==="back") return{screen:localHome(),state:{tab:"local"}};
    const b=getBook(st.file);if(!b)return{screen:localHome(),state:{tab:"local"}};
    const ch=b.chs[st.ci];const lines=ch.content.split("\n");const pos=st.pos||0;const totalPages=Math.ceil(lines.length/PAGE)||1;const curPage=Math.floor(pos/PAGE)+1;
    if(cmd==="下一页"||cmd==="next"){const np=Math.min(pos+PAGE,Math.max(0,lines.length-PAGE));const isEnd=np+PAGE>=lines.length;const npg=isEnd?totalPages:Math.floor(np/PAGE)+1;const tail=isEnd?`\n\n📌 本章完 (${npg}/${totalPages})「目录」「下一章」`:`\n\n「上一页」「下一页」「目录」「返回」`;return{screen:`📖 ${b.title} · ${ch.title}  ${npg}/${totalPages}\n${fmtBar(np+PAGE,lines.length)}\n\n${lines.slice(np,np+PAGE).join("\n")}${tail}`,state:{...st,pos:np}};}
    if(cmd==="上一页"||cmd==="prev"){const np=Math.max(0,pos-PAGE);const npg=Math.floor(np/PAGE)+1;return{screen:`📖 ${b.title} · ${ch.title}  ${npg}/${totalPages}\n${fmtBar(np+PAGE,lines.length)}\n\n${lines.slice(np,np+PAGE).join("\n")}\n\n「上一页」「下一页」「目录」「返回」`,state:{...st,pos:np}};}
    if(cmd==="下一章"||cmd==="nextch"){const nextCi=st.ci+1;if(nextCi>=b.chs.length)return{screen:`📖 ${b.title}\n\n全书完。`,state:{tab:"local"}};return _openCh(st.file,nextCi);}
    if(cmd==="目录"||cmd==="toc")return{screen:_toc(st.file),state:{...st,ci:undefined,pos:undefined}};
    if(cmd==="@"){const ci=st.ci+1;const pg=curPage;return{screen:`📖 ${b.title}\n\n📍 第${ci}章 · ${ch.title}  Page ${pg}/${totalPages}\n📚 全书 ${ci}/${b.chs.length} 章\n @看进度 不翻页`,state:st};}
    return{screen:`📖 ${b.title} · ${ch.title}\n${fmtBar(pos+PAGE,lines.length)}\n\n${lines.slice(pos,pos+PAGE).join("\n")}\n\n「上一页」「下一页」「目录」「返回」`,state:st};
  }
  if(st?.file){
    if(cmd==="返回"||cmd==="back")return{screen:localHome(),state:{tab:"local"}};
    const b=getBook(st.file);if(!b)return{screen:localHome(),state:{tab:"local"}};
    const n=parseInt(cmd);if(n>=1&&n<=b.chs.length)return _openCh(st.file,n-1);
    return{screen:_toc(st.file),state:{tab:"local",file:st.file}};
  }
  if(cmd.startsWith("打开 ")){const name=cmd.slice(3).trim().toLowerCase();const idx=files.findIndex(f=>{const b=getBook(f);return b&&b.title.toLowerCase().includes(name);});if(idx<0)return{screen:`未找到「${cmd.slice(3).trim()}」`,state:{tab:"local"}};return{screen:_toc(files[idx]),state:{tab:"local",file:files[idx]}};}
  const n=parseInt(cmd);if(n>=1&&n<=files.length)return{screen:_toc(files[n-1]),state:{tab:"local",file:files[n-1]}};
  return{screen:localHome(),state:{tab:"local"}};
}

function _toc(file:string):string{const b=getBook(file);if(!b)return"解析失败";let s=`📖 ${b.title} — ${b.author}\n\n目录 (${b.chs.length} 章):\n`;b.chs.forEach((c,i)=>s+=`  ${i+1}. ${c.title}\n`);s+="\n输入章节号开始阅读";return s;}
function _openCh(file:string,ci:number,tab:Tab="local"){const b=getBook(file);if(!b)return{screen:"解析失败",state:{tab}};const c=b.chs[ci];const lines=c.content.split("\n");return{screen:`📖 ${b.title} · ${c.title}  1/${Math.ceil(lines.length/PAGE)}\n${fmtBar(PAGE,lines.length)}\n\n${lines.slice(0,PAGE).join("\n")}\n\n「上一页」「下一页」「目录」「返回」`,state:{tab,file,ci,pos:0}};}

// ── 共享书架阅读 ──
function sharedAction(cmd: string, st: any): { screen: string; state: any } {
  const files=scanSharedEpubs();
  const baseDir=sharedBooksDir();
  function sGetBook(f:string):Book|null{
    if(_cache.has(f))return _cache.get(f)!;
    const b=parseEpub(join(baseDir,f));if(b)_cache.set(f,b);return b;
  }
  function sToc(f:string):string{const b=sGetBook(f);if(!b)return"解析失败";let s=`📖 ${b.title} — ${b.author}\n\n目录 (${b.chs.length} 章):\n`;b.chs.forEach((c,i)=>s+=`  ${i+1}. ${c.title}\n`);s+="\n输入章节号开始阅读";return s;}
  function sOpenCh(f:string,ci:number){const b=sGetBook(f);if(!b)return{screen:"解析失败",state:{tab:"shared"}};const c=b.chs[ci];const lines=c.content.split("\n");return{screen:`📖 ${b.title} · ${c.title}  1/${Math.ceil(lines.length/PAGE)}\n${fmtBar(PAGE,lines.length)}\n\n${lines.slice(0,PAGE).join("\n")}\n\n「上一页」「下一页」「目录」「返回」`,state:{tab:"shared",file:f,ci,pos:0}};}
  if(st?.file&&st?.ci!=null){
    if(cmd==="返回"||cmd==="back") return{screen:sharedHome(),state:{tab:"shared"}};
    const b=sGetBook(st.file);if(!b)return{screen:sharedHome(),state:{tab:"shared"}};
    const ch=b.chs[st.ci];const lines=ch.content.split("\n");const pos=st.pos||0;const totalPages=Math.ceil(lines.length/PAGE)||1;const curPage=Math.floor(pos/PAGE)+1;
    if(cmd==="下一页"||cmd==="next"){const np=Math.min(pos+PAGE,Math.max(0,lines.length-PAGE));const isEnd=np+PAGE>=lines.length;const npg=isEnd?totalPages:Math.floor(np/PAGE)+1;const tail=isEnd?`\n\n📌 本章完 (${npg}/${totalPages})「目录」「下一章」`:`\n\n「上一页」「下一页」「目录」「返回」`;return{screen:`📖 ${b.title} · ${ch.title}  ${npg}/${totalPages}\n${fmtBar(np+PAGE,lines.length)}\n\n${lines.slice(np,np+PAGE).join("\n")}${tail}`,state:{...st,pos:np}};}
    if(cmd==="上一页"||cmd==="prev"){const np=Math.max(0,pos-PAGE);const npg=Math.floor(np/PAGE)+1;return{screen:`📖 ${b.title} · ${ch.title}  ${npg}/${totalPages}\n${fmtBar(np+PAGE,lines.length)}\n\n${lines.slice(np,np+PAGE).join("\n")}\n\n「上一页」「下一页」「目录」「返回」`,state:{...st,pos:np}};}
    if(cmd==="下一章"||cmd==="nextch"){const nextCi=st.ci+1;if(nextCi>=b.chs.length)return{screen:`📖 ${b.title}\n\n全书完。`,state:{tab:"shared"}};return sOpenCh(st.file,nextCi);}
    if(cmd==="目录"||cmd==="toc")return{screen:sToc(st.file),state:{...st,ci:undefined,pos:undefined}};
    if(cmd==="@"){const ci=st.ci+1;const pg=curPage;return{screen:`📖 ${b.title}\n\n📍 第${ci}章 · ${ch.title}  Page ${pg}/${totalPages}\n📚 全书 ${ci}/${b.chs.length} 章\n @看进度 不翻页`,state:st};}
    return{screen:`📖 ${b.title} · ${ch.title}\n${fmtBar(pos+PAGE,lines.length)}\n\n${lines.slice(pos,pos+PAGE).join("\n")}\n\n「上一页」「下一页」「目录」「返回」`,state:st};
  }
  if(st?.file){
    if(cmd==="返回"||cmd==="back")return{screen:sharedHome(),state:{tab:"shared"}};
    const b=sGetBook(st.file);if(!b)return{screen:sharedHome(),state:{tab:"shared"}};
    const n=parseInt(cmd);if(n>=1&&n<=b.chs.length)return sOpenCh(st.file,n-1);
    return{screen:sToc(st.file),state:{tab:"shared",file:st.file}};
  }
  if(cmd.startsWith("打开 ")){const name=cmd.slice(3).trim().toLowerCase();const idx=files.findIndex(f=>{const b=sGetBook(f);return b&&b.title.toLowerCase().includes(name);});if(idx<0)return{screen:`未找到「${cmd.slice(3).trim()}」`,state:{tab:"shared"}};return{screen:sToc(files[idx]),state:{tab:"shared",file:files[idx]}};}
  const n=parseInt(cmd);if(n>=1&&n<=files.length)return{screen:sToc(files[n-1]),state:{tab:"shared",file:files[n-1]}};
  return{screen:sharedHome(),state:{tab:"shared"}};
}

// ── MobileApp ─────────────────────────────────────────────────
export const app: MobileApp = {
  name:"wechatread",icon:"📚",messageDescription:"微信读书 — 在线书架 + 本地 EPUB",
  onOpen(_state: any, personDir: string) {
    _pd=personDir||"";
    const tab: Tab = _state?.tab || "weread";
    return { screen: `📚 微信读书\n${tabBar(tab)}\n\n加载中...\n\n命令: 搜索 xxx | 详情 书名 | 目录 书名\n切换标签输入「微信读书」或「本地书架」`, state: { tab } };
  },
  async onAction(input, state, personDir) {
    _pd=personDir||"";const cmd=input.trim();const st=state as any;
    const tab: Tab = st?.tab || "weread";

    if(cmd==="微信读书"||cmd==="weread"){const s=await wereadHome();return{screen:`📚 微信读书\n${tabBar("weread")}\n\n${s}`,state:{tab:"weread"}};}
    if(cmd==="本地书架"||cmd==="local"){return{screen:`📚 微信读书\n${tabBar("local")}\n\n${localHome()}`,state:{tab:"local"}};}
    if(cmd==="共享书架"||cmd==="shared"){return{screen:`📚 微信读书\n${tabBar("shared")}\n\n${sharedHome()}`,state:{tab:"shared"}};}
    if(cmd==="返回"&&!st?.file)return app.onOpen({},personDir);

    if(tab==="shared"){
      const r=sharedAction(cmd,st);
      return{screen:`📚 微信读书\n${tabBar("shared")}\n\n${r.screen}`,state:{...r.state,tab:"shared"}};
    }

    if(tab==="weread"){
      if(/^安娜下\s+(\d+)$/.test(cmd) || /^annad\s+(\d+)$/.test(cmd)){
        const n = parseInt(cmd.match(/\d+/)![0]);
        const s = await annaDownloadCmd(n);
        return{screen:`📚 微信读书\n${tabBar("weread")}\n\n${s}`,state:{tab:"weread"}};
      }
      const s = await wereadAction(cmd);
      return{screen:`📚 微信读书\n${tabBar("weread")}\n\n${s}`,state:{tab:"weread"}};
    }
    if(tab==="local"){
      const r=localAction(cmd,st);
      return{screen:`📚 微信读书\n${tabBar("local")}\n\n${r.screen}`,state:{...r.state,tab:"local"}};
    }
    // fallback: 未知 tab
    return app.onOpen({},personDir);
  },
};
