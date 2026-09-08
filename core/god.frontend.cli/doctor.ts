// doctor.ts — genshin doctor 完整性检查（从 cli.ts 拆分）

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

const H = os.homedir();
const PAIMON = path.join(H, '.teyvat');
const PLIST = path.join(PAIMON, 'MemoryData', 'plist.json');

function vw(s: string): number { let w=0; for(const c of [...String(s)]){ const cp=c.codePointAt(0); w+=(cp&&cp>0x2E7F)?2:1 } return w }
function pad(s: string, n: number): string { return String(s)+' '.repeat(Math.max(0,n-vw(String(s)))) }
function loadPlist(): any[] { try { return JSON.parse(fs.readFileSync(PLIST,'utf8')) } catch { return [] } }

const BOLD='\x1b[1m', R='\x1b[0m', G='\x1b[32m', D='\x1b[90m';

const SUBCOMMANDS: Record<string,string> = {
  'archive':'archive', 'a':'archive',
  'settings':'settings', 's':'settings', 'set':'settings',
  'note':'note', 'n':'note',
  'org':'org', 'o':'org',
  'rename':'rename',
  'version':'version', 'v':'version',
  'clone':'clone',
  'doctor':'doctor',
  'login':'login',
  'logout':'logout',
  'unbind':'unbind',
  'whoami':'whoami',
  'sync':'sync',
  'upload-state':'upload-state',
};
const RESERVED_NAMES = new Set([
  ...Object.keys(SUBCOMMANDS),
  'update','upgrade','config','list','ls','status',
  'install','uninstall','doctor','reset',
]);

