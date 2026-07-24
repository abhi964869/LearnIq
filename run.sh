#!/usr/bin/env bash
# LearnIQ AI — one-click local run (macOS/Linux)
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then python3 -m venv .venv; fi
source .venv/bin/activate
pip install -q -r requirements-dev.txt
echo "LearnIQ AI running at http://127.0.0.1:8000 (Ctrl+C to stop)"
cd api
python -m uvicorn index:app --host 127.0.0.1 --port 8000
