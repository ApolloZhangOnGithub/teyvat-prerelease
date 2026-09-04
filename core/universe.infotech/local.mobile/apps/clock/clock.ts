// apps/clock/clock.ts — Clock tool (纯 pi 实现)
// 闹钟 / 秒表 / 计时器

import * as fs from "fs";
import * as path from "path";

interface Alarm { id: number; label: string; time: string; enabled: boolean; repeat: string; created: string; }
interface State { sw_status: "reset"|"running"|"stopped"; sw_accumulated: number; sw_started_at: number; sw_laps: {number:number;split:number;total:number}[]; timer_status: "idle"|"running"; timer_label: string; timer_total_secs: number; timer_started_at: number; }

function loadJson(p: string): any[] { try { return JSON.parse(fs.readFileSync(p,"utf8")); } catch { return []; } }
function saveJson(p: string, d: any[]) { fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,JSON.stringify(d,null,2)); }
function fmt(secs: number): string { const h=Math.floor(secs/3600),m=Math.floor((secs%3600)/60),s=Math.floor(secs%60); return h>0?`${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`:`${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`; }

let state: State = { sw_status:"reset",sw_accumulated:0,sw_started_at:0,sw_laps:[], timer_status:"idle",timer_label:"",timer_total_secs:0,timer_started_at:0 };
let _stateFile = "";
function loadClockState(personDir: string) {
  _stateFile = path.join(personDir, "clock_state.json");
  try { Object.assign(state, JSON.parse(fs.readFileSync(_stateFile, "utf8"))); } catch (e) { console.error("[universe.infotech/local.mobile/apps/clock/clock.ts] " + ((e as any)?.message || e)); }
}
function saveClockState() {
  if (_stateFile) try { fs.writeFileSync(_stateFile, JSON.stringify(state)); } catch (e) { console.error("[universe.infotech/local.mobile/apps/clock/clock.ts] " + ((e as any)?.message || e)); }
}

function swElapsed(): number { let acc=state.sw_accumulated; if(state.sw_status==="running"&&state.sw_started_at) acc+=(Date.now()-state.sw_started_at)/1000; return acc; }

export async function clockCmd(args: any, _ctx: any, personDir: string): Promise<{ content: any[]; details: any }> {
  if (!_stateFile) loadClockState(personDir);
  const a=args.action||"", p=args, af=path.join(personDir,"clock_alarms.json");

  if (a==="alarm_create") {
    const alarms=loadJson(af);
    const id=alarms.length>0?Math.max(...alarms.map((x:any)=>x.id))+1:1;
    alarms.push({id,label:p.label||"闹钟",time:p.time||"08:00",enabled:true,repeat:p.repeat||"once",created:new Date().toISOString()});
    saveJson(af,alarms);
    return {content:[{type:"text",text:`已创建:「${p.label||"闹钟"}」${p.time||"08:00"}`}],details:{}};
  }
  if (a==="alarm_delete") {
    let alarms=loadJson(af); const id=parseInt(p.id); const t=alarms.find((x:any)=>x.id===id);
    alarms=alarms.filter((x:any)=>x.id!==id); saveJson(af,alarms);
    return {content:[{type:"text",text:t?`已删除「${t.label}」`:"未找到"}],details:{}};
  }
  if (a==="alarm_delete_all") { saveJson(af,[]); return {content:[{type:"text",text:"已删除全部闹钟"}],details:{}}; }
  if (a==="alarm_toggle") {
    const alarms=loadJson(af); const id=parseInt(p.id); const t=alarms.find((x:any)=>x.id===id);
    if(!t) return {content:[{type:"text",text:"未找到"}],details:{}};
    t.enabled=!t.enabled; saveJson(af,alarms);
    return {content:[{type:"text",text:`「${t.label}」已${t.enabled?"开启":"关闭"}`}],details:{}};
  }
  if (a==="alarm_list") {
    const alarms=loadJson(af);
    if(alarms.length===0) return {content:[{type:"text",text:"暂无闹钟"}],details:{}};
    const lines=["闹钟列表:"]; for(const x of alarms) lines.push(`  [${x.id}] ${x.enabled?"ON":"OFF"} ${x.label} — ${x.time}`);
    return {content:[{type:"text",text:lines.join("\n")}],details:{alarms}};
  }

  if (a==="stopwatch_start") { state={...state,sw_status:"running",sw_accumulated:0,sw_started_at:Date.now(),sw_laps:[]}; saveClockState(); return {content:[{type:"text",text:"秒表已启动"}],details:{}}; }
  if (a==="stopwatch_pause") { if(state.sw_status!=="running") return {content:[{type:"text",text:"秒表未在运行"}],details:{}}; state.sw_accumulated=swElapsed(); state.sw_status="stopped"; state.sw_started_at=0; saveClockState(); return {content:[{type:"text",text:`暂停 (${fmt(state.sw_accumulated)})`}],details:{}}; }
  if (a==="stopwatch_resume") { if(state.sw_status!=="stopped") return {content:[{type:"text",text:"秒表未暂停"}],details:{}}; state.sw_status="running"; state.sw_started_at=Date.now(); saveClockState(); return {content:[{type:"text",text:"已继续"}],details:{}}; }
  if (a==="stopwatch_reset") { state={...state,sw_status:"reset",sw_accumulated:0,sw_started_at:0,sw_laps:[]}; saveClockState(); return {content:[{type:"text",text:"已重置"}],details:{}}; }
  if (a==="stopwatch_lap") { if(state.sw_status!=="running") return {content:[{type:"text",text:"秒表未在运行"}],details:{}}; const e=swElapsed(),lt=state.sw_laps.length>0?state.sw_laps[state.sw_laps.length-1].total:0; state.sw_laps.push({number:state.sw_laps.length+1,split:Math.round((e-lt)*10)/10,total:Math.round(e*10)/10}); saveClockState(); return {content:[{type:"text",text:`计次#${state.sw_laps.length}`}],details:{laps:state.sw_laps}}; }
  if (a==="stopwatch_query") { const e=swElapsed(),lb:Record<string,string>={running:"运行中",stopped:"已暂停",reset:"未启动"}; return {content:[{type:"text",text:`秒表 ${lb[state.sw_status]} ${fmt(e)}${state.sw_laps.length>0?` (${state.sw_laps.length}次计次)`:""}`}],details:{status:state.sw_status,elapsed:Math.round(e*10)/10,laps:state.sw_laps}}; }

  if (a==="timer_start") { const m=parseFloat(p.minutes)||0; if(!m||m<=0) return {content:[{type:"text",text:"请指定大于 0 的分钟数"}],details:{}}; state.timer_status="running"; state.timer_label=p.label||`${m}分钟`; state.timer_total_secs=m*60; state.timer_started_at=Date.now(); saveClockState(); return {content:[{type:"text",text:`已启动: ${state.timer_label}`}],details:{}}; }
  if (a==="timer_cancel") { state.timer_status="idle"; state.timer_started_at=0; saveClockState(); return {content:[{type:"text",text:"已取消"}],details:{}}; }
  if (a==="timer_query") { if(state.timer_status!=="running") return {content:[{type:"text",text:"计时器未运行"}],details:{}}; const r=Math.max(0,state.timer_total_secs-(Date.now()-state.timer_started_at)/1000); return {content:[{type:"text",text:`「${state.timer_label}」剩余 ${fmt(r)}`}],details:{remaining:Math.round(r*10)/10}}; }

  return {content:[{type:"text",text:`未知操作: ${a}`}],details:{}};
}

