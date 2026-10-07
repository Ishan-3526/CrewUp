const express = require('express'), { Pool } = require('pg');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), path = require('path'), fs = require('fs');
const SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
if(!process.env.JWT_SECRET) console.warn('WARNING: JWT_SECRET not set. Using a random secret; logins reset on every restart.');
const ADMINS = (process.env.ADMIN_EMAILS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
const CATS = ['Music','Writing','Content','Coding','Art & Design','Film & Video','Games','Other'];

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set. Add a Postgres connection string (e.g. from Neon or Supabase).'); process.exit(1); }
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});

// --- Thin shim so the rest of the file reads like the original SQLite version ---
// Converts '?' placeholders to $1,$2..., and gives back { rows } via get/all,
// plus .run() returning { changes, lastInsertRowid } for INSERT ... RETURNING id.
function toPg(sql) { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }
const db = {
  prepare(sql) {
    const text = toPg(sql);
    return {
      get: async (...p) => (await pool.query(text, p)).rows[0],
      all: async (...p) => (await pool.query(text, p)).rows,
      run: async (...p) => { const r = await pool.query(text, p); return { changes: r.rowCount, lastInsertRowid: r.rows[0] ? r.rows[0].id : undefined }; }
    };
  },
  exec: (sql) => pool.query(sql)
};
// Insert-or-ignore a chat participant (conversation_id, user_id) is the primary key.
const addParticipant = (cid, uid) => pool.query('INSERT INTO conversation_participants(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [cid, uid]);

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Stored as TEXT in the same 'YYYY-MM-DD HH:MM:SS' UTC shape SQLite used, so the frontend's date parsing needs no changes.
const NOW = `to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')`;

async function setup() {
  await db.exec(`
CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, bio TEXT DEFAULT '', created TEXT DEFAULT ${NOW});
CREATE TABLE IF NOT EXISTS projects(id SERIAL PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, looking_for TEXT NOT NULL, status TEXT DEFAULT 'open', flagged INTEGER DEFAULT 0, created TEXT DEFAULT ${NOW});
CREATE TABLE IF NOT EXISTS applications(id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL, contact TEXT NOT NULL, status TEXT DEFAULT 'pending', created TEXT DEFAULT ${NOW}, UNIQUE(project_id,user_id));
CREATE INDEX IF NOT EXISTS idx_p_cat ON projects(category,status);

CREATE TABLE IF NOT EXISTS conversations(
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT,
  type TEXT DEFAULT 'direct',
  created TEXT DEFAULT ${NOW},
  updated TEXT DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS conversation_participants(
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id INTEGER DEFAULT 0,
  joined_at TEXT DEFAULT ${NOW},
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages(
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT DEFAULT '',
  file_url TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  file_type TEXT DEFAULT '',
  file_size INTEGER DEFAULT 0,
  created TEXT DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_conv_part ON conversation_participants(user_id);

CREATE TABLE IF NOT EXISTS message_reactions(
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created TEXT DEFAULT ${NOW},
  UNIQUE(message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_msg_react ON message_reactions(message_id);

CREATE TABLE IF NOT EXISTS reports(id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL, created TEXT DEFAULT ${NOW}, UNIQUE(project_id,user_id));
CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires BIGINT NOT NULL);
`);
}

const app = express();
app.use(express.json({limit:'25mb'}));
app.use('/uploads', (q,r,n) => { r.set({'X-Content-Type-Options':'nosniff','Content-Security-Policy':'sandbox; default-src \'none\'; img-src \'self\'; media-src \'self\''}); n() });
app.use(express.static(path.join(__dirname,'public')));

const isAdmin = async uid => { if(!uid) return false; const u = await db.prepare('SELECT email FROM users WHERE id=?').get(uid); return !!u && ADMINS.includes(u.email.toLowerCase()) };
const adminOnly = async (q,r,n) => (await isAdmin(q.user.id)) ? n() : r.status(403).json({error:'Admins only.'});
const wrap = f => async (q,r,n) => { try { await f(q,r,n) } catch(e){ console.error(e); if(!r.headersSent) r.status(500).json({error:'Something went wrong.'}) } };
const sign = u => jwt.sign({id:u.id,name:u.name}, SECRET, {expiresIn:'14d'});
const auth = (q,r,n) => { try { q.user = jwt.verify((q.headers.authorization||'').replace('Bearer ',''), SECRET); n() } catch { r.status(401).json({error:'Please sign in.'}) } };
const clean = (s,max=2000) => String(s||'').trim().slice(0,max);
const isUniqueViolation = e => e && e.code === '23505';

// rate limit (simple, in-memory) for auth routes
const hits = new Map();
const limit = (q,r,n) => { const k=q.ip, t=Date.now(), a=(hits.get(k)||[]).filter(x=>t-x<6e4); a.push(t); hits.set(k,a); a.length>20 ? r.status(429).json({error:'Too many attempts. Try again in a minute.'}) : n() };

// Group chat permission check: Only owner and accepted applicants can access project group chat
async function canAccessProjectChat(projectId, userId) {
  if (!projectId || !userId) return false;
  const p = await db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId);
  if (!p) return false;
  if (p.owner_id === userId) return true;
  const appRow = await db.prepare("SELECT 1 FROM applications WHERE project_id = ? AND user_id = ? AND status = 'accepted'").get(projectId, userId);
  return !!appRow;
}

