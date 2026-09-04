"""amap app backend — 高德地图 API 调用"""
import subprocess, json, sys

KEY = 'c18a114cbf5cb6010e21f565b07dffee'

def api(endpoint, params=None):
    if params is None: params = {}
    params['key'] = KEY
    qs = '&'.join(f'{k}={v}' for k, v in params.items())
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
