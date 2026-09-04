"""X API — 通过统一网关调用"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from gateway import call

BASE = 'https://api.x.com/2'

def me():
    return call('x', f'{BASE}/users/me?user.fields=name,username,public_metrics')

def user_by_name(username):
    return call('x', f'{BASE}/users/by/username/{username}?user.fields=name,public_metrics')

def user_tweets(user_id, limit=10):
    return call('x', f'{BASE}/users/{user_id}/tweets?max_results={limit}&tweet.fields=created_at,public_metrics')

def search_recent(query, limit=10):
    return call('x', f'{BASE}/tweets/search/recent?query={query}&max_results={limit}&tweet.fields=created_at,public_metrics')