export function cmdDoctor() {
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

  let doctorIgnore: Array<{ check: string; match?: string }> = [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(PAIMON, 'config', 'doctor-whitelist.json'), 'utf8'));
    doctorIgnore = Array.isArray(s) ? s : (Array.isArray(s.doctorIgnore) ? s.doctorIgnore : []);
  } catch { /* 文件缺失/格式错 → 无豁免 */ }
  let ignoredCount = 0;
  const isIgnored = (check: string, content?: string): boolean => {
    for (const r of doctorIgnore) {
      if (r.check !== check) continue;
      if (r.match === undefined || r.match === '') return true;
      if (content !== undefined && new RegExp(r.match).test(content)) return true;
    }
    return false;
  };
  const skipIgnored = (check: string, content?: string): boolean => {
    if (isIgnored(check, content)) { ignoredCount++; skip(check, `已豁免${content?` (${content.slice(0,40)})`:''}`); return true; }
    return false;
  };

  // version
  {
    try{
      const v=JSON.parse(fs.readFileSync(path.join(PAIMON,'agent','version.json'),'utf8'));
      const displayVer = (v.channel === 'prerelease' && v.pinnedDev) ? v.pinnedDev : v.genshin;
      ok('version',`${displayVer} (${v.channel}, pi@${v.pi})`);
    }catch{
      try{
        const v=JSON.parse(fs.readFileSync(path.join(PAIMON,'version.json'),'utf8'));
        ok('version',`${v.paimon||v.genshin} (${v.channel})`);
      }catch{ fail('version','version.json 不存在') }
    }
  }

  // dir-structure
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

  // plist-identity
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
    if(mismatch) {
      const shown = mismatched.filter(m => !isIgnored('plist-identity', m));
      if (shown.length) fail('plist-identity',`${shown.length} 不一致: ${shown.slice(0,3).join(', ')}${shown.length>3?'...':''}`);
      if (shown.length < mismatch) skipIgnored('plist-identity');
      else if (!shown.length) { skipIgnored('plist-identity'); }
    }
    else if(missing>0) warn('plist-identity',`一致，但 ${missing} 个 agent 无 identity.json`);
    else ok('plist-identity',`${list.length} 个 agent 数据一致`);
  }

  // name-valid
  {
    const bad=active.filter((p:any)=>!NAME_RE.test(p.name));
    if(bad.length) fail('name-valid',`${bad.length} 个名称不合规: ${bad.map((p:any)=>p.name).join(', ')}`);
    else ok('name-valid',`${active.length} 个活跃 agent 名称全部合规`);
  }

  // name-unique
  {
    const names=active.map((p:any)=>p.name);
    const dups=names.filter((n:string,i:number)=>names.indexOf(n)!==i);
    if(dups.length) fail('name-unique',`活跃 agent 重名: ${[...new Set(dups)].join(', ')}`);
    else{
      const archNames=archived.map((p:any)=>p.name);
      const archDups=[...new Set(archNames.filter((n:string,i:number)=>archNames.indexOf(n)!==i))];
      const shownDups = archDups.filter((n:string)=>!isIgnored('name-unique', n));
      if(shownDups.length) warn('name-unique',`活跃无重名，归档有 ${shownDups.length} 组重名: ${shownDups.join(', ')}`);
      else if (archDups.length) { /* 全豁免，静默 */ }
      else ok('name-unique','无重名');
    }
  }

  // name-reserved
  {
    const bad=active.filter((p:any)=>RESERVED_NAMES.has(p.name.toLowerCase()));
    if(bad.length) fail('name-reserved',`${bad.length} 个保留字: ${bad.map((p:any)=>p.name).join(', ')}`);
    else ok('name-reserved','无保留字冲突');
  }

  // plist-orphan
  {
    const orphans=active.filter((p:any)=>!fs.existsSync(path.join(PAIMON,'MemoryData',p.id)));
    if(orphans.length) fail('plist-orphan',`${orphans.length} 个活跃 agent 无 MemoryData 目录`);
    else ok('plist-orphan','全部有对应目录');
  }

  // dir-orphan
  {
    const mdRoot=path.join(PAIMON,'MemoryData');
    const ids=new Set(list.map((p:any)=>p.id));
    const orphanList:string[]=[];
    try{
      for(const d of fs.readdirSync(mdRoot,{withFileTypes:true})){
        if(!d.isDirectory()||ids.has(d.name)||d.name==='.DS_Store') continue;
        if(/^[0-9a-f]{8}$/.test(d.name)) orphanList.push(d.name);
      }
    }catch{ /* MemoryData 不存在 */ }
    if(orphanList.length) {
      const shown = orphanList.filter((id:string)=>!isIgnored('dir-orphan', id));
      if (shown.length) warn('dir-orphan',`${shown.length} 个孤儿目录（无 plist 条目）${orphanList.length>shown.length?`（${orphanList.length-shown.length} 已登记豁免）`:''}`);
      else if (orphanList.length) { /* 全豁免，静默 */ }
      else ok('dir-orphan','无孤儿目录');
    }
    else ok('dir-orphan','无孤儿目录');
  }

  // process
  {
    let psOut='';
    try{ psOut=execSync('ps aux',{encoding:'utf8'}) }catch{ /* ps 失败 */ }
    const running=active.filter((p:any)=>psOut.split('\n').some((l:string)=>l.includes('genshin:')&&l.includes('(main,')&&l.includes(p.id)));
    ok('process',`${running.length} 个 agent 正在运行`);
  }

  // pid-stale
  {
    const WINDOW_MS = 90 * 1000;
    let stale=0, recent=0, historical=0, nofile=0;
    const now = Date.now();
    for(const p of list){
      const pidFile=path.join(PAIMON,'MemoryData',p.id,'main.pid');
      try{
        const st = fs.statSync(pidFile);
        if (now - st.mtimeMs > WINDOW_MS) { historical++; continue; }
        recent++;
        const pid=parseInt(fs.readFileSync(pidFile,'utf8').trim());
        try{ process.kill(pid,0) }catch{ stale++ }
      }catch(e: any){
        if (e?.code === 'ENOENT') { nofile++; }
      }
    }
    const extra = `${historical?`，历史残留 ${historical}`:''}${nofile?`，未运行 ${nofile}`:''}`;
    if(stale) {
      if (!skipIgnored('pid-stale', `${stale} 个近期活跃 agent 的 PID 已死`)) warn('pid-stale',`${stale} 个近期活跃 PID 已死${extra}`);
    }
    else if(recent>0) ok('pid-stale',`${recent} 个近期活跃 PID 均有效${extra}`);
    else ok('pid-stale',`无近期活跃 agent${extra}`);
  }

  // org
  {
    const orgsFile=path.join(PAIMON,'AgentWorkDir','Organizational','orgs.json');
    try{
      const orgs=JSON.parse(fs.readFileSync(orgsFile,'utf8'));
      const totalMembers=orgs.reduce((s:number,o:any)=>s+o.members.length,0);
      const badRefsAll=orgs.reduce((s:number,o:any)=>s+o.members.filter((mid:string)=>!list.find((p:any)=>p.id===mid)).length,0);
      if(badRefsAll) {
        const badList: Array<[string,string]> = [];
        for(const o of orgs) for(const mid of o.members) if(!list.find((p:any)=>p.id===mid)) badList.push([o.id||'', mid]);
        const shown = badList.filter(([oid,mid])=>!isIgnored('org', mid) && !isIgnored('org', `${oid}:${mid}`));
        if (shown.length) warn('org',`${orgs.length} 个组织, ${totalMembers} 个成员, ${shown.length} 个无效引用${badRefsAll>shown.length?`（${badRefsAll-shown.length} 已登记豁免）`:''}`);
        else if (badRefsAll) { /* 全豁免，静默 */ }
        else ok('org',`${orgs.length} 个组织, ${totalMembers} 个成员`);
      }
      else ok('org',`${orgs.length} 个组织, ${totalMembers} 个成员`);
    }catch{ skip('org','无组织数据') }
  }

  // sync-binding
  {
    let syncOn = true;
    try { syncOn = !!JSON.parse(fs.readFileSync(path.join(PAIMON,'config','settings.json'),'utf8')).syncEnabled; } catch { syncOn = true; }
    if (!syncOn) { skip('sync-binding','同步已禁用 (syncEnabled=false)'); }
    else {
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
  }

  // sync-status
  {
    let syncOn = true;
    try { syncOn = !!JSON.parse(fs.readFileSync(path.join(PAIMON,'config','settings.json'),'utf8')).syncEnabled; } catch { syncOn = true; }
    if (!syncOn) { skip('sync-status','同步已禁用 (syncEnabled=false)'); }
    else {
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
  }

  // config
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

  // terminal-scrollback
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
    }
  }

  // disk
  {
    try{
      const du=execSync(`du -sh "${PAIMON}" 2>/dev/null`,{encoding:'utf8'}).trim().split(/\s/)[0];
      ok('disk',`总占用 ${du}`);
    }catch{ skip('disk','无法计算') }
  }

  console.log(`\n  ${passed} passed, ${failed} failed, ${warned} warned, ${skipped} skipped\n`);
}
