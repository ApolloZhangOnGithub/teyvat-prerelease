#!/bin/bash
# apps.build.sh — 扫描 app 目录，更新 apps.json 的 build/md5/tier
# 保留手编字段（icon, desc, homeRow, homeCol, handler, actions）
MOBILE_DIR="${1:-$(dirname "$0")}"
APPS_JSON="$MOBILE_DIR/apps.json"
node -e "
const fs=require('fs'),path=require('path'),cp=require('child_process');
const dir='$MOBILE_DIR', af='$APPS_JSON';
let old={}; try{old=JSON.parse(fs.readFileSync(af,'utf8'));}catch {}
const byDir={}; (old.apps||[]).forEach(a=>{byDir[a.dir||a.name]=a});
const apps=[];
for(const tier of ['apps']){
  const td=path.join(dir,tier);
  if(!fs.existsSync(td)) continue;
  for(const dirName of fs.readdirSync(td)){
    if(dirName.startsWith('.')||dirName.startsWith('@FUTURE.')||dirName.startsWith('@removed.')) continue;
    const ad=path.join(td,dirName);
    if(!fs.statSync(ad).isDirectory()) continue;
    const files=fs.readdirSync(ad).filter(f=>f.endsWith('.ts')&&!f.includes('.SPEC')&&!f.includes('.CHANGELOG')&&!f.includes('.test'));
    if(!files[0]) continue;
    const main=files.includes(dirName+'.ts')?dirName+'.ts':files[0];
    const tf=path.join(ad,main);
    const md5=cp.execSync('md5 -q '+JSON.stringify(tf),{encoding:'utf8'}).trim();
    const prev=byDir[dirName]||{};
    const build=(prev.md5===md5)?(prev.build||0):(prev.build||0)+1;
    const entry={name:prev.name||dirName,dir:dirName,tier,build,md5,file:main,handler:prev.handler||'code'};
    if(prev.icon) entry.icon=prev.icon;
    if(prev.desc) entry.desc=prev.desc;
    if(prev.homeRow!==undefined) entry.homeRow=prev.homeRow;
    if(prev.homeCol!==undefined) entry.homeCol=prev.homeCol;
    if(prev.actions) entry.actions=prev.actions;
    apps.push(entry);
  }
}
apps.sort((a,b)=>a.name.localeCompare(b.name));
fs.writeFileSync(af,JSON.stringify({generated:new Date().toISOString(),apps},null,2));
console.log('  apps.json: '+apps.length+' apps');
apps.forEach(a=>console.log('    '+a.name+':'+a.build+':'+a.md5.slice(0,8)));
" 2>&1
