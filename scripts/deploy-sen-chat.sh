#!/usr/bin/env bash
# 步驟 3：設定 GEMINI_API_KEY 並部署 sen-chat Edge Function
set -euo pipefail
cd "$(dirname "$0")/.."

if ! npx supabase projects list >/dev/null 2>&1; then
  echo "尚未登入 CLI。請先執行："
  echo "  npx supabase login"
  exit 1
fi

npx supabase link --project-ref atbptsrpubmefyydgnde

GEMINI_API_KEY="$(python3 - <<'PY'
from pathlib import Path
for line in Path('.env.local').read_text().splitlines():
    if line.startswith('GEMINI_API_KEY='):
        print(line.split('=',1)[1].strip())
        break
PY
)"

if [ -z "$GEMINI_API_KEY" ]; then
  echo "找不到 .env.local 的 GEMINI_API_KEY"
  exit 1
fi

npx supabase secrets set "GEMINI_API_KEY=$GEMINI_API_KEY"
npx supabase functions deploy sen-chat --no-verify-jwt=false
echo "部署完成。前端請重新整理後試 AI 對話。"
