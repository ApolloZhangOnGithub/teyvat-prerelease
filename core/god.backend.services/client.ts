// 文档: B.docs/Dev.Common/Wiki/Services(God Level Support).WIKI
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { getBinding, type Binding } from "./binding.ts";
import { syncEndpoint } from "../paths.ts";

const PAIMON = join(homedir(), ".teyvat");
const USER_ACCOUNT = join(PAIMON, "UserAccount");
const RUNTIME_CACHE = join(PAIMON, "RuntimeCache");
const SHADOW_FILE = join(RUNTIME_CACHE, ".sync-shadow.json");
const LOG_DIR = join(PAIMON, "LogData");
const SYNC_LOG = join(LOG_DIR, "sync.log");
const SYNC_STATUS = join(LOG_DIR, "sync-status.json");

function syncLog(action: string, detail: string) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    appendFileSync(SYNC_LOG, `[${ts}] ${action}: ${detail}\n`);
  } catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
}

function saveSyncStatus(action: "pull" | "push", count: number, files: string[]) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(SYNC_STATUS, JSON.stringify({
      lastAction: action,
      lastAt: new Date().toISOString(),
      count,
      files: files.slice(0, 20),
    }, null, 2));
  } catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
}

const SYNC_DIRS = ["MemoryData", "SessionData", "IdentityData", "AppData", "MemoirData"];
const EXCLUDED_PATTERNS = [
  /\.log$/, /\.err\.log$/, /\.stream$/, /\.zst$/,
  /hippocampus-launch\.sh$/, /^hc-offset$/, /\.pid$/,
];

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function isExcluded(filename: string): boolean {
  return EXCLUDED_PATTERNS.some((p) => p.test(filename));
}

// 从文件路径提取 agent ID，如 MemoryData/ae41ee5f/context.md → ae41ee5f
function extractAgentId(filePath: string): string|null{
  const m=filePath.match(/^(MemoryData|SessionData|IdentityData|AppData|MemoirData)\/([a-f0-9]{8})\//);
  return m?m[2]:null;
}

function isArchived(personId: string): boolean {
  const plistPath = join(PAIMON, "MemoryData", "plist.json");
  try {
    const list = JSON.parse(readFileSync(plistPath, "utf8"));
    const entry = list.find((p: any) => p.id === personId);
    return entry?.archived === true;
  } catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); return false; }
}

export interface LocalFile {
  path: string;
  hash: string;
  size: number;
  mtimeMs?: number;
}

