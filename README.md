# CrewUp
Assemble your creative crew for any project — music, writing, content, coding, film, art & games.

**Stack:** Node.js + Express, **Postgres** (Neon/Supabase/any Postgres host), JWT auth + bcrypt, Server-Sent Events (SSE) real-time chat, file sharing (photos & audio), vanilla JS frontend.

## Run locally
```
npm install
cp .env.example .env   # fill in DATABASE_URL and JWT_SECRET
npm start              # http://localhost:3000
```
Needs Node 18+ and a Postgres database (see below).

## Get a free Postgres database
1. Create a free project at neon.com or supabase.com.
2. Copy the connection string it gives you (starts with `postgres://`).
3. Set it as `DATABASE_URL` — locally in `.env`, and on Render under **Environment**.
4. Tables are created automatically the first time the app starts. Nothing to run by hand.

Unlike SQLite on a free host's disk, this data survives restarts, redeploys, and the free-tier sleep/wake cycle.

## Features
- **Browse & Post Projects**: Filter by category, search keywords, post what you're making and who you need.
- **Applications & Crew Management**: Creators apply with a message and contact info. Owner accepts or declines.
- **Gated Group Chat**: Group/Team chats are strictly locked until the owner accepts the applicant. Only accepted crew members can access group discussions.
- **Direct 1-on-1 Messaging**: Fast direct chat with any creator or project owner.
- **Photo & Audio File Sharing**: Send photos with full-screen lightbox; send audio snippets with a custom player and playback speed controls.
- **Voice Note Recording**: One-click in-browser audio recording.
- **Message Reactions**: React to shared tracks, stems, and artwork with emojis.
- **Password reset**: "Forgot your password?" flow with time-limited email links.
- **Admin tools**: flag/unflag or delete any project, delete applications, and review user reports. Set `ADMIN_EMAILS` to grant it.

## Admin
Set `ADMIN_EMAILS=you@example.com` (comma-separated) in your environment, register with that email, and an **Admin** link appears.

## Password reset emails (optional)
Without `RESEND_API_KEY` set, reset links just print in the server log, and admins can hand out a link from the Admin page. To send real emails, get a free key at resend.com and set `RESEND_API_KEY`, `MAIL_FROM`, and `BASE_URL`.

## Notes
- Set `JWT_SECRET` in production, or everyone is logged out on every restart.
- Uploaded files (photos/audio) still live on local disk (`public/uploads`), which most free hosts wipe on restart. For production, point them at S3, Cloudflare R2, or Cloudinary instead.
