"""
API 统一网关 — Keychain + Token Bucket 限速 + 用量统计
"""
import json, os, subprocess, time, hashlib, base64, threading
from datetime import date

# ═══ Keychain ═══════════════════════════════════════
def kc_get(svc: str) -> str:
    r = subprocess.run(['security','find-generic-password','-a','genshin','-s',svc,'-w'],
        capture_output=True, text=True, timeout=5)
    if r.returncode != 0: raise RuntimeError(f'Keychain未配置: {svc}')
    return r.stdout.strip()

def kc_set(svc: str, val: str):
    subprocess.run(['security','delete-generic-password','-a','genshin','-s',svc], capture_output=True)
    subprocess.run(['security','add-generic-password','-a','genshin','-s',svc,'-w',val,'-U'], capture_output=True)

# ═══ Token Bucket 限速 ═════════════════════════════
class TokenBucket:
    def __init__(self, rate: float, burst: int = 1):
        self.rate = rate        # tokens/sec
        self.burst = burst      # max burst
        self.tokens = burst
        self.last = time.time()
        self.lock = threading.Lock()
    
    def acquire(self) -> float:
        """获取一个token，返回等待的秒数"""
        with self.lock:
            now = time.time()
            self.tokens = min(self.burst, self.tokens + (now - self.last) * self.rate)
            self.last = now
            if self.tokens >= 1:
                self.tokens -= 1
                return 0
            wait = (1 - self.tokens) / self.rate
            self.tokens = 0
            return wait

# ═══ 用量统计 ═══════════════════════════════════════
LOG_DIR = os.path.expanduser('~/.teyvat/LogData')
LOG_FILE = os.path.join(LOG_DIR, 'api_usage.json')
_stats_lock = threading.Lock()

def _load_stats() -> dict:
    os.makedirs(LOG_DIR, exist_ok=True)
    try:
        with open(LOG_FILE) as f: return json.load(f)
    except: return {}

def _save_stats(stats: dict):
    with open(LOG_FILE, 'w') as f: json.dump(stats, f, indent=2)

def record(service: str, ok: bool):
    with _stats_lock:
        stats = _load_stats()
        today = str(date.today())
        if today not in stats: stats[today] = {}
        if service not in stats[today]: stats[today][service] = {'ok':0,'fail':0}
        key = 'ok' if ok else 'fail'
        stats[today][service][key] += 1
        _save_stats(stats)

def stats_today() -> dict:
    return _load_stats().get(str(date.today()), {})

# ═══ 服务注册 ═══════════════════════════════════════
# fmt: {keychain_name, auth_type, rate/sec, burst, quota/day, extra}
SERVICES: dict[str, dict] = {
    'amap':          {'kc':'amap-key',           'auth':'param','param':'key','rate':30,'burst':10,'quota':3000000},
    'meituan':       {'kc':'meituan-key',        'auth':'header','header':'Authorization','rate':2,'burst':3,'quota':10000},
    'x':             {'kc':'x-bearer',           'auth':'Bearer','rate':2,'burst':5,'quota':50000},
    'twitterapi_io': {'kc':'tw-api-key',         'auth':'header','header':'x-api-key','rate':0.2,'burst':1,'quota':10000},
    'deepseek':      {'kc':'deepseek-key',       'auth':'Bearer','rate':5,'burst':10,'quota':50000},
    'qwen':          {'kc':'qwen-key',           'auth':'Bearer','rate':10,'burst':20,'quota':100000},
    'doubao-seed':   {'kc':'doubao-seed-key',    'auth':'Bearer','rate':10,'burst':20,'quota':100000},
    'doubao-voice':  {'kc':'doubao-voice-token', 'auth':'Bearer','rate':1,'burst':3,'quota':5000},
    'weread':        {'kc':'weread-key',         'auth':'Bearer','rate':1,'burst':3,'quota':1000},
    'brave':         {'kc':'brave-key',          'auth':'param','param':'apikey','rate':1,'burst':3,'quota':2000},
    'anna':          {'kc':'anna-key',           'auth':'Bearer','rate':0.5,'burst':2,'quota':1000},
}

_buckets: dict[str, TokenBucket] = {}

def _bucket(svc: str) -> TokenBucket:
    if svc not in _buckets:
        cfg = SERVICES[svc]
        _buckets[svc] = TokenBucket(rate=cfg['rate'], burst=cfg['burst'])
    return _buckets[svc]

# ═══ 统一调用 ═══════════════════════════════════════
def call(service: str, url: str, headers: dict = None,
         method: str = 'GET', body: dict = None, timeout: int = 15) -> dict:
    cfg = SERVICES.get(service)
    if not cfg: return {'error': f'未知服务: {service}'}
    
    # Token bucket 限速
    wait = _bucket(service).acquire()
    if wait > 0: time.sleep(wait)
    
    key = kc_get(cfg['kc'])
    cmd = ['curl', '-s']
    if cfg['auth'] == 'Bearer':
        cmd += ['-H', f'Authorization: Bearer {key}']
    elif cfg['auth'] == 'header':
        cmd += ['-H', f'{cfg["header"]}: {key}']
    elif cfg['auth'] == 'param':
        url += ('&' if '?' in url else '?') + f'{cfg["param"]}={key}'
    
    cmd += [url]
    if headers:
        for k, v in headers.items(): cmd += ['-H', f'{k}: {v}']
    if body:
        cmd += ['-d', json.dumps(body), '-H', 'Content-Type: application/json']
    
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    ok = r.returncode == 0 and r.stdout and 'error' not in r.stdout[:100].lower()
    record(service, ok)
    try: return json.loads(r.stdout) if r.stdout else {'error': r.stderr}
    except: return {'raw': r.stdout[:500] if r.stdout else r.stderr[:200]}

def usage():
    """今日用量"""
    return stats_today()
