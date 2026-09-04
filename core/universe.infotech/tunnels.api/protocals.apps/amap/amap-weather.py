"""天气查询"""
import sys
from client import api

city = sys.argv[1] if len(sys.argv) > 1 else '440300'
data = api('weather/weatherInfo', {'city': city, 'extensions': 'all'})
for f in data['forecasts']:
    print(f'{f["city"]} ({f["reporttime"]})')
    for c in f['casts']:
        print(f'  {c["date"]} {c["week"]} | ☀{c["dayweather"]} {c["daytemp"]}°C {c["daywind"]}{c["daypower"]}级')
        print(f'          | 🌙{c["nightweather"]} {c["nighttemp"]}°C {c["nightwind"]}{c["nightpower"]}级')