// Real-time SSE subscriber registry
const sseClients = new Map();
async function notifyParticipants(conversationId, payload) {
  const parts = await db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ?').all(conversationId);
  const data = JSON.stringify({ conversationId, ...payload });
  for (const p of parts) {
    const set = sseClients.get(p.user_id);
    if (set) {
      for (const res of set) {
        try { res.write(`data: ${data}\n\n`) } catch (e) {}
      }
    }
  }
}

app.get('/api/categories', (q,r) => r.json(CATS));
app.post('/api/register', limit, wrap(async (q,r) => {
  const name=clean(q.body.name,60), email=clean(q.body.email,120).toLowerCase(), pw=String(q.body.password||'');
  if(!name||!/^\S+@\S+\.\S+$/.test(email)) return r.status(400).json({error:'Enter a name and a valid email.'});
  if(pw.length<8) return r.status(400).json({error:'Password needs at least 8 characters.'});
  if(await db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return r.status(409).json({error:'That email is already registered.'});
  const id = (await db.prepare('INSERT INTO users(name,email,pass) VALUES(?,?,?) RETURNING id').run(name,email,bcrypt.hashSync(pw,10))).lastInsertRowid;
  r.json({token:sign({id,name}), user:{id,name}});
}));
app.post('/api/login', limit, wrap(async (q,r) => {
  const u = await db.prepare('SELECT * FROM users WHERE email=?').get(clean(q.body.email,120).toLowerCase());
  if(!u || !bcrypt.compareSync(String(q.body.password||''), u.pass)) return r.status(401).json({error:'Wrong email or password.'});
  r.json({token:sign(u), user:{id:u.id,name:u.name}});
}));

app.get('/api/projects', wrap(async (q,r) => {
  const w=["p.status='open'","p.flagged=0"], a=[];
  if(CATS.includes(q.query.category)){ w.push('p.category=?'); a.push(q.query.category) }
  if(q.query.q){ w.push('(p.title ILIKE ? OR p.description ILIKE ? OR p.looking_for ILIKE ?)'); const s=`%${clean(q.query.q,80)}%`; a.push(s,s,s) }
  r.json(await db.prepare(`SELECT p.*, u.name owner_name, (SELECT COUNT(*) FROM applications WHERE project_id=p.id) applicants FROM projects p JOIN users u ON u.id=p.owner_id WHERE ${w.join(' AND ')} ORDER BY p.created DESC LIMIT 100`).all(...a));
}));
app.post('/api/projects', auth, wrap(async (q,r) => {
  const b=q.body, t=clean(b.title,120), d=clean(b.description,3000), l=clean(b.looking_for,500);
  if(!t||!d||!l||!CATS.includes(b.category)) return r.status(400).json({error:'Fill in every field and pick a category.'});
  const id = (await db.prepare('INSERT INTO projects(owner_id,title,category,description,looking_for) VALUES(?,?,?,?,?) RETURNING id').run(q.user.id,t,b.category,d,l)).lastInsertRowid;
  r.json({id});
}));
app.get('/api/projects/:id', wrap(async (q,r) => {
  const p = await db.prepare('SELECT p.*, u.name owner_name FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.id=?').get(q.params.id);
  if(!p) return r.status(404).json({error:'Project not found.'});
  let uid=null; try { uid = jwt.verify((q.headers.authorization||'').replace('Bearer ',''), SECRET).id } catch {}
  p.is_owner = uid===p.owner_id; p.is_admin = await isAdmin(uid);
  if(p.flagged && !p.is_owner && !p.is_admin) return r.status(404).json({error:'Project not found.'});
  p.can_access_group_chat = p.is_owner || (uid ? await canAccessProjectChat(p.id, uid) : false);

  if(p.is_owner || p.is_admin) p.applications = await db.prepare('SELECT a.*, u.name FROM applications a JOIN users u ON u.id=a.user_id WHERE project_id=? ORDER BY a.created DESC').all(p.id);
  else if(uid) p.my_application = (await db.prepare('SELECT status FROM applications WHERE project_id=? AND user_id=?').get(p.id,uid)) || null;
  r.json(p);
}));
app.post('/api/projects/:id/close', auth, wrap(async (q,r) => {
  const n = (await db.prepare("UPDATE projects SET status='closed' WHERE id=? AND owner_id=?").run(q.params.id,q.user.id)).changes;
  n ? r.json({ok:true}) : r.status(403).json({error:'Only the owner can close this.'});
}));
app.post('/api/projects/:id/apply', auth, wrap(async (q,r) => {
  const p = await db.prepare("SELECT * FROM projects WHERE id=? AND status='open'").get(q.params.id);
  if(!p) return r.status(404).json({error:'This project is closed.'});
  if(p.owner_id===q.user.id) return r.status(400).json({error:"You can't apply to your own project."});
  const m=clean(q.body.message,1000), c=clean(q.body.contact,200);
  if(!m||!c) return r.status(400).json({error:'Add a message and a way to reach you.'});
  try { await db.prepare('INSERT INTO applications(project_id,user_id,message,contact) VALUES(?,?,?,?)').run(p.id,q.user.id,m,c); r.json({ok:true}) }
  catch(e) { if(isUniqueViolation(e)) r.status(409).json({error:'You already applied to this project.'}); else throw e }
}));
app.patch('/api/applications/:id', auth, wrap(async (q,r) => {
  if(!['accepted','declined'].includes(q.body.status)) return r.status(400).json({error:'Invalid status.'});
  const appRow = await db.prepare('SELECT a.*, p.owner_id FROM applications a JOIN projects p ON p.id=a.project_id WHERE a.id=?').get(q.params.id);
  if(!appRow || appRow.owner_id !== q.user.id) return r.status(403).json({error:'Not allowed.'});

  await db.prepare('UPDATE applications SET status=? WHERE id=?').run(q.body.status, q.params.id);

  // If accepted, auto-add applicant to project team chat if it exists
  if (q.body.status === 'accepted') {
    const conv = await db.prepare("SELECT id FROM conversations WHERE project_id=? AND type='project'").get(appRow.project_id);
    if (conv) await addParticipant(conv.id, appRow.user_id);
  }
  r.json({ok:true});
}));
app.get('/api/me', auth, wrap(async (q,r) => r.json({
  projects: await db.prepare("SELECT p.*, (SELECT COUNT(*) FROM applications WHERE project_id=p.id) applicants FROM projects p WHERE owner_id=? ORDER BY created DESC").all(q.user.id),
  applications: await db.prepare("SELECT a.status, a.created, p.id project_id, p.title, p.category, u.name owner_name, CASE WHEN a.status='accepted' THEN (SELECT email FROM users WHERE id=p.owner_id) END owner_email, p.owner_id FROM applications a JOIN projects p ON p.id=a.project_id JOIN users u ON u.id=p.owner_id WHERE a.user_id=? ORDER BY a.created DESC").all(q.user.id)
})));

// --- FILE UPLOAD (Images, Audios, Attachments) ---
// Note: on most free hosts this disk is wiped on restart/redeploy. Fine for a demo; for production, use S3/R2/Cloudinary instead.
app.post('/api/upload', auth, (q, r) => {
  const allowed = ['.jpg','.jpeg','.png','.gif','.webp','.mp3','.wav','.ogg','.m4a','.aac','.flac','.webm','.mp4','.pdf','.zip','.txt'];

  if (q.is('application/json') && q.body && q.body.data) {
    try {
      const origName = clean(q.body.name || 'upload', 120);
      let ext = path.extname(origName).toLowerCase();
      if (!ext) ext = q.body.type === 'audio' ? '.webm' : '.png';
      if (!allowed.includes(ext)) return r.status(400).json({ error: 'File type not allowed.' });

      const isImage = ['.jpg','.jpeg','.png','.gif','.webp'].includes(ext);
      const isAudio = ['.mp3','.wav','.ogg','.m4a','.aac','.flac','.webm'].includes(ext);
      const fileType = isImage ? 'image' : (isAudio ? 'audio' : 'file');

      const base64Data = q.body.data.replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(base64Data, 'base64');
      if (buf.length > 30 * 1024 * 1024) return r.status(413).json({ error: 'File exceeds 30MB limit.' });

      const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buf);
      return r.json({
        url: `/uploads/${safeName}`,
        name: origName,
        type: fileType,
        size: buf.length
      });
    } catch (err) {
      console.error(err);
      return r.status(500).json({ error: 'Upload failed.' });
    }
  }

  const origName = clean(q.query.name || 'file', 120);
  let ext = path.extname(origName).toLowerCase();
  if (!ext) {
    const ct = q.headers['content-type'] || '';
    ext = ct.startsWith('audio/') ? '.webm' : (ct.startsWith('image/') ? '.png' : '.dat');
  }
  if (!allowed.includes(ext)) return r.status(400).json({ error: 'File type not allowed.' });

  const isImage = ['.jpg','.jpeg','.png','.gif','.webp'].includes(ext);
  const isAudio = ['.mp3','.wav','.ogg','.m4a','.aac','.flac','.webm'].includes(ext);
  const fileType = isImage ? 'image' : (isAudio ? 'audio' : 'file');

  const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const savePath = path.join(UPLOADS_DIR, safeName);
  const writeStream = fs.createWriteStream(savePath);

  let size = 0;
  const MAX = 30 * 1024 * 1024;
  let aborted = false;

  q.on('data', chunk => {
    size += chunk.length;
    if (size > MAX && !aborted) {
      aborted = true;
      writeStream.destroy();
      fs.unlink(savePath, () => {});
      r.status(413).json({ error: 'File exceeds 30MB limit.' });
    }
  });

  q.pipe(writeStream);
  writeStream.on('finish', () => {
    if (aborted) return;
    r.json({
      url: `/uploads/${safeName}`,
      name: origName,
      type: fileType,
      size: size
    });
  });
  writeStream.on('error', err => {
    console.error(err);
    if (!aborted) r.status(500).json({ error: 'Failed to write file.' });
  });
});

