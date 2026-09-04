"""美团旅行助手 — 通过统一网关调用"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from gateway import call

API = 'https://mcp-open-cater.meituan.com/v1/api/voyage/openapi/query'

def query(city: str, question: str) -> dict:
    return call('meituan', API, body={'city': city, 'query': question}, method='POST')

if __name__ == '__main__':
    import sys
    city = sys.argv[1] if len(sys.argv) > 1 else '深圳'
    q = ' '.join(sys.argv[2:]) if len(sys.argv) > 2 else '推荐景点'
    result = query(city, q)
    print(json.dumps(result, indent=2, ensure_ascii=False))
