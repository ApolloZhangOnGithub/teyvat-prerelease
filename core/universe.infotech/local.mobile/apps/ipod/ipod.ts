// ipod.ts — Self-contained player. Background polling for realtime injection.
import * as fs from "node:fs"; import * as path from "node:path"; import { execSync } from "child_process"; import { fileURLToPath } from "node:url";
import type { MobileApp } from "../../system.kernel/kernel.ts";
import { pushNotification } from "../../system.kernel/kernel.ts";
import { logerr } from "#paths";
let _timer:any=null;let _pd="";let _lp=0;let _paused=false;
function poll(){if(_paused)return;try{const out=_pd.replace("/MemoryData/","/RuntimeCache/")+"/ear_output.jsonl";if(!fs.existsSync(out)){return}const c=fs.readFileSync(out,"utf8");if(c.length<=_lp)return;const np=c.slice(_lp);_lp=c.length;for(const l of np.trim().split("\n").filter(Boolean)){try{const e=JSON.parse(l);if(e.text)pushNotification(e.text)}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }}}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }}
function startPoll(d:string){_pd=d;_lp=0;if(_timer)clearInterval(_timer);_timer=setInterval(poll,2000)}
function stopPoll(){if(_timer){clearInterval(_timer);_timer=null}const out=_pd?(_pd.replace("/MemoryData/","/RuntimeCache/")+"/ear_output.jsonl"):"";_pd="";_lp=0;if(out)try{if(fs.existsSync(out))fs.unlinkSync(out)}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }}
// 相对自身解析——部署副本不会回头执行 DEV 仓库代码
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../../spirit.bio.organs/head.ears/ears-recorder.ts");
const BUN=(()=>{try{return execSync("which bun",{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim()}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }const h=process.env.HOME;if(h){const p=`${h}/.bun/bin/bun`;try{execSync(`test -x "${p}"`,{stdio:"ignore"});return p}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }}return"bun"})();
interface P{file:string;bk:string;sp:number;ck:number;pos:number;fp:number;dur:number;lines:string[];out:string;}
function ld(d:string):P{try{return JSON.parse(fs.readFileSync(path.join(d,"ipod.json"),"utf8"))}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e));return{file:"",bk:"doubao",sp:1,ck:1600,pos:0,fp:0,dur:0,lines:[],out:"ready"}}}
function sv(d:string,s:P){fs.writeFileSync(path.join(d,"ipod.json"),JSON.stringify(s))}
function bar(p:number,d:number,w=26):string{if(d<=0)return"▬".repeat(w);const f=Math.round(Math.min(1,Math.max(0,p/d))*w);return"█".repeat(f)+"▬".repeat(w-f)}
function bars(ap:number,fp:number,d:number,w=26):string{const a=bar(ap,d,w);const f=bar(fp,d,w);let s="";for(let i=0;i<w;i++)s+=fp>=ap&&i>=Math.round(ap/d*w)&&i<Math.round(fp/d*w)?"▓":a[i];return s}
function fm(s:number):string{const m=Math.floor(s/60),sec=Math.floor(s%60);return`${m}:${String(sec).padStart(2,"0")}`}
function render(s:P):string{const L:string[]=[];const ac=s.out.startsWith("");const pa=s.out==="paused"||s.out.includes("paused");const ic=ac?"":pa?"⏸":"■";
L.push("┌─ 🎵 iPod ──────────────────────────────┐");
if(s.file){L.push(`│ ${ic} ${path.basename(s.file)}  ${s.bk}`);if(s.dur>0)L.push(`│ ${bars(s.pos,s.fp,s.dur)} ${fm(s.pos)}/${fm(s.dur)}`);L.push(`│ speed:${s.sp}x  chunk:${s.ck}(${(s.ck/16000*1000).toFixed(0)}ms)`)}
if(s.lines.length)for(const l of s.lines.slice(-2))L.push(`│ ${l.slice(0,44)}`);
L.push("├──────────────────────────────────────────┤");
L.push(ac?"│ [pause] [speed N] [chunk N] [seek +N]":"│ [play] [speed N] [chunk N] [seek +N]");
L.push("├──────────────────────────────────────────┤");
L.push(`│ ${s.out}`);L.push("└──────────────────────────────────────────┘");return L.join("\n")}
// 2026-08-20：ear_control.json 迁移到 ~/.teyvat/RuntimeCache（与 ears/ears-recorder 一致，不写 /tmp——用户定稿）
const EAR_CTL = (process.env.HOME || "") + "/.teyvat/RuntimeCache/ear_control.json";
function start(s:P,d:string):P{if(!s.file)return s;
try{fs.writeFileSync(EAR_CTL,"{}")}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }  // clear stale control file
try{execSync("kill $(pgrep -f ears-recorder) 2>/dev/null || true",{timeout:3,stdio:"ignore"})}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }
startPoll(d);
try{const out=d.replace("/MemoryData/","/RuntimeCache/")+"/ear_output.jsonl";try{fs.writeFileSync(out,"")}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }
execSync(`${BUN} "${R}" --mode file "${s.file}" "${out}" --backend ${s.bk} --lang en --speed ${s.sp} --chunk ${s.ck||1600} </dev/null >/dev/null 2>&1 &`,{timeout:15,stdio:"ignore"});
s.out=` ${path.basename(s.file)}`;try{const r=execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${s.file}"`,{timeout:5,encoding:"utf8"});s.dur=parseFloat(r)||0}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }}
catch(e:any){s.out=`err: ${e.message}`}return s}
function halt(s:P):P{stopPoll();try{fs.writeFileSync(EAR_CTL,JSON.stringify({state:"stop"}))}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }s.out="halted";return s}
function ctrl(s:P,act:string,val?:number):P{try{fs.writeFileSync(EAR_CTL,JSON.stringify({state:act,...(val!==undefined?{seconds:val}:{})}))}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }return s}
function rd(s:P,d:string):P{try{const out=d.replace("/MemoryData/","/RuntimeCache/")+"/ear_output.jsonl";if(!fs.existsSync(out))return s;
const ls=fs.readFileSync(out,"utf8").trim().split("\n").filter(Boolean);
s.lines=ls.slice(-4).map(l=>{try{const e=JSON.parse(l);s.pos=e.position||e.start||s.pos;s.fp=e.feed||e.position||s.fp;return e.text}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e));return""}}).filter(Boolean)}catch (e) { console.error("[universe.infotech/local.mobile/apps/ipod/ipod.ts] " + ((e as any)?.message || e)); }return s}
export const app:MobileApp={name:"ipod",icon:"🎵",messageDescription:"播放器",
onOpen(state,d){const s=ld(d);return{screen:render(s),state:{...s}}},
async onAction(input,state,d){let s={...state}as P;const t=input.trim().toLowerCase();
if(t==="pause"){ctrl(s,"pause");stopPoll();_paused=true;s.out="paused"}
else if(t==="play"){if(s.out.startsWith("")){ctrl(s,"pause");stopPoll();_paused=true;s.out="paused"}else if(s.out==="paused"){ctrl(s,"play");startPoll(d);_paused=false;s.out=` ${path.basename(s.file)}`}else{_paused=false;s=start(s,d)}}
else if(t.startsWith("speed ")){const v=Math.max(.1,Math.min(10,parseFloat(input.slice(6))||1));s.sp=v;ctrl(s,"resume");fs.writeFileSync(EAR_CTL,JSON.stringify({speed:v}));s.out=`${v}x`}
else if(t.startsWith("chunk ")){const v=Math.max(160,Math.min(160000,parseInt(input.slice(6))||1600));s.ck=v;fs.writeFileSync(EAR_CTL,JSON.stringify({chunk:v}));s.out=`chunk ${v}`}
else if(t.startsWith("seek ")){const sec=parseFloat(input.slice(5))||0;s.pos=Math.max(0,s.pos+sec);ctrl(s,"seek",s.pos);s.out=`seek ${s.pos}s`}
else if(t==="stop")s=halt(s);else s.out=input;
s=rd(s,d);sv(d,s);return{screen:render(s),state:s}}};