// 本地正在运行的 agent（main.pid 存活）—— 它们的文件正在被写，push 不完整数据会损坏远程
function getRunningAgents(): Set<string> {
  const running = new Set<string>();
  for (const dir of ["MemoryData", "SessionData", "IdentityData", "AppData"]) {
    const base = join(PAIMON, dir);
    try {
      for (const d of readdirSync(base, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const pidFile = join(base, d.name, "main.pid");
        try {
          const pid = parseInt(readFileSync(pidFile, "utf8").trim());
          try { process.kill(pid, 0); running.add(d.name); } catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
        } catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
      }
    } catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
  }
  return running;
}

export function scanSyncFiles(skipRunning = false): LocalFile[] {
  const files: LocalFile[] = [];
  const shadow = loadShadow();
  const running = skipRunning ? getRunningAgents() : null;

  // stat 元数据与 shadow 一致 → 未变，复用 hash 跳过读文件（增量扫描，ISSUE 075）
  const pushFile = (relPath: string, fp: string) => {
    const st = statSync(fp);
    const se = shadow[relPath];
    if (se && se.mtimeMs === st.mtimeMs && se.size === st.size) {
      files.push({ path: relPath, hash: se.hash, size: st.size, mtimeMs: st.mtimeMs });
      return;
    }
    const buf = readFileSync(fp);
    files.push({ path: relPath, hash: sha256(buf), size: buf.length, mtimeMs: st.mtimeMs });
  };

  // plist.json
  const plistPath = join(PAIMON, "MemoryData", "plist.json");
  if (existsSync(plistPath)) pushFile("MemoryData/plist.json", plistPath);

  // UserAccount (except binding.json)
  const uaDir = join(PAIMON, "UserAccount");
  if (existsSync(uaDir)) {
    for (const f of readdirSync(uaDir)) {
      if (f === "binding.json" || f === "api.log") continue;
      const fp = join(uaDir, f);
      if (!statSync(fp).isFile()) continue;
      pushFile(`UserAccount/${f}`, fp);
    }
  }

  // AgentWorkDir/Organizational (orgs.json etc. — shared org data)
  const orgDir = join(PAIMON, "AgentWorkDir", "Organizational");
  if (existsSync(orgDir)) {
    for (const f of readdirSync(orgDir)) {
      const fp = join(orgDir, f);
      if (!statSync(fp).isFile()) continue;
      pushFile(`AgentWorkDir/Organizational/${f}`, fp);
    }
  }

  // Per-agent *Data dirs
  for (const dir of SYNC_DIRS) {
    const base = join(PAIMON, dir);
    if (!existsSync(base)) continue;

    if (dir === "MemoirData") {
      for (const f of readdirSync(base)) {
        const fp = join(base, f);
        if (!statSync(fp).isFile()) continue;
        pushFile(`MemoirData/${f}`, fp);
      }
      continue;
    }

    for (const personId of readdirSync(base)) {
      if (personId === "plist.json") continue;
      const personDir = join(base, personId);
      if (!existsSync(personDir) || !statSync(personDir).isDirectory()) continue;
      if (isArchived(personId)) continue;
      if (running && running.has(personId)) continue; // 运行中 agent 不扫（push 本来也不推）

      const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const fp = join(d, entry.name);
          if (entry.isDirectory()) { walk(fp); continue; }
          if (isExcluded(entry.name)) continue;
          const relPath = relative(PAIMON, fp);
          pushFile(relPath, fp);
        }
      };
      walk(personDir);
    }
  }

  return files;
}

// ── Shadow manifest ──

interface ShadowEntry { hash: string; size: number; mtimeMs?: number }

function loadShadow(): Record<string, ShadowEntry> {
  try { return JSON.parse(readFileSync(SHADOW_FILE, "utf8")); } catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); return {}; }
}

function saveShadow(manifest: Record<string, ShadowEntry>) {
  mkdirSync(RUNTIME_CACHE, { recursive: true });
  writeFileSync(SHADOW_FILE, JSON.stringify(manifest));
}

// ── Sync operations ──

async function apiFetch(binding: Binding, path: string, init?: RequestInit) {
  const endpoint = syncEndpoint();
  return fetch(`${endpoint}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${binding.token}`,
      "X-Device-Id": binding.deviceId,
    },
  });
}

