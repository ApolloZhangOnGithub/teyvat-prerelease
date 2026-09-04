"""
高德 API 基础客户端
从 ~/.teyvat/UserAccount/services.json 读取 amap.apiKey
"""
import json, os, subprocess

def get_key():
    """Key 现在统一走 gateway + Keychain，此函数保留向后兼容"""
    return 'keychain'  # 实际调用走 gateway

def api(endpoint, params=None):
    """调用高德 API — 通过统一网关"""
    import sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from gateway import call
    if params is None: params = {}
    qs = '&'.join(f'{k}={v}' for k, v in params.items())
    url = f'https://restapi.amap.com/v3/{endpoint}'
    if qs: url += '?' + qs
    return call('amap', url)