// --- CHAT & MESSAGING ROUTES ---
app.get('/api/conversations', auth, wrap(async (q, r) => {
  const rows = await db.prepare(`
    SELECT c.id, c.project_id, c.title, c.type, c.updated,
           p.title as project_title,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.id > cp.last_read_message_id AND m.sender_id != ?) as unread_count,
           (SELECT m.text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) as last_text,
           (SELECT m.file_type FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) as last_file_type,
           (SELECT m.file_name FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) as last_file_name,
           (SELECT m.created FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) as last_created,
           (SELECT u.name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) as last_sender_name
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    LEFT JOIN projects p ON p.id = c.project_id
    WHERE cp.user_id = ?
    ORDER BY c.updated DESC
  `).all(q.user.id, q.user.id);

  const getParts = db.prepare(`
    SELECT u.id, u.name, u.email FROM conversation_participants cp JOIN users u ON u.id = cp.user_id WHERE cp.conversation_id = ? AND cp.user_id != ?
  `);

  const validRows = [];
  for (const c of rows) {
    if (c.type === 'project') {
      if (!(await canAccessProjectChat(c.project_id, q.user.id))) continue;
      c.display_name = c.project_title ? `${c.project_title} (Crew)` : (c.title || 'Project Room');
    } else {
      c.other_participants = await getParts.all(c.id, q.user.id);
      c.display_name = c.other_participants.map(o => o.name).join(', ') || 'Direct Chat';
    }
    validRows.push(c);
  }

  r.json(validRows);
}));

