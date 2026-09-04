// cli.ts — Teyvat 统一入口
// 用法: genshin [flags] [name]

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { SYNC_ENDPOINT_DEFAULT } from '../paths.ts';

const H = os.homedir();
const PAIMON = path.join(H, '.teyvat');
const PLIST = path.join(PAIMON, 'MemoryData', 'plist.json');
const RUNTIME = path.join(H, '.local/lib/teyvat/runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const EXT = path.join(H, '.local/lib/teyvat/extensions/teyvat');
const LANG = process.env.PAIMON_LANG || (process.env.LANG?.includes('zh_CN') ? 'zh' : 'en');
const ZH = LANG === 'zh';
const _uaSettings = path.join(PAIMON, 'UserAccount', 'settings.json');
const PAIMON_SETTINGS = fs.existsSync(_uaSettings) ? _uaSettings : path.join(PAIMON, 'config', 'settings.json');

// ── pad utils ──
function vw(s: string): number { let w=0; for(const c of [...String(s)]){ const cp=c.codePointAt(0); w+=(cp&&cp>0x2E7F)?2:1 } return w }
function pad(s: string, n: number): string { return String(s)+' '.repeat(Math.max(0,n-vw(String(s)))) }
function lpad(s: string, n: number): string { return ' '.repeat(Math.max(0,n-vw(String(s))))+String(s) }
function computeAndSort(list: any[], psOut: string, now: number) {
  for(const p of list){ p._active=psOut.split('\n').some((l: string)=>l.includes('genshin:')&&l.includes('(main,')&&l.includes(p.id)); p._ago=Math.round((now-new Date(p.lastEnded||p.lastSeen).getTime())/60000) }
  list.sort((a: any,b: any)=>(b._active?1:0)-(a._active?1:0)||a._ago-b._ago)
}

// ── helpers ──
const Y='\x1b[33m', G='\x1b[32m', D='\x1b[90m', M='\x1b[35m', R='\x1b[0m', BOLD='\x1b[1m';

// ── Codeforces 风格履历段位（共享自 cf-rank.cjs）──
// ⚠️ 注意：genshin 默认列表走 list.cjs（node），本文件的列表分支仅 `bun cli.ts` 直接调用时使用！
// 改 genshin 列表渲染请改 list.cjs，不要改这里（别的 agent 踩过多次）。
import { getCfRank, cfPaint } from "./cf-rank.cjs";
function loadPlist(): any[] { try { return JSON.parse(fs.readFileSync(PLIST,'utf8')) } catch { return [] } }
function savePlist(l: any[]) { fs.mkdirSync(path.dirname(PLIST),{recursive:true}); fs.writeFileSync(PLIST,JSON.stringify(l,null,2)) }
const SUBCOMMANDS: Record<string,string> = {
  'archive':'archive', 'a':'archive',
  'unarchive':'unarchive', 'ua':'unarchive',
  'archived':'archived', 'A':'archived',
  'kill':'kill', 'k':'kill',
  'tmux':'tmux', 't':'tmux',
  'mc':'mc', 'hc':'hc',
  'god':'god', 'g':'god',
  'mobile':'mobile', 'm':'mobile',
  'settings':'settings', 's':'settings',
  'org':'org', 'o':'org',
  'help':'help', 'h':'help',
  'login':'login', 'logout':'logout', 'unbind':'unbind',
  'whoami':'whoami',
  'sync':'sync',
  'update':'update', 'uninstall':'uninstall',
  'sessions':'sessions', 'web':'web',
  'version':'version', 'v':'version',
  'rename':'rename',
  'clone':'clone', 'c':'clone',
  'doctor':'doctor',
  'note':'note', 'n':'note',
};
const RESERVED_NAMES = new Set([
  ...Object.keys(SUBCOMMANDS),
  'update','upgrade','config','list','ls','status',
  'install','uninstall','doctor','reset',
]);

function confirm(prompt: string): boolean {
  if(!process.stdin.isTTY) return true;
  process.stdout.write(prompt+' (Y/n) ');
  const buf=Buffer.alloc(8);
  // position 必须传 null：对 TTY/管道传数值会触发 lseek 抛错（Bun/Node），
  // 且只截取实际读到的字节——未读部分是 NUL，trim 不会清除，会导致永远判非 y/空
  let n=0;
  try { n = fs.readSync(0, buf, 0, 8, null) } catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
  const s = buf.subarray(0, n).toString().trim().toLowerCase();
  return s==='y'||s==='';
}
function psAux(): string { try { return execSync('ps aux',{encoding:'utf8',timeout:3000}) } catch { return '' } }
function shortKind(k: string): string { return k==='coding-agent'?'coding':k }
function dirSize(dir: string): number { let t=0; try{ const w=(d:string)=>{ for(const e of fs.readdirSync(d,{withFileTypes:true})){ const fp=path.join(d,e.name); if(e.isDirectory()) w(fp); else try{ t+=fs.statSync(fp).size }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); } } }; w(dir) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); } return t }

// ── DEEPSEEK KEY ──
try {
  const ua = path.join(PAIMON, 'UserAccount', 'services.json');
  const legacy = path.join(PAIMON, 'config', 'services.json');
  const sf = fs.existsSync(ua) ? ua : legacy;
  const svc = JSON.parse(fs.readFileSync(sf,'utf8'));
  const k = svc?.deepseek?.apiKey;
  if(typeof k==='string' && k.trim()) process.env.DEEPSEEK_API_KEY = k.trim();
} catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }

// ═══════════════════════════════════════════════════════════════════
// LIST — [DISABLED 2026-08-15] 生产环境走 launcher.sh → list.cjs，此函数从未在生产中显示。
// 列表渲染的唯一真相源是 list.cjs，此处保留仅作回退参考。
// ═══════════════════════════════════════════════════════════════════
function cmdList(filter='list') {
  const all = loadPlist();
  const list = filter==='archived' ? all.filter((p:any)=>p.archived) : all.filter((p:any)=>!p.archived);
  if(!list.length) { console.log(ZH?'  (空)':'  (empty)'); process.exit(0) }

  let devMode=false;
  try{ const s=JSON.parse(fs.readFileSync(PAIMON_SETTINGS,'utf8')); devMode=!!s.developerMode }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
  try{ const v=JSON.parse(fs.readFileSync(path.join(PAIMON,'version.json'),'utf8')); if(v.genshin?.includes('-dev.')) devMode=true }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }

  const now=Date.now(), ps=psAux();
  computeAndSort(list,ps,now);

  for(const p of list){
    const md=path.join(PAIMON,'MemoryData',p.id);
    p._memSize=dirSize(md); p._memoir=fs.existsSync(path.join(PAIMON,'MemoirData',p.id+'.MEMOIR'));
    let sz=p._memSize;
    for(const sub of ['SessionData','AgentFileData','RuntimeCache','IdentityData'])
      try{ sz+=dirSize(path.join(PAIMON,sub,p.id)) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
    p._size=sz;
    // RSI-001: 辈分 + 社会资历
    p._age='';
    try{
      const bp=path.join(md,'birth.json');
      let bts=0;
      if(fs.existsSync(bp)){ bts=JSON.parse(fs.readFileSync(bp,'utf8')).birth_ts||0 }
      else{ try{ bts=fs.statSync(md).birthtimeMs||0 }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); } if(bts){ try{fs.writeFileSync(bp,JSON.stringify({birth_ts:bts,created:new Date(bts).toISOString(),source:'dir_birthtime'}))}catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); } } }
      if(bts){
        const ms=now-bts, h=ms/3600000, d=ms/86400000;
        if(h<1) p._age=Math.floor(ms/60000)+'m';
        else if(d<1) p._age=h.toFixed(1)+'h';
        else if(d<7) p._age=d.toFixed(1)+'d';
        else if(d<30) p._age=(d/7).toFixed(1)+'w';
        else if(d<365) p._age=(d/30.44).toFixed(1)+'mo';
        else p._age=(d/365.25).toFixed(1)+'y';
      }
    }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
    p._tokenmaxxed=''; p._tokenmaxxedHex='';
    try{
      const pp=path.join(md,'tokenmaxxed.json');
      let pt=0;
      if(fs.existsSync(pp)){ pt=JSON.parse(fs.readFileSync(pp,'utf8')).tokenmaxxed||0 }
      if(!pt){ const ap=path.join(md,'context.archive.jsonl'); if(fs.existsSync(ap)){ try{ const est=(t:string)=>{let cjk=0;for(let i=0;i<t.length;i++){const c=t.charCodeAt(i);if((c>=0x3400&&c<=0x9fff)||(c>=0xf900&&c<=0xfaff)||(c>=0x3000&&c<=0x30ff)||(c>=0xff00&&c<=0xffef))cjk++}return Math.round(cjk*1.8+(t.length-cjk)*0.25)}; pt=est(fs.readFileSync(ap,'utf8')) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); } } }
      if(pt>0){ const rk=getCfRank(pt); p._tokenmaxxed=(pt<1000?pt+'':pt<1e6?(pt/1000).toFixed(1)+'k':(pt/1e6).toFixed(1)+'M'); /* 2026-08-15 用户：cli 履历栏不写称号，染色即可——暂时注释 p._tokenmaxxed=rk.name+' '+p._tokenmaxxed; */ p._tokenmaxxedHex=rk.hex; }
    }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
  }

  let devVer='';
  try{ const v=JSON.parse(fs.readFileSync(path.join(PAIMON,'version.json'),'utf8')); devVer=D+'  v'+v.genshin+' ('+v.channel+')'+R }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }

  let orgMap: Record<string,string> = {};
  try { const orgs=JSON.parse(fs.readFileSync(path.join(PAIMON,'AgentWorkDir','Organizational','orgs.json'),'utf8')); for(const o of orgs) orgMap[o.id]=o.name; } catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
  for(const p of list) { const ids=Array.isArray(p.orgs)?p.orgs:(p.org?[p.org]:[]); p._orgName=ids.length>0?ids.map((id:string)=>orgMap[id]||id).join(', '):'/' }

  // 拆分 test_session 和主 agent
  const mainList = list.filter((p:any) => p._orgName !== 'test_sessions');
  const testList = list.filter((p:any) => p._orgName === 'test_sessions');
  const title='  '+BOLD+'Teyvat'+R+D+' · '+mainList.length+' Agent'+(mainList.length===1?'':'s')+(testList.length>0?D+' + '+testList.length+' test'+R:'')+R+devVer;
  console.log('\n'+title+'\n');

  const nw=Math.max(6,...list.map((p:any)=>vw(p.name)));
  const kw=Math.max(6,...list.map((p:any)=>vw(shortKind(p.kind||'coding-agent'))));
  const orgW=Math.max(vw(ZH?'组织':'ORG'),...list.map((p:any)=>vw(p._orgName)));
  const idW=8, numW=String(list.length).length, hdr=' '.repeat(numW+3);
  const showStatus=filter!=='archived';

  const stStrs=list.map((p:any)=>{
    let tag='',time='';
    if(p._active){
      const rc=path.join(PAIMON,'RuntimeCache',p.id);
      try{
        if(fs.existsSync(path.join(PAIMON,'MemoryData',p.id,'paused'))||fs.existsSync(path.join(rc,'paused'))) tag='[P]';
        else if(fs.existsSync(path.join(rc,'main-resting'))) tag='[W]';
        else if(fs.existsSync(path.join(rc,'main-hibernate'))) tag='[H]';
        else tag='[A]';
      }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
      const secs=Math.round((now-new Date(p.lastSeen).getTime())/1000);
      if(secs<5) time='刚刚'; else if(secs<60) time=secs+'秒';
      else{ const m=Math.floor(secs/60); if(m<60) time=m+'分钟'; else{ const h=Math.floor(m/60); if(h<24) time=h+'小时'; else time=Math.floor(h/24)+'天' } }
    }else{
      const et=p.lastEnded||p.lastSeen;
      if(!et) time=ZH?'从未启动':'never';
      else{ const s=Math.round((now-new Date(et).getTime())/1000);
        if(s<5) time='刚刚'; else if(s<60) time=s+'秒前'; else{ const m=Math.floor(s/60); if(m<60) time=m+'分钟前'; else{ const h=Math.floor(m/60); if(h<1440) time=h+'小时前'; else time=Math.floor(h/24)+'天前' } }
      }
    }
    return {tag,time};
  });
  const tw=Math.max(...stStrs.map((s:any)=>vw(s.time)));

  const aw=Math.max(3,...list.map((p:any)=>vw(p._age||'')));
  const pw=Math.max(4,...list.map((p:any)=>vw(p._tokenmaxxed||'')));
  const r1Hdr=hdr+pad(ZH?'名称':'NAME',nw)+pad(ZH?'类型':'KIND',kw)+' '+pad(ZH?'组织':'ORG',orgW)+'  '+pad('ID',idW)+'  '+pad(ZH?'年龄':'AGE',aw)+'  '+pad(ZH?'履历':'EXP',pw)+'  '+pad(ZH?'回忆录':'MEMOIR',6)+(showStatus?'  '+(ZH?'时间':'TIME'):'');
  const r1DataW=numW+3+nw+kw+1+orgW+2+idW+2+aw+2+pw+2+6+(showStatus?2+tw:0);

  // 渲染一行 agent
  function renderRow(p:any, s:any, num: string) {
    const org=p._orgName, kd=shortKind(p.kind||'coding-agent');
    const tag=showStatus&&s.tag?s.tag+' ':'', stime=pad(s.time,tw);
    const sc=p._active?G:'', sr=p._active?R:'';
    const kc={coding:M}[kd]||D;
    const age=pad(p._age||'',aw), pondRaw=pad(p._tokenmaxxed||'',pw);
    const pond=p._tokenmaxxedHex?cfPaint(p._tokenmaxxedHex,pondRaw):pondRaw;
    const memoir=pad(p._memoir?'\u2713':'\u2717',6);
    const sp=showStatus?'  '+sc+tag+stime+sr:'';
    console.log('  '+num+' '+pad(p.name,nw)+kc+pad(kd,kw)+R+' '+pad(org,orgW)+'  '+p.id+' '.repeat(Math.max(0,idW-vw(p.id)))+'  '+age+'  '+pond+'  '+memoir+sp);
  }

  // 主表
  console.log('  '+r1Hdr);
  console.log('  '+'\u2500'.repeat(r1DataW));
  let on=1, an=1;
  for(let i=0;i<list.length;i++){
    const p=list[i];
    if(p._orgName==='test_sessions') continue; // 跳过后面的 test 表处理
    const s=stStrs[i];
    const num=p._active?G+String(an++).padStart(numW)+'. '+R:Y+String(on++).padStart(numW)+'. '+R;
    renderRow(p, s, num);
    if(process.stdout.isTTY&&(i+1)%10===0&&i+1<list.length){
      process.stdout.write(D+'  -- Enter 继续, q/Esc 退出 --'+R);
      const buf=Buffer.alloc(64); try{ fs.readSync(0,buf,0,64,0) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
      if(buf[0]===0x1b||buf.toString().trim().toLowerCase()==='q') process.exit(0);
      process.stdout.write('\r'+' '.repeat(50)+'\r');
    }
  }

  // test_session 表
  if(testList.length>0){
    const tnumW=Math.max(2,String(testList.length).length+1); // t1..tN
    const testHdr=' '.repeat(tnumW+2)+pad(ZH?'名称':'NAME',nw)+pad(ZH?'类型':'KIND',kw)+' '+pad(ZH?'组织':'ORG',orgW)+'  '+pad('ID',idW)+'  '+pad(ZH?'回忆录':'MEMOIR',6)+(showStatus?'  '+(ZH?'时间':'TIME'):'');
    console.log('');
    console.log('  '+D+'test_sessions'+R);
    console.log('  '+testHdr);
    console.log('  '+'\u2500'.repeat(tnumW+2+nw+kw+1+orgW+2+idW+2+6+(showStatus?2+tw:0)));
    let tn=1;
    for(let i=0;i<list.length;i++){
      const p=list[i];
      if(p._orgName!=='test_sessions') continue;
      const s=stStrs[i];
      const num=D+'t'+String(tn++).padStart(tnumW)+'. '+R;
      renderRow(p, s, num);
    }
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════
// ENTER AGENT
// ═══════════════════════════════════════════════════════════════════
function enterAgent(name: string, mode='') {
  const list=loadPlist();
  let entry: any;

  if(/^\d+$/.test(name)){
    const now=Date.now(), ps=psAux();
    const active=list.filter((p:any)=>!p.archived);
    computeAndSort(active,ps,now);
    const offline=active.filter((p:any)=>!p._active);
    entry=offline[parseInt(name)-1];
  }else{
    entry=list.find((p:any)=>p.name===name);
  }

  let id: string, pname: string, kind: string;
  if(entry){
    id=entry.id; pname=entry.name; kind=entry.kind||'coding-agent';
  }else{
    // Create new
    if(RESERVED_NAMES.has(name.toLowerCase())){ console.error(`  "${name}" is reserved, cannot be used as agent name.`); process.exit(1) }
    if(!/^[a-zA-Z][a-zA-Z0-9_.\-]*$/.test(name)){ console.error(`  invalid name "${name}": must start with a letter, only a-z A-Z 0-9 _ allowed.`); process.exit(1) }
    const exist=list.find((p:any)=>p.name===name);
    if(exist){ console.error(`${name} already exists`); process.exit(1) }
    // 自检：扫描 IdentityData 找同名孤儿 agent（不在 plist 但目录还在），防止 sync 造成的 ID 冲突
    let orphans:{id:string,memSize:number,created:string}[]=[];
    try{
      const idRoot=path.join(PAIMON,'IdentityData');
      for(const d of fs.readdirSync(idRoot,{withFileTypes:true})){
        if(!d.isDirectory()) continue;
        const idFile=path.join(idRoot,d.name,'identity.json');
        try{
          const idData=JSON.parse(fs.readFileSync(idFile,'utf8'));
          if(idData.name===name&&!list.find((p:any)=>p.id===d.name)){
            orphans.push({id:d.name,memSize:dirSize(path.join(PAIMON,'MemoryData',d.name)),created:idData.created||''});
          }
        }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
      }
    }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
    // 有孤儿 → 取数据最多的；多余的强制重命名
    if(orphans.length>0){
      orphans.sort((a,b)=>b.memSize-a.memSize);
      const keep=orphans[0]!;
      const mb=(keep.memSize/1048576).toFixed(2);
      console.log(`  ${Y}△${R} 发现 ${orphans.length} 个同名孤儿，恢复数据最多的 ${keep.id} (${mb}MB)`);
      // 多余的重命名
      for(let i=1;i<orphans.length;i++){
        const o=orphans[i]!;
        const newName=`${name}-dup${i}`;
        console.log(`    → 重命名孤儿 ${o.id} → ${newName}`);
        list.push({id:o.id,name:newName,kind:'coding-agent',deployment:'local',created:o.created,lastSeen:new Date().toISOString(),note:'',model:'',hostname:os.hostname()});
        // 更新 IdentityData 名字
        try{
          const idFile=path.join(PAIMON,'IdentityData',o.id,'identity.json');
          const idData=JSON.parse(fs.readFileSync(idFile,'utf8'));
          idData.name=newName;
          if(!Array.isArray(idData.renameHistory)) idData.renameHistory=[];
          idData.renameHistory.unshift({from:name,to:newName,at:new Date().toISOString(),reason:'duplicate-auto-rename'});
          fs.writeFileSync(idFile,JSON.stringify(idData,null,2));
        }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
      }
      id=keep.id;
      const now2=new Date().toISOString();
      list.push({id,name,kind:'coding-agent',deployment:'local',created:keep.created||now2,lastSeen:now2,note:'',model:'',hostname:os.hostname()});
      savePlist(list);
    }else{
      id=randomBytes(4).toString('hex');
      const now2=new Date().toISOString();
      list.push({id,name,kind:'coding-agent',deployment:'local',created:now2,lastSeen:now2,note:'',model:'',hostname:os.hostname()});
      savePlist(list);
    }
    pname=name; kind='coding-agent';
  }

  if(!confirm(`Enter ${pname}?`)) process.exit(0);

  // Update lastSeen
  const p=list.find((x:any)=>x.id===id);
  if(p){ p.lastSeen=new Date().toISOString(); p.hostname=os.hostname(); savePlist(list) }

  // Setup dirs
  const dataDir=path.join(PAIMON,'MemoryData',id);
  const rtDir=path.join(PAIMON,'RuntimeCache',id);
  const sessDir=path.join(PAIMON,'SessionData',id);
  fs.mkdirSync(dataDir,{recursive:true}); fs.mkdirSync(rtDir,{recursive:true}); fs.mkdirSync(sessDir,{recursive:true});

  // Mode handling
  if(mode==='mc'){
    const tn=`mc-${id}`;
    try{ execSync(`tmux has-session -t ${tn} 2>/dev/null`); console.log(`Attaching to ${tn}`); execSync(`tmux attach -t ${tn}`,{stdio:'inherit'}); process.exit(0) }catch{ console.error(`${pname} metaconsciousness not running`); process.exit(0) }
  }
  if(mode==='hc'){
    const tn=`hc-${id}`;
    try{ execSync(`tmux has-session -t ${tn} 2>/dev/null`); console.log(`Attaching to ${tn}`); execSync(`tmux attach -t ${tn}`,{stdio:'inherit'}); process.exit(0) }catch{ console.error(`${pname} hippocampus not running`); process.exit(0) }
  }
  if(mode==='kill'){
    try{ execSync(`pkill -f "genshin:.*${pname}" 2>/dev/null`); console.log(`killed ${pname}`) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
    process.exit(0);
  }
  if(mode==='tmux'){
    const out=execSync('ps aux',{encoding:'utf8'});
    const line=out.split('\n').find((l: string)=>l.includes(`genshin:`)&&l.includes(pname));
    if(!line){ console.error(`${pname} not running`); process.exit(0) }
    console.log(line); process.exit(0);
  }

  // Mobile
  if(mode==='mobile'){
    const devCli=path.join(EXT,'god.frontend.cli','cli.ts');
    try{ execSync(`node ${devCli} ${mode} ${id} ${pname}`,{stdio:'inherit'}) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
    process.exit(0);
  }

  // Settings
  if(mode==='settings'){
    cmdSettings(); process.exit(0);
  }

  // Archive / Unarchive
  if(mode==='archive'||mode==='unarchive'){
    if(entry){ entry.archived=mode==='archive'; savePlist(list); console.log(`${pname} ${mode}d`) }
    process.exit(0);
  }

  // Main agent loop
  process.env.PAIMON_AGENT_NAME=pname;
  process.env.PAIMON_AGENT_ID=id;

  const pidFile=path.join(dataDir,'main.pid');
  if(fs.existsSync(pidFile)){
    const oldPid=parseInt(fs.readFileSync(pidFile,'utf8').trim());
    try{ process.kill(oldPid,0); console.error(`ERROR: ${pname} already running (PID ${oldPid})`); process.exit(1) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
  }
  fs.writeFileSync(pidFile,String(process.pid));

  const wakeFile=path.join(rtDir,'wake-restart');
  const extFlags=`-ne -e ${EXT}/index.ts`;

  let lastNonce='', woke='';
  try{ lastNonce=fs.readFileSync(wakeFile,'utf8').trim() }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }

  // Clear screen
  process.stdout.write('\x1b[2J\x1b[H');

  while(true){
    try{
      // --continue: 恢复最近的 session（jsonl 历史重新渲染，模型 context 含历史）。
      // 无 --continue 时 pi 默认新建空 session → 每次重启模型失忆 → 必须 recap。
      const args=[RUNTIME,...extFlags.split(' '),'--session-dir',sessDir,'--continue'];
      const { spawnSync } = require('child_process');
      spawnSync('node', args, {stdio:'inherit', env:{...process.env, PI_ALIVE_RESTART_LOOP:'1', PI_ALIVE_WOKE:woke}});
    }catch(e: any){
      console.error('genshin error:',e?.message||e);
    }

    let nonce='';
    try{ nonce=fs.readFileSync(wakeFile,'utf8').trim() }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
    if(nonce&&nonce!==lastNonce){ lastNonce=nonce; woke='1'; continue }
    break;
  }

  try{ fs.unlinkSync(pidFile) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
}

// ═══════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════
function cmdSettings() {
  process.stdout.write('\x1b[2J\x1b[H');
  let settings: any={};
  try{ settings=JSON.parse(fs.readFileSync(PAIMON_SETTINGS,'utf8')) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
  const save=()=>{ try{ fs.mkdirSync(path.dirname(PAIMON_SETTINGS),{recursive:true}); fs.writeFileSync(PAIMON_SETTINGS,JSON.stringify(settings,null,2)) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); } };

  const menu=[
    {key:'defaultKind',label:ZH?'默认类型':'Default Kind',opts:['coding-agent']},
    {key:'lang',label:ZH?'界面语言':'Language',opts:['zh','en']},
    {key:'developerMode',label:ZH?'开发者模式':'Developer Mode',toggle:true},
    {key:'blackboxEnabled',label:ZH?'黑盒模式':'Blackbox',toggle:true},
  ];

  let idx=0;
  const render=()=>{
    process.stdout.write('\x1b[2J\x1b[H');
    const lines=['  '+BOLD+'Teyvat'+R+D+' · '+(ZH?'设置':'Settings')+R,''];
    for(let i=0;i<menu.length;i++){
      const m=menu[i];
      const pre=i===idx?G+'> '+R:'  ';
      let val='';
      if(m.toggle) val=settings[m.key]?(ZH?' \u2713 \u5f00':' \u2713 ON'):(ZH?' \u2717 \u5173':' \u2717 OFF');
      else val=' ['+(settings[m.key]||m.opts?.[0])+']';
      lines.push(pre+m.label+val);
    }
    lines.push('',D+'  \u2191\u2193 \u9009  Enter/\u2190\u2192 \u6539  q \u9000\u51fa'+R);
    console.log(lines.join('\n'));
  };
  render();

  const stdin=process.stdin;
  if(stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data',(key: Buffer)=>{
    const k=key.toString();
    if(k==='q'||k==='\x1b'||k==='\x03'){ process.stdout.write('\x1b[2J\x1b[H'); if(stdin.isTTY) stdin.setRawMode(false); process.exit(0) }
    if(k==='\x1b[A'){ idx=Math.max(0,idx-1); render() }
    else if(k==='\x1b[B'){ idx=Math.min(menu.length-1,idx+1); render() }
    else{
      const m=menu[idx];
      if(m.toggle){ settings[m.key]=!settings[m.key]; save(); render() }
      else{ const ci=(m.opts||[]).indexOf(settings[m.key]||''); settings[m.key]=m.opts![(ci+1)%m.opts!.length]; save(); render() }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// NOTE
// ═══════════════════════════════════════════════════════════════════
function cmdNote(id?: string, msg?: string) {
  const nc = path.join(EXT, 'god.frontend.cli/note.cjs');
  if (!id) { execSync(`node ${JSON.stringify(nc)}`, { stdio: 'inherit' }); return }
  const p = path.join(PAIMON, 'MemoryData');
  if (!fs.existsSync(p + '/' + id)) {
    // agent may be offline — search plist
    const list = loadPlist();
    const found = list.find((x: any) => x.id === id || x.name === id);
    if (!found) { console.error(`agent ${id} not found`); return }
    id = found.id;
  }
  try {
    execSync(`node ${JSON.stringify(nc)} ${id} ${msg ? JSON.stringify(msg) : ''}`, { stdio: 'inherit' });
  } catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
}

// ═══════════════════════════════════════════════════════════════════
// ORG
// ═══════════════════════════════════════════════════════════════════
function cmdOrg(name?: string, agent?: string) {
  const ofile=path.join(PAIMON,'AgentWorkDir','Organizational','orgs.json');
  let orgs: any[]=[];
  try{ orgs=JSON.parse(fs.readFileSync(ofile,'utf8')) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }

  if(!name){ for(const o of orgs) console.log(`${o.name} (${o.id})\n  members: ${o.members.join(', ')}`); return }

  if(!agent){
    const id=Math.random().toString(16).slice(2,8);
    orgs.push({id,name,members:[],created:new Date().toISOString().slice(0,10)});
    fs.mkdirSync(path.dirname(ofile),{recursive:true}); fs.writeFileSync(ofile,JSON.stringify(orgs,null,2));
    console.log(`created org: ${name} (${id})`);
  }else{
    const o=orgs.find((x: any)=>x.id===name||x.name===name);
    if(!o){ console.error(`org ${name} not found`); return }
    if(!o.members.includes(agent)) o.members.push(agent);
    fs.mkdirSync(path.dirname(ofile),{recursive:true}); fs.writeFileSync(ofile,JSON.stringify(orgs,null,2));
    console.log(`${agent} joined ${o.name}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// ARCHIVE
// ═══════════════════════════════════════════════════════════════════
function cmdArchive(targets: string[], doArchive: boolean) {
  const list=loadPlist();
  const now=Date.now(), ps=psAux();
  computeAndSort(list.filter((p:any)=>!p.archived),ps,now);

  for(const t of targets){
    let p: any;
    if(/^\d+$/.test(t)){
      const active=list.filter((x:any)=>x._active);
      const offline=list.filter((x:any)=>!x._active);
      p=doArchive?offline[parseInt(t)-1]:active[parseInt(t)-1];
    }else{
      p=list.find((x: any)=>x.name===t||x.id===t);
    }
    if(!p){ console.log(`  ${t} not found`); continue }
    p.archived=doArchive;
    console.log(`  ${p.name} ${doArchive?'archived':'unarchived'}`);
  }
  savePlist(list);
}

// ═══════════════════════════════════════════════════════════════════
// VERSION
// ═══════════════════════════════════════════════════════════════════
function cmdVersion() {
  try {
    const v=JSON.parse(fs.readFileSync(path.join(PAIMON,'version.json'),'utf8'));
    console.log(`${v.genshin} (${v.channel})`);
  } catch {
    console.log('unknown');
  }
}

// ═══════════════════════════════════════════════════════════════════
// RENAME
// ═══════════════════════════════════════════════════════════════════
function cmdRename(oldName: string, newName: string) {
  if(!oldName||!newName){ console.error('  usage: genshin rename <name> <new-name>'); process.exit(1) }
  if(RESERVED_NAMES.has(newName.toLowerCase())){ console.error(`  "${newName}" is a reserved name.`); process.exit(1) }
  if(!/^[a-zA-Z][a-zA-Z0-9_.\-]*$/.test(newName)){ console.error(`  invalid name "${newName}": must start with a letter, only a-z A-Z 0-9 _ allowed.`); process.exit(1) }

  const list=loadPlist();
  const entry=list.find((p:any)=>p.name===oldName||p.id===oldName);
  if(!entry){ console.error(`  agent "${oldName}" not found.`); process.exit(1) }
  if(list.find((p:any)=>p.name===newName)){ console.error(`  name "${newName}" already taken.`); process.exit(1) }

  const prev=entry.name;
  entry.name=newName;
  savePlist(list);

  const idDir=path.join(PAIMON,'IdentityData',entry.id);
  const idFile=path.join(idDir,'identity.json');
  let idData: any={};
  try{ idData=JSON.parse(fs.readFileSync(idFile,'utf8')) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
  if(!Array.isArray(idData.renameHistory)) idData.renameHistory=[];
  idData.renameHistory.unshift({from:prev,to:newName,at:new Date().toISOString()});
  fs.mkdirSync(idDir,{recursive:true});
  fs.writeFileSync(idFile,JSON.stringify(idData,null,2));

  console.log(`  ${prev} → ${newName}`);
}

// ═══════════════════════════════════════════════════════════════════
// CLONE
// ═══════════════════════════════════════════════════════════════════
function copyDir(src: string, dst: string) {
  fs.cpSync(src, dst, { recursive: true });
}
function copyDirExcept(src: string, dst: string, exclude: Set<string>) {
  fs.cpSync(src, dst, { recursive: true, filter: (s: string) => !exclude.has(path.basename(s)) });
}
// 源 agent 是否活跃（有 resting/hibernate/paused 状态 = 不活跃；否则 main.pid 心跳 2 分钟内 = 活跃）
function isAgentActive(id: string): boolean {
  const rc = path.join(PAIMON, 'RuntimeCache', id);
  if (fs.existsSync(path.join(rc, 'main-resting')) || fs.existsSync(path.join(rc, 'main-hibernate')) || fs.existsSync(path.join(rc, 'paused'))) return false;
  try { const st = fs.statSync(path.join(PAIMON, 'MemoryData', id, 'main.pid')); return Date.now() - st.mtimeMs < 120000; } catch { return false; }
}
// Token 估算（与 memory.ts 同款：CJK 1.8/字，非 CJK /4）
function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
  }
  return Math.ceil(cjk * 1.8 + (text.length - cjk) / 4);
}

function cmdClone(name: string) {
  if (!name) { cmdCloneTree(); return; }
  const list = loadPlist();
  const src = list.find((p: any) => p.name === name || p.id === name);
  if (!src) { console.error(`  agent "${name}" not found.`); process.exit(1); }
  if (src.archived) { console.error(`  "${src.name}" 已归档，无法克隆。`); process.exit(1); }
  // 只允许克隆 offline 的 agent（online 克隆的并发一致性后续再实现）
  if (isAgentActive(src.id)) {
    console.error(`  源 agent「${src.name}」正在运行，暂不支持克隆活跃 agent。请先让其 hibernate/暂停（/pause），再克隆。`);
    process.exit(1);
  }

  // 新 id（不冲突）
  let newId: string;
  do { newId = randomBytes(4).toString('hex'); }
  while (list.some((p: any) => p.id === newId) || fs.existsSync(path.join(PAIMON, 'MemoryData', newId)));

  // 新名字 XXXX-C / -C2 / -C3...
  const base = src.name + '-C';
  let newName = base, n = 2;
  while (list.some((p: any) => p.name === newName)) { newName = base + n; n++; }

  const now = new Date().toISOString();

  // 预期信息表格（重点：继承记忆的 Token 估算，决定克隆体启动时的上下文占用与费用）
  const memDir = path.join(PAIMON, 'MemoryData', src.id);
  const tokFiles: [string, string][] = [
    ['dna/index.md', 'dna/index.md'],
    ['neocortex.md', 'neocortex.md'],
    ['work_memory.md', 'work_memory.md'],
    ['context.md', 'context.md'],
  ];
  const modelMax = parseInt(process.env.PI_MODEL_MAX_TOKENS || '') || 1000000;
  let totalTok = 0;
  const tokLines: string[] = [];
  for (const [rel, label] of tokFiles) {
    let tok = 0;
    try { tok = estimateTokens(fs.readFileSync(path.join(memDir, rel), 'utf8')); } catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
    totalTok += tok;
    tokLines.push(`    ${label.padEnd(20)}${String(tok).padStart(9)} tokens`);
  }
  console.log('');
  console.log(`  ${BOLD}克隆预览${R}`);
  console.log(`  ${D}─────────────────────────────────────${R}`);
  console.log(`  源 agent:    ${src.name} (#${src.id})`);
  console.log(`  克隆体名:    ${newName}`);
  console.log(`  新 ID:       ${newId}`);
  console.log('');
  console.log(`  继承记忆 Token 估算:`);
  for (const l of tokLines) console.log(l);
  console.log(`    ${pad('合计', 20)}${String(totalTok).padStart(9)} tokens (约占窗口 ${(totalTok / modelMax * 100).toFixed(1)}%)`);
  console.log(`  ${D}─────────────────────────────────────${R}`);
  console.log(`  将复制: 记忆 + 工作区 + 文件数据`);
  console.log(`  不复制: SessionData / RuntimeCache / LogData / 共享资产`);
  console.log(`  克隆后: 两者独立；原体记"被克隆"；克隆体启动注入"你是克隆体"`);
  console.log('');
  if (!confirm('继续克隆?')) { console.log('  已取消。'); process.exit(0); }

  // 复制记忆（offline 时文件稳定，直接全量复制，除 main.pid）
  const srcMem = path.join(PAIMON, 'MemoryData', src.id);
  const dstMem = path.join(PAIMON, 'MemoryData', newId);
  const humanSize = (b: number) => b > 1<<30 ? (b/(1<<30)).toFixed(1)+'G' : b > 1<<20 ? (b/(1<<20)).toFixed(1)+'M' : b > 1<<10 ? (b/(1<<10)).toFixed(0)+'K' : b+'B';
  const dirInfo = (d: string) => { try { let n=0,s=0; const w=(p:string)=>{ for(const e of fs.readdirSync(p,{withFileTypes:true})){ const fp=path.join(p,e.name); if(e.isDirectory()) w(fp); else { n++; try{ s+=fs.statSync(fp).size }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); } } } }; w(d); return humanSize(s)+(n>0?` / ${n} 文件`:' / 空'); } catch { return '(不存在)' } };
  console.log(`  ${D}复制数据量: 记忆 ${dirInfo(srcMem)} | 工作区 ${dirInfo(fs.existsSync(path.join(PAIMON,'AgentWorkDir','Individual',src.id))?path.join(PAIMON,'AgentWorkDir','Individual',src.id):'')} | 文件 ${dirInfo(fs.existsSync(path.join(PAIMON,'AgentFileData',src.id))?path.join(PAIMON,'AgentFileData',src.id):'')}${R}`);
  process.stdout.write(`  复制记忆... `);
  try { copyDirExcept(srcMem, dstMem, new Set(['main.pid'])); } catch (e: any) { console.error(`复制记忆失败: ${e?.message}`); process.exit(1); }
  console.log('OK');

  // 复制工作区 + 文件数据
  const srcWork = path.join(PAIMON, 'AgentWorkDir', 'Individual', src.id);
  process.stdout.write(`  复制工作区... `);
  if (fs.existsSync(srcWork)) { try { copyDir(srcWork, path.join(PAIMON, 'AgentWorkDir', 'Individual', newId)); } catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); } }
  console.log('OK');
  const srcFile = path.join(PAIMON, 'AgentFileData', src.id);
  process.stdout.write(`  复制文件数据... `);
  if (fs.existsSync(srcFile)) { try { copyDir(srcFile, path.join(PAIMON, 'AgentFileData', newId)); } catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); } }
  console.log('OK');

  // plist 双向关系：克隆体 clonedFrom/clonedAt，原体 clonedChildren 追加
  list.push({ id: newId, name: newName, kind: src.kind || 'coding-agent', deployment: 'local', created: now, lastSeen: now, note: '', model: src.model || '', clonedFrom: src.id, clonedAt: now });
  const srcEntry = list.find((p: any) => p.id === src.id);
  if (srcEntry) {
    if (!Array.isArray(srcEntry.clonedChildren)) srcEntry.clonedChildren = [];
    srcEntry.clonedChildren.push(newId);
  }
  savePlist(list);

  // identity.json
  const idDir = path.join(PAIMON, 'IdentityData', newId);
  fs.mkdirSync(idDir, { recursive: true });
  fs.writeFileSync(path.join(idDir, 'identity.json'), JSON.stringify({ id: newId, name: newName, kind: src.kind || 'coding-agent', created: now, lastSeen: now, archived: false, note: '', model: src.model || '', clonedFrom: src.id, clonedAt: now }, null, 2));

  // 克隆体的 tokenmaxxed.json：继承原体履历为 inherited 段，自身从零开始
  try {
    const srcTokenmaxxed = path.join(PAIMON, 'MemoryData', src.id, 'tokenmaxxed.json');
    const dstTokenmaxxed = path.join(PAIMON, 'MemoryData', newId, 'tokenmaxxed.json');
    let srcData: any = {};
    try { srcData = JSON.parse(fs.readFileSync(srcTokenmaxxed, 'utf8')); } catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
    const inheritedTotal = srcData.tokenmaxxed || 0;
    const cloneTokenmaxxed = {
      input: 0, output: 0, think: 0, cache_read: 0, tokenmaxxed: 0, sessions: 0,
      inherited: { from: src.id, from_name: src.name, at: now, tokenmaxxed: inheritedTotal, input: srcData.input || 0, output: srcData.output || 0, think: srcData.think || 0 },
      lastUpdated: now,
    };
    fs.writeFileSync(dstTokenmaxxed, JSON.stringify(cloneTokenmaxxed, null, 2));
  } catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }

  console.log(`  ${G}✓${R} 已克隆: ${src.name} → ${newName} (#${newId})`);
  console.log(`  ${D}记忆/工作区/文件已完整复制；两者自克隆起彼此独立。${R}`);
}

function cmdCloneTree() {
  const list = loadPlist();
  const hasClones = list.some((p: any) => p.clonedFrom || (Array.isArray(p.clonedChildren) && p.clonedChildren.length > 0));
  if (!hasClones) { console.log('  (暂无克隆记录。用 genshin c <name> 克隆一个 agent。)'); return; }

  const byParent = new Map<string, any[]>();
  for (const p of list) {
    if (p.clonedFrom) {
      const arr = byParent.get(p.clonedFrom) || [];
      arr.push(p);
      byParent.set(p.clonedFrom, arr);
    }
  }
  const fmt = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const printed = new Set<string>();

  console.log('');
  const print = (p: any, prefix: string, isLast: boolean) => {
    if (printed.has(p.id)) return; // DAG 去重
    printed.add(p.id);
    const when = p.clonedFrom ? ` ${fmt(p.clonedAt)}` : '';
    console.log(`  ${prefix}${isLast ? '└─' : '├─'} ${p.name}${when}`);
    const children = byParent.get(p.id) || [];
    children.forEach((c: any, i: number) => print(c, prefix + (isLast ? '   ' : '│  '), i === children.length - 1));
  };
  const roots = list.filter((p: any) => !p.clonedFrom);
  const visibleRoots = roots.filter((r: any) => (byParent.get(r.id) || []).length > 0);
  visibleRoots.forEach((r: any, i: number) => print(r, '', i === visibleRoots.length - 1));
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════
// DOCTOR
// ═══════════════════════════════════════════════════════════════════
function cmdDoctor() {
  const B=BOLD, R_=R, G_=G, R2='\x1b[31m', YLW='\x1b[33m';
  console.log('\n  '+B+'Teyvat · Doctor'+R_+D+R_+'\n');

  let passed=0, failed=0, warned=0, skipped=0;
  const ok=(label:string,msg:string)=>{ console.log(`  ${G_}✓${R_} ${pad(label,20)} ${msg}`); passed++ };
  const fail=(label:string,msg:string)=>{ console.log(`  ${R2}✗${R_} ${pad(label,20)} ${msg}`); failed++ };
  const warn=(label:string,msg:string)=>{ console.log(`  ${YLW}△${R_} ${pad(label,20)} ${msg}`); warned++ };
  const skip=(label:string,msg:string)=>{ console.log(`  ${D}⊘${R_} ${pad(label,20)} ${msg}`); skipped++ };

  const list=loadPlist();
  const active=list.filter((p:any)=>!p.archived);
  const archived=list.filter((p:any)=>p.archived);
  const NAME_RE=/^[a-zA-Z][a-zA-Z0-9_.\-]*$/;

  // version
  {
    try{
      const v=JSON.parse(fs.readFileSync(path.join(PAIMON,'agent','version.json'),'utf8'));
      ok('version',`${v.genshin} (${v.channel}, pi@${v.pi})`);
    }catch{
      try{
        const v=JSON.parse(fs.readFileSync(path.join(PAIMON,'version.json'),'utf8'));
        ok('version',`${v.paimon||v.genshin} (${v.channel})`);
      }catch{ fail('version','version.json 不存在') }
    }
  }

  // dir-structure: key directories exist
  {
    const dirs=['MemoryData','RuntimeCache','SessionData','IdentityData','UserAccount','MemoirData','AgentWorkDir','config'];
    const missing=dirs.filter(d=>!fs.existsSync(path.join(PAIMON,d)));
    if(missing.length) fail('dir-structure',`缺失: ${missing.join(', ')}`);
    else ok('dir-structure',`${dirs.length} 核心目录全部存在`);
  }

  // plist-agents
  {
    ok('plist-agents',`${list.length} 个 agent（${active.length} 活跃, ${archived.length} 归档）`);
  }

  // plist-identity: check consistency between plist and identity.json
  {
    let mismatch=0, missing=0;
    const mismatched:string[]=[];
    for(const p of list){
      const idFile=path.join(PAIMON,'IdentityData',p.id,'identity.json');
      try{
        const id=JSON.parse(fs.readFileSync(idFile,'utf8'));
        if(id.name && id.name !== p.name) { mismatch++; mismatched.push(`${p.name}≠${id.name}`); }
        if(id.kind && id.kind !== p.kind) { mismatch++; mismatched.push(`${p.name}.kind`); }
      }catch{ missing++ }
    }
    if(mismatch) fail('plist-identity',`${mismatch} 不一致: ${mismatched.slice(0,3).join(', ')}${mismatched.length>3?'...':''}`);
    else if(missing>0) warn('plist-identity',`一致，但 ${missing} 个 agent 无 identity.json`);
    else ok('plist-identity',`${list.length} 个 agent 数据一致`);
  }

  // name-valid
  {
    const bad=active.filter((p:any)=>!NAME_RE.test(p.name));
    if(bad.length) fail('name-valid',`${bad.length} 个名称不合规: ${bad.map((p:any)=>p.name).join(', ')}`);
    else ok('name-valid',`${active.length} 个活跃 agent 名称全部合规`);
  }

  // name-unique (only check active agents; archived duplicates are harmless)
  {
    const names=active.map((p:any)=>p.name);
    const dups=names.filter((n:string,i:number)=>names.indexOf(n)!==i);
    if(dups.length) fail('name-unique',`活跃 agent 重名: ${[...new Set(dups)].join(', ')}`);
    else{
      const archNames=archived.map((p:any)=>p.name);
      const archDups=archNames.filter((n:string,i:number)=>archNames.indexOf(n)!==i);
      if(archDups.length) warn('name-unique',`活跃无重名，归档有 ${[...new Set(archDups)].length} 组重名`);
      else ok('name-unique','无重名');
    }
  }

  // name-reserved
  {
    const bad=active.filter((p:any)=>RESERVED_NAMES.has(p.name.toLowerCase()));
    if(bad.length) fail('name-reserved',`${bad.length} 个保留字: ${bad.map((p:any)=>p.name).join(', ')}`);
    else ok('name-reserved','无保留字冲突');
  }

  // plist-orphan: plist entry but no MemoryData dir
  {
    const orphans=active.filter((p:any)=>!fs.existsSync(path.join(PAIMON,'MemoryData',p.id)));
    if(orphans.length) fail('plist-orphan',`${orphans.length} 个活跃 agent 无 MemoryData 目录`);
    else ok('plist-orphan','全部有对应目录');
  }

  // dir-orphan: MemoryData dir but no plist entry
  {
    const mdRoot=path.join(PAIMON,'MemoryData');
    const ids=new Set(list.map((p:any)=>p.id));
    const orphanList:string[]=[];
    try{
      for(const d of fs.readdirSync(mdRoot,{withFileTypes:true})){
        if(d.isDirectory()&&!ids.has(d.name)&&d.name!=='.DS_Store') orphanList.push(d.name);
      }
    }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
    if(orphanList.length) warn('dir-orphan',`${orphanList.length} 个孤儿目录（无 plist 条目）`);
    else ok('dir-orphan','无孤儿目录');
  }

  // process: running agents
  {
    let psOut='';
    try{ psOut=execSync('ps aux',{encoding:'utf8'}) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
    const running=active.filter((p:any)=>psOut.split('\n').some((l:string)=>l.includes('genshin:')&&l.includes('(main,')&&l.includes(p.id)));
    ok('process',`${running.length} 个 agent 正在运行`);
  }

  // pid-stale (informational, not a failure)
  {
    let stale=0, total=0;
    for(const p of list){
      const pidFile=path.join(PAIMON,'MemoryData',p.id,'main.pid');
      try{
        const pid=parseInt(fs.readFileSync(pidFile,'utf8').trim());
        total++;
        try{ process.kill(pid,0) }catch{ stale++ }
      }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
    }
    if(stale) warn('pid-stale',`${stale}/${total} 个 PID 文件对应进程已退出`);
    else ok('pid-stale',total>0?`${total} 个 PID 文件均有效`:'无 PID 文件');
  }

  // org: organization health
  {
    const orgsFile=path.join(PAIMON,'AgentWorkDir','Organizational','orgs.json');
    try{
      const orgs=JSON.parse(fs.readFileSync(orgsFile,'utf8'));
      const totalMembers=orgs.reduce((s:number,o:any)=>s+o.members.length,0);
      const badRefs=orgs.reduce((s:number,o:any)=>s+o.members.filter((mid:string)=>!list.find((p:any)=>p.id===mid)).length,0);
      if(badRefs) warn('org',`${orgs.length} 个组织, ${totalMembers} 个成员, ${badRefs} 个无效引用`);
      else ok('org',`${orgs.length} 个组织, ${totalMembers} 个成员`);
    }catch{ skip('org','无组织数据') }
  }

  // sync-binding
  {
    const bindFile=path.join(PAIMON,'UserAccount','binding.json');
    if(fs.existsSync(bindFile)){
      try{
        const b=JSON.parse(fs.readFileSync(bindFile,'utf8'));
        const user=b.githubLogin||b.username||b.github_id;
        if(user) ok('sync-binding',`${user} (${b.authMethod||'unknown'})`);
        else fail('sync-binding','binding.json 缺少用户信息');
      }catch{ fail('sync-binding','binding.json 损坏') }
    }else skip('sync-binding','未登录');
  }

  // sync-status
  {
    const syncFile=path.join(PAIMON,'LogData','sync-status.json');
    try{
      const ss=JSON.parse(fs.readFileSync(syncFile,'utf8'));
      if(ss.lastAt){
        const ago=Math.round((Date.now()-new Date(ss.lastAt).getTime())/60000);
        const agoStr=ago<1?'<1 分钟':ago<60?`${ago} 分钟`:ago<1440?`${Math.round(ago/60)} 小时`:`${Math.round(ago/1440)} 天`;
        ok('sync-status',`${agoStr}前同步（${ss.lastAction||'unknown'} ${ss.count||0}）`);
      }else skip('sync-status','无同步记录');
    }catch{ skip('sync-status','无同步数据') }
  }

  // config: settings.json readable
  {
    const configDir=process.env.PAIMON_CONFIG||path.join(PAIMON,'config');
    const settFile=path.join(configDir,'settings.json');
    try{
      const s=JSON.parse(fs.readFileSync(settFile,'utf8'));
      const devMode=!!s.developerMode;
      ok('config',`settings.json OK${devMode?' (开发者模式)':''}`);
    }catch{
      if(fs.existsSync(settFile)) fail('config','settings.json 格式错误');
      else warn('config','settings.json 不存在，使用默认配置');
    }
  }

  // terminal-scrollback: check iTerm2 scrollback settings
  {
    const termProg=process.env.TERM_PROGRAM;
    if(process.platform==='darwin'&&(termProg==='iTerm.app'||fs.existsSync(path.join(process.env.HOME||'','Library/Preferences/com.googlecode.iterm2.plist')))){
      try{
        let idx=0,limited=0,total=0;
        const plist=path.join(process.env.HOME||'','Library/Preferences/com.googlecode.iterm2.plist');
        while(true){
          try{
            execSync(`/usr/libexec/PlistBuddy -c "Print ':New Bookmarks:${idx}:Name'" "${plist}"`,{encoding:'utf8',stdio:['pipe','pipe','pipe']});
          }catch{ break }
          const val=execSync(`/usr/libexec/PlistBuddy -c "Print ':New Bookmarks:${idx}:Unlimited Scrollback'" "${plist}"`,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
          if(val!=='true') limited++;
          total++; idx++;
        }
        if(limited>0) warn('scrollback',`iTerm2 ${limited}/${total} 个 profile scrollback 有限制，运行 make dev-minutely 自动修复`);
        else ok('scrollback',`iTerm2 ${total} 个 profile 均 unlimited`);
      }catch{ skip('scrollback','无法读取 iTerm2 配置') }
    }else{ skip('scrollback',`非 iTerm2 环境 (${termProg||'unknown'})`) }
  }

  // disk: total disk usage
  {
    try{
      const du=execSync(`du -sh "${PAIMON}" 2>/dev/null`,{encoding:'utf8'}).trim().split(/\s/)[0];
      ok('disk',`总占用 ${du}`);
    }catch{ skip('disk','无法计算') }
  }

  console.log(`\n  ${passed} passed, ${failed} failed, ${warned} warned, ${skipped} skipped\n`);
}

// ═══════════════════════════════════════════════════════════════════
// ACCOUNT
// ═══════════════════════════════════════════════════════════════════

const USER_ACCOUNT = path.join(PAIMON, 'UserAccount');
const BINDING_FILE = path.join(USER_ACCOUNT, 'binding.json');

function getBinding(): any | null {
  try { return JSON.parse(fs.readFileSync(BINDING_FILE, 'utf8')); } catch { return null; }
}
function saveBinding(b: any) {
  fs.mkdirSync(USER_ACCOUNT, { recursive: true });
  fs.writeFileSync(BINDING_FILE, JSON.stringify(b, null, 2));
}
const SYNC_TUNNEL = 'http://localhost:13456';
function getEndpoint(): string {
  try {
    const svc = JSON.parse(fs.readFileSync(path.join(USER_ACCOUNT, 'services.json'), 'utf8'));
    if (svc['genshin-sync']?.endpoint) return svc['genshin-sync'].endpoint;
  } catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
  // SSH 隧道优先（绕过 ICP），探测是否可用
  try { execSync('curl -sf --connect-timeout 1 ' + SYNC_TUNNEL + '/health', { stdio: 'ignore' }); return SYNC_TUNNEL; } catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
  return SYNC_ENDPOINT_DEFAULT;
}

async function cmdLogin() {
  const existing = getBinding();
  if (existing?.token && existing?.githubLogin) {
    console.log(`  已登录: ${existing.githubLogin}`);
    console.log(`  如需切换账户，先 genshin logout`);
    return;
  }

  // 策略1: 检测 gh CLI token（最快路径，无需网络到 sync 服务器）
  let ghToken = '';
  try { ghToken = execSync('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim(); } catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }

  if (ghToken) {
    console.log('  检测到 gh CLI，正在验证...');
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${ghToken}`, 'User-Agent': 'teyvat' },
    });
    if (res.ok) {
      const gh = await res.json() as { id: number; login: string; avatar_url: string };
      const deviceId = existing?.deviceId || randomBytes(4).toString('hex');
      saveBinding({
        githubUserId: gh.id,
        githubLogin: gh.login,
        deviceId,
        boundAt: new Date().toISOString(),
        token: ghToken,
        authMethod: 'gh-cli',
      });
      console.log(`  ${G}✓${R} 登录成功: ${gh.login} (via gh CLI)`);
      return;
    }
    console.log('  gh token 验证失败，尝试 device flow...');
  }

  // 策略2: device flow（需要 sync 服务器在线）
  const endpoint = getEndpoint();
  console.log(`  正在连接 ${endpoint}...`);

  let startRes: Response;
  try {
    startRes = await fetch(`${endpoint}/auth/device-flow/start`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error(`  无法连接到同步服务器: ${e.code || e.message}`);
    console.error(`  请先安装 gh CLI 并运行 gh auth login，然后重试 genshin login`);
    process.exit(1);
  }
  if (!startRes.ok) { console.error(`  服务器错误: ${startRes.status}`); process.exit(1); }

  const startData = await startRes.json() as {
    device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number;
  };

  console.log('');
  console.log(`  请在浏览器中打开: ${BOLD}${startData.verification_uri}${R}`);
  console.log(`  输入验证码:       ${BOLD}${startData.user_code}${R}`);
  console.log('');
  console.log(`  等待授权中...`);

  const interval = (startData.interval || 5) * 1000;
  const deadline = Date.now() + (startData.expires_in || 900) * 1000;
  const deviceId = existing?.deviceId || randomBytes(4).toString('hex');

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));

    const pollRes = await fetch(`${endpoint}/auth/device-flow/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: startData.device_code }),
    });

    const pollData = await pollRes.json() as {
      token?: string; error?: string;
      user?: { githubId: number; login: string; avatarUrl: string };
    };

    if (pollData.token && pollData.user) {
      saveBinding({
        githubUserId: pollData.user.githubId,
        githubLogin: pollData.user.login,
        deviceId,
        boundAt: new Date().toISOString(),
        token: pollData.token,
      });
      console.log(`  ${G}✓${R} 登录成功: ${pollData.user.login}`);
      return;
    }

    if (pollData.error === 'authorization_pending' || pollData.error === 'slow_down') continue;
    if (pollData.error === 'expired_token') { console.error('  验证码已过期，请重新运行 genshin login'); process.exit(1); }
    if (pollData.error === 'access_denied') { console.error('  授权被拒绝'); process.exit(1); }
    if (pollData.error) { console.error(`  错误: ${pollData.error}`); process.exit(1); }
  }

  console.error('  超时，请重新运行 genshin login');
  process.exit(1);
}

function cmdLogout() {
  const b = getBinding();
  if (!b?.token) { console.log('  未登录'); return; }
  const login = b.githubLogin || 'unknown';
  b.token = '';
  saveBinding(b);
  console.log(`  ${G}✓${R} 已登出 (${login})，绑定关系保留`);
}

function cmdUnbind() {
  const b = getBinding();
  if (!b?.githubLogin && !b?.token) { console.log('  未绑定'); return; }
  const login = b.githubLogin || 'unknown';
  fs.writeFileSync(BINDING_FILE, '{}');
  console.log(`  ${G}✓${R} 已解绑 ${login}，同步数据已清除`);
}

function cmdWhoami() {
  const b = getBinding();
  if (!b?.githubLogin) {
    console.log('  未登录。运行 genshin login 绑定 GitHub 账户。');
    return;
  }
  console.log(`  ${BOLD}${b.githubLogin}${R}`);
  console.log(`  GitHub ID:  ${b.githubUserId}`);
  console.log(`  设备 ID:    ${b.deviceId}`);
  console.log(`  绑定时间:   ${b.boundAt ? new Date(b.boundAt).toLocaleString('zh-CN') : '未知'}`);
  const method = b.authMethod === 'gh-cli' ? ' (gh CLI)' : ' (device flow)';
  console.log(`  登录状态:   ${b.token ? G + '已登录' + method + R : Y + '已登出（token 已清除）' + R}`);
  console.log(`  同步服务:   ${getEndpoint()}`);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const args=process.argv.slice(2);
  if(!args.length){ cmdList(); return }

  const first=args[0];

  // --version / --help: POSIX 惯例，唯二保留的 flag
  if(first==='--version'||first==='-V'){ cmdVersion(); return }
  if(first==='--help'){ cmdList('help'); return }

  const sub=SUBCOMMANDS[first];
  const rest=sub?args.slice(1):args;

  if(sub){
    const name=rest[0]||'';
    switch(sub){
      case 'version': cmdVersion(); return;
      case 'archived': cmdList('archived'); return;
      case 'settings': cmdSettings(); return;
      case 'help': cmdList('help'); return;
      case 'org': cmdOrg(name, rest[1]); return;
      case 'archive': case 'unarchive':
        if(!name){ console.error(`usage: genshin ${first} <name|#>`); process.exit(1) }
        cmdArchive(rest, sub==='archive'); return;
      case 'note': cmdNote(name, rest.slice(1).join(' ')); return;
      case 'rename':
        cmdRename(name, rest[1]||''); return;
      case 'clone':
        cmdClone(name); return;
      case 'doctor': cmdDoctor(); return;
      case 'login': await cmdLogin(); return;
      case 'logout': cmdLogout(); return;
      case 'unbind': cmdUnbind(); return;
      case 'whoami': cmdWhoami(); return;
      case 'mc': case 'hc': case 'kill': case 'tmux': case 'mobile':
        if(!name){ console.error(`usage: genshin ${first} <name>`); process.exit(1) }
        if(sub==='mobile'&&(name==='god'||name==='g')){
          const phoneTui=path.join(EXT,'god.frontend.cli/mobile.ts');
          try{ execSync(`bun ${JSON.stringify(phoneTui)}`,{stdio:'inherit'}) }catch (e) { console.error("[god.frontend.cli/cli.ts] " + ((e as any)?.message || e)); }
          return;
        }
        enterAgent(name, sub); return;
      case 'update': case 'uninstall':
        console.log(`  use: genshin ${sub} (handled by launcher)`); return;
      case 'sessions': case 'web':
        console.log(`  ${first}: not yet implemented`); return;
    }
  }

  const name=first;
  if(RESERVED_NAMES.has(name.toLowerCase())){
    console.error(`  "${name}" is a reserved name, cannot be used as agent name.`);
    process.exit(1);
  }
  if(!/^\d+$/.test(name) && !/^[a-zA-Z][a-zA-Z0-9_.\-]*$/.test(name)){
    console.error(`  invalid name "${name}": must start with a letter, only a-z A-Z 0-9 _ allowed.`);
    process.exit(1);
  }

  enterAgent(name);
}

main();