export async function pull(binding: Binding): Promise<{ pulled: number; tampered: string[]; pulledFiles: string[] }> {
  const res = await apiFetch(binding, "/manifest");
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);

  const { files: remote } = (await res.json()) as {
    files: Record<string, { hash: string; size: number; version: number }>;
  };

  const shadow = loadShadow();
  const local = scanSyncFiles();
  const localMap = new Map(local.map((f) => [f.path, f]));
  const tampered: string[] = [];

  for (const [path, entry] of Object.entries(shadow)) {
    const localFile = localMap.get(path);
    if (localFile && localFile.hash !== entry.hash) {
      tampered.push(path);
    }
  }

  const toPull: string[] = [];
  for (const [path, remoteEntry] of Object.entries(remote)) {
    const localFile = localMap.get(path);
    const shadowEntry = shadow[path];
    // 本地文件被修改过（hash ≠ shadow）→ 本地更新，不拉
    if (localFile && shadowEntry && localFile.hash !== shadowEntry.hash) continue;
    // 远程和本地一样 → 不需要拉
    if (localFile && localFile.hash === remoteEntry.hash) continue;
    // 本地没有 或 本地==shadow但远程不同 → 拉
    toPull.push(path);
  }

  if (toPull.length === 0) {
    saveShadow(Object.fromEntries(local.map((f) => [f.path, { hash: f.hash, size: f.size, mtimeMs: f.mtimeMs }])));
    return { pulled: 0, tampered, pulledFiles: [] };
  }

  let pulled = 0;
  const pulledFiles: string[] = [];
  const skippedLocal: string[] = [];
  const newShadow = { ...shadow };

  for (const [path] of Object.entries(remote)) {
    const localFile = localMap.get(path);
    const shadowEntry = shadow[path];
    if (localFile && shadowEntry && localFile.hash !== shadowEntry.hash) {
      skippedLocal.push(path);
    }
  }
  if (skippedLocal.length > 0) syncLog("pull-skip", `${skippedLocal.length} locally modified: ${skippedLocal.join(", ")}`);

  const PULL_BATCH = 50;
  for (let i = 0; i < toPull.length; i += PULL_BATCH) {
    const batch = toPull.slice(i, i + PULL_BATCH);
    const pullRes = await apiFetch(binding, "/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: batch }),
    });
    if (!pullRes.ok) throw new Error(`pull failed: ${pullRes.status}`);

    const { results } = (await pullRes.json()) as {
      results: Array<{ path: string; content?: string; hash?: string; error?: string }>;
    };

    for (const r of results) {
      if (r.error || !r.content) continue;
      const buf = Buffer.from(r.content, "base64");
      const hash = sha256(buf);
      if (r.hash && hash !== r.hash) {
        syncLog("pull-integrity-fail", r.path);
        continue;
      }
      const fp = join(PAIMON, r.path);
      mkdirSync(join(fp, ".."), { recursive: true });
      let merged=false;
      // 聚合文件必须 merge 而非覆盖（跨设备共享数据，覆盖 = 丢其他设备的内容）
      if(r.path==='MemoryData/plist.json'){
        const remoteList=JSON.parse(buf.toString('utf8'));
        let localList:any[]=[];
        try{ localList=JSON.parse(readFileSync(fp,'utf8')) }catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
        const localIds=new Set(localList.map((x:any)=>x.id));
        const localNames=new Set(localList.map((x:any)=>x.name));
        let changed=0;
        for(const rp of remoteList){
          if(!localIds.has(rp.id)&&!localNames.has(rp.name)){
            localList.push(rp); localIds.add(rp.id); localNames.add(rp.name); changed++;
          }
        }
        if(changed>0){ writeFileSync(fp,JSON.stringify(localList,null,2)); syncLog('pull-merge','plist.json +'+changed); merged=true }
      }else if(r.path==='AgentWorkDir/Organizational/orgs.json'){
        const remoteOrgs=JSON.parse(buf.toString('utf8'));
        let localOrgs:any[]=[];
        try{ localOrgs=JSON.parse(readFileSync(fp,'utf8')) }catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
        const orgMap=new Map(localOrgs.map((o:any)=>[o.id,o]));
        let changed=0;
        for(const ro of remoteOrgs){
          const lo=orgMap.get(ro.id);
          if(!lo){ localOrgs.push(ro); orgMap.set(ro.id,ro); changed++; }
          else{ const newMembers=ro.members.filter((m:string)=>!lo.members.includes(m)); if(newMembers.length){ lo.members.push(...newMembers); changed++; } }
        }
        if(changed>0){ writeFileSync(fp,JSON.stringify(localOrgs,null,2)); syncLog('pull-merge','orgs.json +'+changed); merged=true }
      }else if(r.path==='UserAccount/services.json'){
        const remoteSvc=JSON.parse(buf.toString('utf8'));
        let localSvc:any={};
        try{ localSvc=JSON.parse(readFileSync(fp,'utf8')) }catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
        let changed=0;
        for(const k of Object.keys(remoteSvc)){
          if(!(k in localSvc)){ localSvc[k]=remoteSvc[k]; changed++; }
        }
        if(changed>0){ writeFileSync(fp,JSON.stringify(localSvc,null,2)); syncLog('pull-merge','services.json +'+changed); merged=true }
      }else if(r.path==='UserAccount/settings.json'){
        const remoteSet=JSON.parse(buf.toString('utf8'));
        let localSet:any={};
        try{ localSet=JSON.parse(readFileSync(fp,'utf8')) }catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
        let changed=0;
        for(const k of Object.keys(remoteSet)){
          if(!(k in localSet)){ localSet[k]=remoteSet[k]; changed++; }
        }
        if(changed>0){ writeFileSync(fp,JSON.stringify(localSet,null,2)); syncLog('pull-merge','settings.json +'+changed); merged=true }
      }else{
        writeFileSync(fp, buf);
      }
      // merge 过的文件用本地真实 hash 更新 shadow，避免下次 sync 虚假 diff
      const finalBuf=merged?readFileSync(fp):buf;
      const finalHash=merged?sha256(finalBuf):hash;
      newShadow[r.path] = { hash: finalHash, size: finalBuf.length, mtimeMs: statSync(fp).mtimeMs };
      pulledFiles.push(r.path);
      pulled++;
    }
  }

  if (pulled > 0) syncLog("pull", `${pulled} files: ${pulledFiles.join(", ")}`);
  saveSyncStatus("pull", pulled, pulledFiles);
  saveShadow(newShadow);
  return { pulled, tampered, pulledFiles };
}

