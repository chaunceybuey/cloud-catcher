# RSS Triage PWA — Setup Guide

## 1. Get Your Firebase Config

Go to: Firebase Console → Project Settings → Your Apps → Web App
Copy the config object and paste it into `public/app.js` (top of file).

Also update `.firebaserc` with your project ID.

## 2. Enable Google Sign-In

Firebase Console → Authentication → Sign-in method → Google → Enable

## 3. Set Firebase Database Rules

Firebase Console → Realtime Database → Rules:

```json
{
  "rules": {
    "app_data": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}
```

## 4. Install Firebase CLI and Deploy

```bash
npm install -g firebase-tools
firebase login
cd pwa
firebase deploy
```

## 5. Open on Your Device

Visit the URL Firebase gives you (something like `your-project.web.app`).
On Chromebook/Android: tap browser menu → "Install app" or "Add to Home Screen".

## Features

- **Swipe left** on article card → Archive
- **Swipe right** on article card → Save/Bookmark
- **Tap** article card → Open reader
- **Swipe left/right** in reader → Next/Previous article
- **Bottom nav** → Switch between Feed and Audio views
- **Mode selector** → Unread / Saved / Archive
- **Feed filter** → Filter by feed source