// ── MobileApp wrapper ──────────────────────────────────────────
import type { MobileApp } from "../../system.kernel/kernel.ts";
import { logerr } from "#paths";

export const app: MobileApp = {
  name: "clock",
  icon: "时钟",
  messageDescription: "闹钟、秒表、计时器",

  onOpen(state, personDir) {
    const lines = [
      "═══ 时钟 ═══",
      "",
      "  闹钟:",
      "    闹钟列表         — 查看所有闹钟",
      "    创建闹钟 HH:MM [标签] — 创建闹钟",
      "    删除闹钟 <id>    — 删除闹钟",
      "    开关闹钟 <id>    — 开启/关闭闹钟",
      "",
      "  秒表:",
      "    开始秒表    暂停秒表    继续秒表",
      "    重置秒表    计次        秒表状态",
      "",
      "  计时器:",
      "    计时 <分钟> [标签]  — 开始倒计时",
      "    取消计时           — 取消计时器",
      "    计时状态           — 查看剩余",
      "",
      "  返回 — 回主屏幕",
    ];
    return { screen: lines.join("\n"), state: state ?? {} };
  },

  async onAction(input, state, personDir) {
    const trimmed = input.trim();
    let args: any = {};

    if (/^闹钟列表$/i.test(trimmed)) {
      args = { action: "alarm_list" };
    } else if (/^(创建闹钟|新建闹钟)\s+(\d{1,2}:\d{2})\s*(.*)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:创建闹钟|新建闹钟)\s+(\d{1,2}:\d{2})\s*(.*)$/i)!;
      args = { action: "alarm_create", time: m[1], label: m[2] || "闹钟" };
    } else if (/^删除闹钟\s+(\d+)$/.test(trimmed)) {
      args = { action: "alarm_delete", id: trimmed.match(/(\d+)$/)![1] };
    } else if (/^(删除全部闹钟|清空闹钟)$/.test(trimmed)) {
      args = { action: "alarm_delete_all" };
    } else if (/^(开关闹钟|切换闹钟)\s+(\d+)$/.test(trimmed)) {
      args = { action: "alarm_toggle", id: trimmed.match(/(\d+)$/)![1] };
    } else if (/^开始秒表$/.test(trimmed)) {
      args = { action: "stopwatch_start" };
    } else if (/^暂停秒表$/.test(trimmed)) {
      args = { action: "stopwatch_pause" };
    } else if (/^继续秒表$/.test(trimmed)) {
      args = { action: "stopwatch_resume" };
    } else if (/^重置秒表$/.test(trimmed)) {
      args = { action: "stopwatch_reset" };
    } else if (/^计次$/.test(trimmed)) {
      args = { action: "stopwatch_lap" };
    } else if (/^秒表(状态)?$/.test(trimmed)) {
      args = { action: "stopwatch_query" };
    } else if (/^计时\s+(\d+(?:\.\d+)?)\s*(.*)$/.test(trimmed)) {
      const m = trimmed.match(/^计时\s+(\d+(?:\.\d+)?)\s*(.*)$/)!;
      args = { action: "timer_start", minutes: m[1], label: m[2] || undefined };
    } else if (/^取消计时$/.test(trimmed)) {
      args = { action: "timer_cancel" };
    } else if (/^计时状态$/.test(trimmed)) {
      args = { action: "timer_query" };
    }

    const result = await clockCmd(args, {}, personDir);
    return { screen: result.content[0].text, state: state ?? {} };
  },
};
