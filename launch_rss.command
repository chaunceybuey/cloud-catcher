#!/bin/bash

cd "$(dirname "$0")"

if [ ! -f ".env" ] || [ ! -f "firebase-credentials.json" ];
then
    echo "🚨 STOP: Missing secret files!"
    exit 1
fi

if [ ! -d "venv" ];
then
    python3 -m venv venv
fi

# 1. Enter the walled garden
source venv/bin/activate

# 2. Unpack the tools inside the garden (it skips this instantly if they are already installed)
pip install -r requirements.txt

# 3. Start the engine
python main.py