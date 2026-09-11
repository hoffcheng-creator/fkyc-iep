#!/usr/bin/env bash
# 將 .env.local 的 GEMINI_API_KEY 寫入 Supabase Function secrets
# 只接受 Google AI Studio 金鑰（通常以 AIza 開頭）
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="$(python3 - <<'PY'
from pathlib import Path
for line in Path('.env.local').read_text().splitlines():
    if line.startswith('GEMINI_API_KEY='):
        print(line.split('=',1)[1].strip().strip('"').strip("'"))
        break
PY
)"

if [ -z "$KEY" ]; then
  echo "❌ .env.local 沒有 GEMINI_API_KEY"
  exit 1
fi
if [[ "$KEY" != AIza* && "$KEY" != AQ.* ]]; then
  echo "❌ 而家呢條 key 唔似 Gemini key（應以 AIza 或 AQ. 開頭）。"
  echo "   請到 https://aistudio.google.com/apikey 開新 key，寫入 .env.local 後再跑。"
  exit 1
fi

npx supabase secrets set "GEMINI_API_KEY=$KEY" --project-ref atbptsrpubmefyydgnde
echo "✅ 已更新 Function secret。重新整理網頁再試 AI，唔使 redeploy。"