export async function push(binding: Binding): Promise<{ pushed: number; pushedFiles: string[] }> {
  const res = await apiFetch(binding, "/manifest");
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);

  const { files: remote } = (await res.json()) as {
    files: Record<string, { hash: string }>;
  };

  const local = scanSyncFiles(true);
  const shadow = loadShadow();
  // 检测本地正在运行的 agent：它们的文件正在被写，push 不完整数据会损坏远程
  const runningAgents=getRunningAgents();
  const toPush = local.filter((f) => {
    const remoteEntry = remote[f.path];
    // 本地被外部修改过（hash ≠ shadow）→ 不推送，防止损坏数据覆盖远程
    const se = shadow[f.path];
    if(se && f.hash !== se.hash){
      syncLog('push-skip-tampered', f.path);
      return false;
    }
    // 属于正在运行的 agent → 不推送（文件可能正在被写，不完整）
    const agentId=extractAgentId(f.path);
    if(agentId && runningAgents.has(agentId)){
      return false;
    }
    return !remoteEntry || remoteEntry.hash !== f.hash;
  });

  if (toPush.length === 0) {
    saveSyncStatus("push", 0, []);
    return { pushed: 0, pushedFiles: [] };
  }

  // 检查涉及 agent 的远程锁：被其他设备锁定的 agent 文件不推
  const pushAgentIds=new Set<string>();
  for(const f of toPush){ const aid=extractAgentId(f.path); if(aid) pushAgentIds.add(aid) }
  let lockedByRemote:Record<string,string>={};
  if(pushAgentIds.size>0){
    try{
      const lockRes=await apiFetch(binding,"/locks/batch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agentIds:[...pushAgentIds]})});
      if(lockRes.ok){ lockedByRemote=(await lockRes.json() as any).locked||{} }
    }catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
  }
  const skippedLocked=toPush.filter(f=>{ const aid=extractAgentId(f.path); return aid&&lockedByRemote[aid] });
  if(skippedLocked.length>0){
    syncLog('push-skip-locked',`${skippedLocked.length} files locked by other device: ${skippedLocked.map(f=>f.path).join(', ')}`);
  }
  const finalPush=toPush.filter(f=>{ const aid=extractAgentId(f.path); return !aid||!lockedByRemote[aid] });
  if(finalPush.length===0){
    saveSyncStatus("push", 0, []);
    return { pushed: 0, pushedFiles: [] };
  }

  const BATCH_SIZE = 20;
  let pushed = 0;
  const pushedFiles: string[] = [];

  const AGGREGATE=['MemoryData/plist.json','AgentWorkDir/Organizational/orgs.json','UserAccount/services.json','UserAccount/settings.json'];
  for (let i = 0; i < finalPush.length; i += BATCH_SIZE) {
    const batch = finalPush.slice(i, i + BATCH_SIZE);
    const form = new FormData();
    for (const f of batch) {
      let buf = readFileSync(join(PAIMON, f.path));
      if(AGGREGATE.includes(f.path)){
        try{
          const pullRes=await apiFetch(binding,"/pull",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({paths:[f.path]})});
          if(pullRes.ok){
            const {results}=await pullRes.json() as {results:Array<{path:string;content?:string}>};
            if(results[0]?.content){
              const remoteData=JSON.parse(Buffer.from(results[0].content,'base64').toString('utf8'));
              const localData=JSON.parse(buf.toString('utf8'));
              let merged=false;
              if(f.path==='MemoryData/plist.json'){
                const rIds=new Set(remoteData.map((x:any)=>x.id));
                const rNames=new Set(remoteData.map((x:any)=>x.name));
                for(const le of localData){ if(!rIds.has(le.id)&&!rNames.has(le.name)){ remoteData.push(le); merged=true } }
                const lIds=new Set(localData.map((x:any)=>x.id));
                const lNames=new Set(localData.map((x:any)=>x.name));
                for(const re of remoteData){ if(!lIds.has(re.id)&&!lNames.has(re.name)){ localData.push(re); merged=true } }
              }else{
                for(const k of Object.keys(localData)){ if(!(k in remoteData)){ remoteData[k]=localData[k]; merged=true } }
                for(const k of Object.keys(remoteData)){ if(!(k in localData)){ localData[k]=remoteData[k]; merged=true } }
              }
              if(merged){ writeFileSync(join(PAIMON,f.path),JSON.stringify(localData,null,2)); syncLog('push-merge',f.path); buf=readFileSync(join(PAIMON,f.path)) }
            }
          }
        }catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
      }
      form.append(f.path, new Blob([buf]));
    }
    const pushRes = await apiFetch(binding, "/push", { method: "POST", body: form });
    if (!pushRes.ok) throw new Error(`push failed: ${pushRes.status}`);
    pushed += batch.length;
    pushedFiles.push(...batch.map(f => f.path));
  }

  if (pushed > 0) syncLog("push", `${pushed} files: ${pushedFiles.join(", ")}`);
  saveSyncStatus("push", pushed, pushedFiles);

  const newShadow: Record<string, ShadowEntry> = {};
  for (const f of local) newShadow[f.path] = { hash: f.hash, size: f.size, mtimeMs: f.mtimeMs };
  saveShadow(newShadow);

  return { pushed, pushedFiles };
}

