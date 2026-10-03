# CrewUp
Assemble your creative crew for any project — music, writing, content, coding, film, art & games.

**Stack:** Node.js + Express, SQLite (better-sqlite3), JWT auth + bcrypt, Server-Sent Events (SSE) real-time chat, file sharing (photos & audio), vanilla JS frontend.

## Run
```
npm install
cp .env.example .env   # then set JWT_SECRET (or export JWT_SECRET=...)
npm start              # http://localhost:3000
```
Needs Node 18+.

## Features
- **Browse & Post Projects**: Filter by category, search keywords, post what you're making and who you need.
- **Applications & Crew Management**: Creators apply with portfolio message and contact. Owner accepts or declines.
- **Gated Group Chat**: Group/Team chats are strictly locked until the owner accepts the applicant. Only accepted crew members can access group discussions.
- **Direct 1-on-1 Messaging**: Fast direct chat with any creator or project owner.
- **Photo & Audio File Sharing**: Send photos with full-screen lightbox modal; send audio snippets (MP3, WAV, etc.) with custom player and playback speed controls.
- **Voice Note Recording**: One-click in-browser audio recording.
- **Message Reactions**: React to shared tracks, stems, and artwork with emojis.

# Crewup
