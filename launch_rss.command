#!/bin/bash

cd "$(dirname "$0")"

# Reach out to GitHub and save its response to a variable
UPDATE_MSG=$(git pull origin main)

if [ ! -f ".env" ] || [ ! -f "firebase-credentials.json" ]; then
    echo "🚨 STOP: Missing secret files!"
    exit 1
fi

if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

source venv/bin/activate

# Only run the slow package installer if Git actually downloaded something new!
if [[ "$UPDATE_MSG" != *"Already up to date."* ]]; then
    echo "📦 New code detected! Verifying packages (this will take a few seconds)..."
    pip install -r requirements.txt -q
fi

python main.py
