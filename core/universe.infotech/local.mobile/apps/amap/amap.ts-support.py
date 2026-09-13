"""amap app backend — 高德地图 API 调用"""
import subprocess, json, sys, os, urllib.parse

# 2026-09-13：API Key 不再硬编码进源码（原来的 key 已随仓库外泄，须在高德控制台轮换）。
# 读取顺序：~/.teyvat/UserAccount/services.json 的 amap.apiKey（README 所述的 /config 配置）→ 环境变量 AMAP_KEY。
def _load_key():
    try:
        with open(os.path.expanduser('~/.teyvat/UserAccount/services.json'), encoding='utf-8') as f:
            s = json.load(f)
        k = (s.get('amap') or {}).get('apiKey') or ((s.get('services') or {}).get('amap') or {}).get('apiKey')
        if k:
            return k
    except Exception:
        pass
    return os.environ.get('AMAP_KEY', '')

KEY = _load_key()

def api(endpoint, params=None):
    if params is None: params = {}
    if not KEY:
        return {'status': '0', 'info': 'amap.apiKey 未配置：用 /config 在 services.json 写入 amap.apiKey'}
    params['key'] = KEY
    qs = urllib.parse.urlencode(params)  # 2026-09-13：原手拼不编码，关键词含空格/&/# 时 curl 报 URL 非法
    r = subprocess.run(['curl', '-s', f'https://restapi.amap.com/v3/{endpoint}?{qs}'],
                       capture_output=True, text=True, timeout=10)
    return json.loads(r.stdout)

def nearby(keyword):
    d = api('place/around', {'location': '113.9716,22.5513', 'keywords': keyword, 'radius': 2000, 'offset': 10})
    if d['status'] != '1': return f'搜索失败: {d.get("info")}'
    lines = [f'附近{keyword} ({d.get("count",0)}个):']
    for p in d.get('pois', [])[:8]:
        lines.append(f'  [{p.get("distance","?")}m] {p["name"]}')
    return '\n'.join(lines)

def route(origin, dest, mode='transit'):
    o = api('geocode/geo', {'address': origin})['geocodes'][0]
    d = api('geocode/geo', {'address': dest})['geocodes'][0]
    r = api(f'direction/{mode}', {'origin': o['location'], 'destination': d['location']})
    if r['status'] != '1': return f'路线失败: {r.get("info")}'
    
    names = {'walking': '步行', 'driving': '驾车', 'transit': '公交', 'bicycling': '骑行'}
    p = r['route']['paths'][0]
    dist = int(p['distance']); dur = int(p['duration']) // 60
    lines = [f'{names.get(mode, mode)}: {dist/1000:.1f}km, {dur}分钟']
    
    if mode == 'transit':
        lines.append(f'费用: {p.get("cost","?")}元')
        for s in p.get('transits', [])[:5]:
            lines.append(f'  {s.get("departure_stop","")} → {s.get("arrival_stop","")} ({s.get("bus_name","")})')
    else:
        for s in p.get('steps', [])[:5]:
            inst = s.get('instruction', '')
            if inst: lines.append(f'  → {inst[:50]}')
    return '\n'.join(lines)

def weather(city='深圳'):
    d = api('weather/weatherInfo', {'city': city, 'extensions': 'all'})
    if d['status'] != '1': return f'天气失败: {d.get("info")}'
    lines = []
    for f in d['forecasts']:
        for c in f['casts'][:3]:
            lines.append(f'{c["date"]} | {c["dayweather"]} {c["daytemp"]}°C / {c["nightweather"]} {c["nighttemp"]}°C')
    return '\n'.join(lines)

if __name__ == '__main__':
    cmd, *args = sys.argv[1:]
    if cmd == 'near': print(nearby(' '.join(args) or '餐饮'))
    elif cmd == 'route': print(route(args[0], args[1], args[2] if len(args) > 2 else 'transit'))
    elif cmd == 'weather': print(weather(args[0] if args else '深圳'))