app.post('/api/conversations', auth, wrap(async (q, r) => {
  const recipientId = q.body.recipient_id ? parseInt(q.body.recipient_id) : null;
  const projectId = q.body.project_id ? parseInt(q.body.project_id) : null;
  const type = q.body.type === 'project' ? 'project' : 'direct';

  if (type === 'project') {
    if (!projectId) return r.status(400).json({ error: 'Project ID is required.' });
    const p = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!p) return r.status(404).json({ error: 'Project not found.' });

    // CRITICAL: Strictly ensure user is owner or accepted crew member
    if (!(await canAccessProjectChat(projectId, q.user.id))) {
      return r.status(403).json({ error: 'Group chat is restricted to the project owner and accepted crew members only.' });
    }

    let conv = await db.prepare("SELECT id FROM conversations WHERE project_id = ? AND type = 'project'").get(projectId);
    if (!conv) {
      const title = p.title + ' Crew';
      const cid = (await db.prepare("INSERT INTO conversations(project_id, title, type) VALUES(?, ?, ?) RETURNING id").run(projectId, title, 'project')).lastInsertRowid;
      conv = { id: cid };
      await addParticipant(cid, p.owner_id);
    }
    await addParticipant(conv.id, q.user.id);
    return r.json({ id: conv.id });
  }

  // Personal 1-on-1 Messaging
  if (!recipientId) return r.status(400).json({ error: 'Recipient is required.' });
  if (recipientId === q.user.id) return r.status(400).json({ error: "You cannot message yourself." });
  const recipient = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(recipientId);
  if (!recipient) return r.status(404).json({ error: 'User not found.' });

  const existing = await db.prepare(`
    SELECT c.id FROM conversations c
    JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = ?
    JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = ?
    WHERE c.type = 'direct'
    LIMIT 1
  `).get(q.user.id, recipientId);

  if (existing) {
    if (projectId) {
      await db.prepare('UPDATE conversations SET project_id = COALESCE(project_id, ?) WHERE id = ?').run(projectId, existing.id);
    }
    await addParticipant(existing.id, q.user.id);
    await addParticipant(existing.id, recipientId);
    return r.json({ id: existing.id });
  }

  const cid = (await db.prepare("INSERT INTO conversations(project_id, type) VALUES(?, ?) RETURNING id").run(projectId, 'direct')).lastInsertRowid;
  await addParticipant(cid, q.user.id);
  await addParticipant(cid, recipientId);
  r.json({ id: cid });
}));


