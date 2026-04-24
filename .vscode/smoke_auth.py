from app.auth import get_access_token

token = get_access_token()
print(f"token acquired, length={len(token)}, prefix={token[:40]}...")