export interface PresenceDevice {
  personId: string;
  deviceId: string;
  since: string;
  heartbeat?: string;
}

export async function getPresence(binding: Binding): Promise<PresenceDevice[]> {
  const res = await apiFetch(binding, "/presence");
  if (!res.ok) throw new Error(`presence fetch failed: ${res.status}`);
  const data = (await res.json()) as { devices: PresenceDevice[] };
  return data.devices;
}

export function subscribePresence(
  binding: Binding,
  personId: string,
  onUpdate: (devices: PresenceDevice[]) => void,
): () => void {
  const endpoint = syncEndpoint();
  const wsUrl = endpoint
    .replace("https://", "wss://")
    .replace("http://", "ws://");
  const ws = new WebSocket(
    `${wsUrl}?token=${encodeURIComponent(binding.token)}&deviceId=${encodeURIComponent(binding.deviceId)}&personId=${encodeURIComponent(personId)}`,
  );
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "presence") {
        onUpdate(msg.devices as PresenceDevice[]);
      }
    } catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); }
  };
  ws.onerror = () => {};
  return () => { try { ws.close(); } catch (e) { console.error("[god.backend.services/client.ts] " + ((e as any)?.message || e)); } };
}

export async function acquireLock(binding: Binding, personId: string): Promise<{ ok: boolean; holder?: string }> {
  const res = await apiFetch(binding, `/lock/${personId}`, { method: "POST" });
  if (res.ok) return { ok: true };
  if (res.status === 409) {
    const data = (await res.json()) as { holder?: { deviceId: string } };
    return { ok: false, holder: data.holder?.deviceId };
  }
  throw new Error(`lock failed: ${res.status}`);
}

export async function releaseLock(binding: Binding, personId: string): Promise<void> {
  await apiFetch(binding, `/lock/${personId}`, { method: "DELETE" });
}

export async function heartbeatLock(binding: Binding, personId: string): Promise<boolean> {
  const res = await apiFetch(binding, `/lock/${personId}/heartbeat`, { method: "POST" });
  return res.ok;
}
