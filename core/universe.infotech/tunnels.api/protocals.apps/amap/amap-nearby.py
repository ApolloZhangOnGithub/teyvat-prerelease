"""周边搜索: 按坐标+关键词搜索POI"""
import sys
from client import api

lon, lat, kw = sys.argv[1], sys.argv[2], sys.argv[3]
radius = sys.argv[4] if len(sys.argv) > 4 else '1000'

data = api('place/around', {
    'location': f'{lon},{lat}',
    'keywords': kw,
    'radius': radius
})

pois = data.get('pois', [])
print(f'{data.get("count","?")} 个结果 (显示前10):')
for poi in pois[:10]:
    dist = poi.get('distance', '?')
    name = poi['name']
    addr = poi.get('address', '')
    print(f'  [{dist}m] {name} — {addr}')
