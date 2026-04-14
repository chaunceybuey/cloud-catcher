#!/bin/bash

# Move into the folder where this script is located
cd "$(dirname "$0")"

echo "📥 Checking GitHub for updates..."
git pull origin main

# Check if the secret files are missing
if [ ! -f ".env" ] || [ ! -f "firebase-credentials.json" ]; then
    echo "🚨 STOP: Missing secret files!"
    echo "Please put your .env and firebase-credentials.json in this folder."
    exit 1
fi

# Create a virtual environment if it doesn't exist yet
if [ ! -d "venv" ]; then
    echo "🛠️ Creating Python virtual environment..."
    python3 -m venv venv
fi

# Activate the environment and install packages
echo "📦 Loading packages..."
source venv/bin/activate
pip install -r requirements.txt -q

# Run the app
echo "🚀 Launching RSS Triage..."
python main.py
