#!/bin/bash
# Deploy script — chạy trên server để pull code mới và restart bot
# Usage: ./scripts/deploy.sh

set -e

cd "$(dirname "$0")/.."

echo "📦 Pulling latest code..."
git pull origin main

echo "📥 Installing dependencies..."
~/.bun/bin/bun install

echo "🔎 Typecheck + test..."
~/.bun/bin/bun run typecheck
~/.bun/bin/bun test

echo "🔄 Restarting bot..."
pm2 restart my-assistant --update-env
pm2 save

echo "✅ Deploy done!"
pm2 logs my-assistant --lines 10 --nostream