app.get('/api/conversations/:id', auth, wrap(async (q, r) => {
  const cid = parseInt(q.params.id);
  const c = await db.prepare(`
    SELECT c.*, p.title as project_title, p.category as project_category, p.owner_id as project_owner_id
    FROM conversations c
    LEFT JOIN projects p ON p.id = c.project_id
    WHERE c.id = ?
  `).get(cid);
  if (!c) return r.status(404).json({ error: 'Conversation not found.' });

  if (c.type === 'project') {
    if (!(await canAccessProjectChat(c.project_id, q.user.id))) {
      return r.status(403).json({ error: 'Group chat is restricted to the project owner and accepted crew members only.' });
    }
    await addParticipant(cid, q.user.id);
  } else {
    const part = await db.prepare('SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(cid, q.user.id);
    if (!part) return r.status(403).json({ error: 'Access denied.' });
  }

  if (c.type === 'project') {
    c.crew_members = await db.prepare(`
      SELECT u.id, u.name, u.email,
             CASE WHEN u.id = ? THEN 'Owner' ELSE 'Crew Member' END as role
      FROM users u
      WHERE u.id = ? OR u.id IN (SELECT user_id FROM applications WHERE project_id = ? AND status = 'accepted')
    `).all(c.project_owner_id, c.project_owner_id, c.project_id);
    c.participants = c.crew_members;
    c.display_name = c.project_title ? `${c.project_title} (Crew)` : (c.title || 'Project Room');
  } else {
    c.participants = await db.prepare('SELECT u.id, u.name, u.email FROM conversation_participants cp JOIN users u ON u.id = cp.user_id WHERE cp.conversation_id = ?').all(cid);
    c.other_participants = c.participants.filter(u => u.id !== q.user.id);
    c.display_name = c.other_participants.map(o => o.name).join(', ') || 'Direct Chat';
  }

  r.json(c);
}));

app.get('/api/conversations/:id/messages', auth, wrap(async (q, r) => {
  const cid = parseInt(q.params.id);
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid);
  if (!conv) return r.status(404).json({ error: 'Conversation not found.' });

  if (conv.type === 'project') {
    if (!(await canAccessProjectChat(conv.project_id, q.user.id))) {
      return r.status(403).json({ error: 'Access restricted to accepted crew members.' });
    }
  } else {
    const part = await db.prepare('SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(cid, q.user.id);
    if (!part) return r.status(403).json({ error: 'Access denied.' });
  }

  const msgs = await db.prepare(`
    SELECT m.*, u.name as sender_name
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ?
    ORDER BY m.id ASC
  `).all(cid);

  const getReactions = db.prepare(`
    SELECT emoji, COUNT(*) as count, STRING_AGG(u.name, ', ') as user_names,
           MAX(CASE WHEN mr.user_id = ? THEN 1 ELSE 0 END) as my_reaction
    FROM message_reactions mr
    JOIN users u ON u.id = mr.user_id
    WHERE mr.message_id = ?
    GROUP BY emoji
  `);

  for (const m of msgs) {
    m.reactions = await getReactions.all(q.user.id, m.id);
  }

  if (msgs.length > 0) {
    const lastId = msgs[msgs.length - 1].id;
    await db.prepare('UPDATE conversation_participants SET last_read_message_id = GREATEST(last_read_message_id, ?) WHERE conversation_id = ? AND user_id = ?').run(lastId, cid, q.user.id);
  }

  r.json(msgs);
}));

app.post('/api/conversations/:id/messages', auth, wrap(async (q, r) => {
  const cid = parseInt(q.params.id);
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid);
  if (!conv) return r.status(404).json({ error: 'Conversation not found.' });

  if (conv.type === 'project') {
    if (!(await canAccessProjectChat(conv.project_id, q.user.id))) {
      return r.status(403).json({ error: 'Access restricted to accepted crew members.' });
    }
    await addParticipant(cid, q.user.id);
  } else {
    const part = await db.prepare('SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(cid, q.user.id);
    if (!part) return r.status(403).json({ error: 'Access denied.' });
  }

  const text = clean(q.body.text, 5000);
  const fileUrl = clean(q.body.file_url, 500);
  const fileName = clean(q.body.file_name, 200);
  const fileType = clean(q.body.file_type, 50);
  const fileSize = Number(q.body.file_size) || 0;

  if (!text && !fileUrl) return r.status(400).json({ error: 'Message cannot be empty.' });

  const msgId = (await db.prepare(`
    INSERT INTO messages(conversation_id, sender_id, text, file_url, file_name, file_type, file_size)
    VALUES(?, ?, ?, ?, ?, ?, ?) RETURNING id
  `).run(cid, q.user.id, text, fileUrl, fileName, fileType, fileSize)).lastInsertRowid;

  await db.prepare(`UPDATE conversations SET updated = ${NOW} WHERE id = ?`).run(cid);
  await db.prepare('UPDATE conversation_participants SET last_read_message_id = GREATEST(last_read_message_id, ?) WHERE conversation_id = ? AND user_id = ?').run(msgId, cid, q.user.id);

  const newMsg = await db.prepare(`
    SELECT m.*, u.name as sender_name
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(msgId);
  newMsg.reactions = [];

  notifyParticipants(cid, { type: 'message', message: newMsg }).catch(console.error);
  r.json(newMsg);
}));

app.post('/api/messages/:id/react', auth, wrap(async (q, r) => {
  const msgId = parseInt(q.params.id);
  const emoji = clean(q.body.emoji, 12);
  if (!emoji) return r.status(400).json({ error: 'Emoji is required.' });

  const msg = await db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(msgId);
  if (!msg) return r.status(404).json({ error: 'Message not found.' });

  const existing = await db.prepare('SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(msgId, q.user.id, emoji);
  if (existing) {
    await db.prepare('DELETE FROM message_reactions WHERE id = ?').run(existing.id);
  } else {
    await db.prepare('INSERT INTO message_reactions(message_id, user_id, emoji) VALUES(?, ?, ?)').run(msgId, q.user.id, emoji);
  }

  const reactions = await db.prepare(`
    SELECT emoji, COUNT(*) as count, STRING_AGG(u.name, ', ') as user_names,
           MAX(CASE WHEN mr.user_id = ? THEN 1 ELSE 0 END) as my_reaction
    FROM message_reactions mr
    JOIN users u ON u.id = mr.user_id
    WHERE mr.message_id = ?
    GROUP BY emoji
  `).all(q.user.id, msgId);

  notifyParticipants(msg.conversation_id, { type: 'reaction', messageId: msgId, reactions }).catch(console.error);
  r.json({ ok: true, reactions });
}));

app.get('/api/unread-count', auth, wrap(async (q, r) => {
  const row = await db.prepare(`
    SELECT COUNT(*) as count
    FROM messages m
    JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
    WHERE cp.user_id = ?
      AND m.sender_id != ?
      AND m.id > cp.last_read_message_id
  `).get(q.user.id, q.user.id);
  r.json({ count: row ? Number(row.count) : 0 });
}));

app.get('/api/users', auth, wrap(async (q, r) => {
  const query = clean(q.query.q, 60);
  if (!query) {
    return r.json(await db.prepare(`SELECT id, name, bio, email FROM users WHERE id != ? ORDER BY id DESC LIMIT 50`).all(q.user.id));
  }
  const s = `%${query}%`;
  r.json(await db.prepare('SELECT id, name, bio, email FROM users WHERE id != ? AND (name ILIKE ? OR email ILIKE ?) LIMIT 50').all(q.user.id, s, s));
}));

app.get('/api/chats/stream', (q, r) => {
  let user = null;
  const tokenStr = q.query.token || (q.headers.authorization || '').replace('Bearer ', '');
  try { user = jwt.verify(tokenStr, SECRET) } catch (e) { return r.status(401).end() }

  r.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });
  r.write(': ping\n\n');

  if (!sseClients.has(user.id)) sseClients.set(user.id, new Set());
  sseClients.get(user.id).add(r);

  const pingInterval = setInterval(() => {
    try { r.write(': ping\n\n') } catch (e) { clearInterval(pingInterval) }
  }, 20000);

  q.on('close', () => {
    clearInterval(pingInterval);
    const set = sseClients.get(user.id);
    if (set) {
      set.delete(r);
      if (set.size === 0) sseClients.delete(user.id);
    }
  });
});


// --- REPORTS & ADMIN ---
app.get('/api/whoami', auth, wrap(async (q,r) => r.json({id:q.user.id, admin: await isAdmin(q.user.id)})));
app.post('/api/projects/:id/report', auth, wrap(async (q,r) => {
  const p = await db.prepare('SELECT owner_id FROM projects WHERE id=?').get(q.params.id);
  if(!p) return r.status(404).json({error:'Project not found.'});
  if(p.owner_id===q.user.id) return r.status(400).json({error:"You can't report your own project."});
  const reason = clean(q.body.reason,300); if(!reason) return r.status(400).json({error:'Add a reason.'});
  try { await db.prepare('INSERT INTO reports(project_id,user_id,reason) VALUES(?,?,?)').run(q.params.id,q.user.id,reason); r.json({ok:true}) }
  catch(e) { if(isUniqueViolation(e)) r.status(409).json({error:'You already reported this project.'}); else throw e }
}));
app.get('/api/admin/overview', auth, adminOnly, wrap(async (q,r) => {
  const projects = await db.prepare(`SELECT p.id,p.title,p.category,p.status,p.flagged,u.name owner_name,
    (SELECT COUNT(*) FROM reports WHERE project_id=p.id) report_count,
    (SELECT STRING_AGG(reason,' | ') FROM reports WHERE project_id=p.id) reasons
    FROM projects p JOIN users u ON u.id=p.owner_id ORDER BY p.created DESC LIMIT 200`).all();
  const n = async t => Number((await db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()).c);
  r.json({stats:{users:await n('users'),projects:await n('projects'),applications:await n('applications')}, reported:projects.filter(p=>Number(p.report_count)||p.flagged), projects});
}));
app.post('/api/admin/projects/:id/flag', auth, adminOnly, wrap(async (q,r) => { await db.prepare('UPDATE projects SET flagged=? WHERE id=?').run(q.body.flagged?1:0,q.params.id); r.json({ok:true}) }));
app.delete('/api/admin/projects/:id', auth, adminOnly, wrap(async (q,r) => { await db.prepare('DELETE FROM projects WHERE id=?').run(q.params.id); r.json({ok:true}) }));
app.delete('/api/admin/applications/:id', auth, adminOnly, wrap(async (q,r) => { await db.prepare('DELETE FROM applications WHERE id=?').run(q.params.id); r.json({ok:true}) }));


// --- PASSWORD RESET ---
const crypto = require('crypto'), sha = x => crypto.createHash('sha256').update(x).digest('hex');
async function makeResetLink(req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare('DELETE FROM password_resets WHERE user_id=? OR expires<?').run(userId, Date.now());
  await db.prepare('INSERT INTO password_resets VALUES(?,?,?)').run(sha(token), userId, Date.now() + 36e5);
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/#/reset/${token}`;
}
async function sendResetEmail(to, link) {
  if (!process.env.RESEND_API_KEY) { console.log(`[password reset] ${to}: ${link}`); return; }
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM || 'Crewup <onboarding@resend.dev>', to, subject: 'Reset your Crewup password',
        html: `<p>Click to reset your password (valid for 1 hour):</p><p><a href="${link}">${link}</a></p><p>If you didn't ask for this, ignore this email.</p>` }) });
    if (!r.ok) console.error('Email failed:', await r.text());
  } catch (e) { console.error('Email error', e.message); }
}
app.post('/api/forgot', limit, wrap(async (q, r) => {
  const email = clean(q.body.email, 120).toLowerCase();
  const u = await db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (u) await sendResetEmail(email, await makeResetLink(q, u.id));
  r.json({ ok: true }); // same answer whether or not the email exists
}));
app.post('/api/reset', limit, wrap(async (q, r) => {
  const pw = String(q.body.password || '');
  if (pw.length < 8) return r.status(400).json({ error: 'Password needs at least 8 characters.' });
  const row = await db.prepare('SELECT * FROM password_resets WHERE token_hash=?').get(sha(String(q.body.token || '')));
  if (!row || Number(row.expires) < Date.now()) return r.status(400).json({ error: 'This reset link is invalid or expired. Request a new one.' });
  await db.prepare('UPDATE users SET pass=? WHERE id=?').run(bcrypt.hashSync(pw, 10), row.user_id);
  await db.prepare('DELETE FROM password_resets WHERE user_id=?').run(row.user_id);
  r.json({ ok: true });
}));
app.post('/api/admin/reset-link', auth, adminOnly, wrap(async (q, r) => {
  const u = await db.prepare('SELECT id FROM users WHERE email=?').get(clean(q.body.email, 120).toLowerCase());
  if (!u) return r.status(404).json({ error: 'No user with that email.' });
  r.json({ link: await makeResetLink(q, u.id) });
}));

app.get('*', (q,r) => r.sendFile(path.join(__dirname,'public/index.html')));

setup()
  .then(() => app.listen(process.env.PORT||3000, () => console.log('CrewUp on http://localhost:'+(process.env.PORT||3000))))
  .catch(e => { console.error('Failed to set up the database:', e.message); process.exit(1); });
