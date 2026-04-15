#!/bin/bash

cd "$(dirname "$0")"

if [ ! -f ".env" ] || [ ! -f "firebase-credentials.json" ]; then
    echo "🚨 STOP: Missing secret files!"
    exit 1
fi

if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

source venv/bin/activate

python main.py
