"""逆地理编码: 坐标 → 地址"""
import sys
from client import api

lon, lat = sys.argv[1], sys.argv[2]
data = api('geocode/regeo', {'location': f'{lon},{lat}'})
ac = data['regeocode']['addressComponent']
print(f'地址: {data["regeocode"]["formatted_address"]}')
print(f'省:   {ac.get("province","")}')
print(f'市:   {ac.get("city","") or ac.get("province","")}')
print(f'区:   {ac.get("district","")}')
print(f'街道: {ac.get("township","")}')
sn = ac.get('streetNumber', {})
if sn:
    print(f'门牌: {sn.get("street","")} {sn.get("number","")}')
