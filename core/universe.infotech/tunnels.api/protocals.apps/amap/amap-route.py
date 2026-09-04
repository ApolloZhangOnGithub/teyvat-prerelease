"""路线规划: 支持 walking/driving/transit"""
import argparse
from client import api

p = argparse.ArgumentParser()
p.add_argument('--origin', required=True, help='起点地址')
p.add_argument('--dest', required=True, help='终点地址')
p.add_argument('--mode', default='driving', choices=['walking','driving','transit'])
p.add_argument('--city', default='')
args = p.parse_args()

# 地理编码
o = api('geocode/geo', {'address': args.origin, 'city': args.city})
d = api('geocode/geo', {'address': args.dest, 'city': args.city})
ol = o['geocodes'][0]
dl = d['geocodes'][0]
print(f'起点: {ol["formatted_address"]} ({ol["location"]})')
print(f'终点: {dl["formatted_address"]} ({dl["location"]})\n')

# 路线
r = api(f'direction/{args.mode}', {'origin': ol['location'], 'destination': dl['location']})
paths = r['route']['paths']
names = {'walking': '🚶步行', 'driving': '🚗驾车', 'transit': '🚌公交'}
print(f'{names.get(args.mode, args.mode)}:')
for i, p in enumerate(paths[:2]):
    print(f'  方案{i+1}: {int(p["distance"])/1000:.1f}km, {int(p["duration"])//60}分钟')
    if args.mode == 'transit':
        print(f'    费用: {p.get("cost","?")}元')
