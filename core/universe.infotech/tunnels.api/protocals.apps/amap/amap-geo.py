"""地理编码: 地址 → 坐标"""
import sys
from client import api

addr = sys.argv[1]
city = sys.argv[2] if len(sys.argv) > 2 else ''
data = api('geocode/geo', {'address': addr, 'city': city})
for g in data['geocodes']:
    print(f'{g["formatted_address"]}  =>  {g["location"]}')
