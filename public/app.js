const $ = document.getElementById.bind(document), app = $('app');
let token = localStorage.getItem('t'), me = JSON.parse(localStorage.getItem('u') || 'null'), CATS = [];
let activeConvId = null, sseSource = null, unreadTotal = 0, stagedFile = null;
let mediaRecorder = null, audioChunks = [], recInterval = null, recSeconds = 0;
let pollTimer = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago = d => new Date(d.replace(' ','T')+'Z').toLocaleDateString(undefined,{month:'short',day:'numeric'});
const timeStr = d => new Date((d||'').replace(' ','T')+'Z').toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const formatBytes = b => !b ? '' : b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(1) + ' KB' : (b/1048576).toFixed(1) + ' MB';

function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.28);
  } catch(e){}
}

async function api(url, method='GET', body) {
  const r = await fetch('/api'+url, {method, headers:{'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{})}, body: body?JSON.stringify(body):undefined});
  const j = await r.json().catch(()=>({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
}

async function uploadFileApi(file) {
  const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: file
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Upload failed');
  return j;
}

function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2500) }
function setAuth(d){ token=d.token; me=d.user; localStorage.setItem('t',token); localStorage.setItem('u',JSON.stringify(me)); initSSE(); fetchUnread(); }
function logout(){ token=me=null; activeConvId=null; if(sseSource){sseSource.close();sseSource=null;} if(pollTimer){clearInterval(pollTimer);pollTimer=null;} localStorage.clear(); location.hash='#/'; nav(); }

function nav(){
  $('nav').innerHTML = me
    ? `<a href="#/">Browse</a><a href="#/new">Post a project</a><a href="#/chats" id="nav-chats" style="font-weight:700;color:var(--forest)">💬 Chat <span class="nav-badge ${unreadTotal>0?'':'hidden'}" id="chat-badge">${unreadTotal}</span></a><a href="#/me">${esc(me.name)}</a><a href="#" id="lo">Sign out</a>`
    : `<a href="#/">Browse</a><a href="#/chats" style="font-weight:700">💬 Chat</a><a href="#/login">Sign in</a><a class="btn sm" href="#/register">Join</a>`;
  const lo=$('lo'); if(lo) lo.onclick=e=>{e.preventDefault();logout()}
}

async function fetchUnread(){
  if (!token) return;
  try {
    const res = await api('/unread-count');
    unreadTotal = res.count || 0;
    const b = $('chat-badge');
    if (b) {
      b.textContent = unreadTotal;
      b.classList.toggle('hidden', unreadTotal === 0);
    }
  } catch(e){}
}

function initSSE(){
  if (!token) {
    if (sseSource) { sseSource.close(); sseSource = null; }
    return;
  }
  if (sseSource) return;
  try {
    sseSource = new EventSource('/api/chats/stream?token=' + encodeURIComponent(token));
    sseSource.onmessage = e => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'message') {
          fetchUnread();
          if (activeConvId && Number(activeConvId) === Number(data.conversationId)) {
            appendChatMessage(data.message);
            api(`/conversations/${activeConvId}/messages`).catch(()=>{});
          } else {
            playChime();
            toast(`💬 New message from ${data.message.sender_name}`);
          }
          if (location.hash.startsWith('#/chats')) refreshConvList();
        } else if (data.type === 'reaction') {
          if (activeConvId && Number(activeConvId) === Number(data.conversationId)) {
            updateMessageReactions(data.messageId, data.reactions);
          }
        }
      } catch(err){}
    };
    sseSource.onerror = () => {
      if (sseSource) sseSource.close();
      sseSource = null;
      setTimeout(initSSE, 6000);
    };
  } catch(e){}
}

function openLightbox(url, name){
  const box = $('lightbox');
  box.innerHTML = `
    <div class="lightbox-overlay" id="lb-ov">
      <div class="lightbox-content">
        <img src="${esc(url)}" class="lightbox-img" alt="${esc(name)}">
        <div class="lightbox-bar">
          <span>${esc(name)}</span>
          <a href="${esc(url)}" download="${esc(name)}" target="_blank">⬇ Download</a>
          <button id="lb-close">✕ Close</button>
        </div>
      </div>
    </div>`;
  const close = () => { box.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  $('lb-ov').onclick = e => { if (e.target.id === 'lb-ov' || e.target.id === 'lb-close') close(); };
  $('lb-close').onclick = close;
  document.addEventListener('keydown', onKey);
}

const card = p => `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <h3><a href="#/p/${p.id}" style="color:inherit;text-decoration:none">${esc(p.title)}</a></h3>
      <span class="status ${p.status}">${p.status}</span>
    </div>
    <div class="meta">${esc(p.category)} · by ${esc(p.owner_name)} · ${ago(p.created)} · ${p.applicants} applied</div>
    <p>${esc(p.description.slice(0,180))}${p.description.length>180?'…':''}</p>
    <div class="want"><b>Looking for:</b> ${esc(p.looking_for)}</div>
    <div class="row" style="margin-top:14px">
      <a class="btn sm" href="#/p/${p.id}">View Project</a>
      ${me && me.id === p.owner_id
        ? `<button class="btn ghost sm" onclick="event.preventDefault();startProjectChat(${p.id})">👥 Crew Chat (Owner)</button>`
        : `<button class="btn ghost sm" onclick="event.preventDefault();startDirectChat(${p.owner_id},${p.id})">💬 Chat with ${esc(p.owner_name)}</button>`
      }
    </div>
  </div>`;

async function home(){
  let cat = '', q = '';
  app.innerHTML = `<section class="hero"><h1>Got a project? Assemble your crew.</h1>
    <p>Musicians, writers, creators and coders post what they're building and who they need. Pick a category, say what you're after, and get in touch.</p>
    <a class="btn" href="#/new">Post a project</a></section>
    <div class="chips" id="chips"></div><div class="bar"><input id="q" placeholder="Search guitarist, comedy script, React…" aria-label="Search"></div><div id="list"></div>`;
  const load = async () => {
    const qs = new URLSearchParams({category:cat, q}); const list = await api('/projects?'+qs);
    $('list').innerHTML = list.length ? list.map(card).join('') : `<p class="empty">No open projects here yet. Be the first to post one.</p>`;
  };
  const chips = () => { $('chips').innerHTML = ['All',...CATS].map(c=>`<button class="chip ${(c==='All'?'':c)===cat?'on':''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
    document.querySelectorAll('.chip').forEach(b=>b.onclick=()=>{cat=b.dataset.c==='All'?'':b.dataset.c; chips(); load()}) };
  let t; $('q').oninput = e => { clearTimeout(t); t=setTimeout(()=>{q=e.target.value; load()},250) };
  chips(); load();
}

function authPage(mode){
  const reg = mode==='register';
  app.innerHTML = `<div class="form"><h2>${reg?'Create your account':'Welcome back'}</h2><form id="f">
    ${reg?'<label>Name</label><input name="name" required maxlength="60">':''}
    <label>Email</label><input name="email" type="email" required>
    <label>Password</label><input name="password" type="password" required minlength="8">
    <div class="err" id="e"></div><button class="btn">${reg?'Join CrewUp':'Sign in'}</button></form></div>`;
  $('f').onsubmit = async e => { e.preventDefault();
    try { setAuth(await api(reg?'/register':'/login','POST',Object.fromEntries(new FormData(e.target)))); nav(); location.hash = '#/'; }
    catch(x){ $('e').textContent = x.message } };
}

function newProject(){
  if(!me) return location.hash='#/login';
  app.innerHTML = `<div class="form"><h2>Post a project</h2><form id="f">
    <label>Category</label><select name="category">${CATS.map(c=>`<option>${esc(c)}</option>`).join('')}</select>
    <label>Project title</label><input name="title" required maxlength="120" placeholder="Indie folk EP needs a lead guitarist">
    <label>What are you making?</label><textarea name="description" required maxlength="3000"></textarea>
    <label>Who do you need?</label><input name="looking_for" required maxlength="500" placeholder="Someone who can play lead guitar, fingerstyle preferred">
    <div class="err" id="e"></div><button class="btn">Publish project</button></form></div>`;
  $('f').onsubmit = async e => { e.preventDefault();
    try { const r = await api('/projects','POST',Object.fromEntries(new FormData(e.target))); toast('Published'); location.hash='#/p/'+r.id }
    catch(x){ $('e').textContent = x.message } };
}

async function startDirectChat(userId, projectId){
  if (!me) return location.hash='#/login';
  try {
    const res = await api('/conversations', 'POST', { recipient_id: Number(userId), project_id: projectId ? Number(projectId) : null });
    location.hash = '#/chats/' + res.id;
  } catch(e) { toast(e.message); }
}

async function startProjectChat(projectId){
  if (!me) return location.hash='#/login';
  try {
    const res = await api('/conversations', 'POST', { project_id: Number(projectId), type: 'project' });
    location.hash = '#/chats/' + res.id;
  } catch(e) { toast(e.message); }
}

async function project(id){
  const p = await api('/projects/'+id);
  let html = `<h2>${esc(p.title)}</h2><div class="meta">${esc(p.category)} · by ${esc(p.owner_name)} · ${ago(p.created)}${p.status==='closed'?' · closed':''}</div>
    <p style="white-space:pre-wrap">${esc(p.description)}</p><div class="want"><b>Looking for:</b> ${esc(p.looking_for)}</div>`;

  // Dedicated Chat & Collaboration Card
  let chatActionHtml = `
    <div class="card" style="background:var(--card);border-left:4px solid var(--forest);margin-top:24px;padding:20px">
      <h3 style="margin-bottom:8px">💬 Chat & Collaboration</h3>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:12px">
        ${!p.is_owner ? `<button class="btn sm" id="btn-owner-chat">💬 Start 1-on-1 Personal Chat with ${esc(p.owner_name)}</button>` : ''}
        ${p.is_owner ? `
          <button class="btn sm" id="btn-project-chat">👥 Open Project Crew Group Chat</button>
        ` : (p.can_access_group_chat ? `
          <button class="btn sm" id="btn-project-chat">👥 Enter Crew Group Chat (✓ Accepted Member)</button>
        ` : (p.my_application ? `
          <span class="chat-locked-notice">🔒 Crew Group Chat is locked (Pending owner acceptance)</span>
        ` : `
          <span class="chat-locked-notice">🔒 Crew Group Chat is locked (Apply and get accepted to join)</span>
        `))}
      </div>
    </div>`;

  html += chatActionHtml;

  if (p.is_owner) {
    html += `<h3 style="margin-top:32px">Applicants (${p.applications.length})</h3>` + (p.applications.map(a=>`<div class="card"><b>${esc(a.name)}</b> <span class="status ${a.status}">${a.status}</span>
      <p>${esc(a.message)}</p><div class="meta">Reach them at: ${esc(a.contact)}</div>
      <div class="row">
        ${a.status !== 'accepted' ? `<button class="btn sm" data-a="${a.id}" data-s="accepted">Accept</button>` : ''}
        ${a.status !== 'declined' ? `<button class="btn ghost sm" data-a="${a.id}" data-s="declined">Decline</button>` : ''}
        <button class="btn sm" data-chat-user="${a.user_id}">💬 Message ${esc(a.name)}</button>
      </div></div>`).join('') || '<p class="empty">No applicants yet.</p>');
    if (p.status==='open') html += `<button class="btn ghost" id="close" style="margin-top:20px">Close this project</button>`;
  } else if (p.status==='open') {
    if (p.my_application) html += `<p class="row"><span class="status ${p.my_application.status}">Your application: ${p.my_application.status}</span></p>`;
    else html += `<h3 style="margin-top:32px">Apply</h3><form class="form" id="f"><label>Why you're a fit</label><textarea name="message" required maxlength="1000"></textarea>
      <label>How should they reach you?</label><input name="contact" required maxlength="200" placeholder="Email, Discord, Instagram…">
      <div class="err" id="e"></div><button class="btn">Send application</button></form>`;
  }
  app.innerHTML = html;

  if ($('btn-project-chat')) $('btn-project-chat').onclick = () => startProjectChat(p.id);
  if ($('btn-owner-chat')) $('btn-owner-chat').onclick = () => startDirectChat(p.owner_id, p.id);

  if ($('f')) $('f').onsubmit = async e => { e.preventDefault();
    if(!me){ location.hash='#/login'; return }
    try { await api(`/projects/${id}/apply`,'POST',Object.fromEntries(new FormData(e.target))); toast('Application sent'); project(id) }
    catch(x){ $('e').textContent = x.message } };
  document.querySelectorAll('[data-a]').forEach(b=>b.onclick=async()=>{ await api('/applications/'+b.dataset.a,'PATCH',{status:b.dataset.s}); toast('Updated'); project(id) });
  document.querySelectorAll('[data-chat-user]').forEach(b=>b.onclick=()=>startDirectChat(b.dataset.chatUser, p.id));
  if ($('close')) $('close').onclick = async()=>{ await api(`/projects/${id}/close`,'POST'); toast('Closed'); project(id) };
}


async function dash(){
  if(!me) return location.hash='#/login';
  const d = await api('/me');
  app.innerHTML = `<h2>Your projects</h2>` + (d.projects.map(p => `
    <div class="card">
      <h3><a href="#/p/${p.id}" style="color:inherit;text-decoration:none">${esc(p.title)}</a></h3>
      <div class="meta">${esc(p.category)} · ${ago(p.created)} · ${p.applicants} applied</div>
      <div class="row">
        <a class="btn sm" href="#/p/${p.id}">Manage Project</a>
        <button class="btn ghost sm" data-dash-team="${p.id}">👥 Crew Chat</button>
      </div>
    </div>`).join('') || '<p class="empty">You haven\'t posted anything yet.</p>') +
    `<h2 style="margin-top:40px">Your applications</h2>` + (d.applications.map(a=>`
    <div class="card">
      <h3><a href="#/p/${a.project_id}" style="color:inherit;text-decoration:none">${esc(a.title)}</a></h3>
      <div class="meta">${esc(a.category)} · by ${esc(a.owner_name)}</div>
      <p><span class="status ${a.status}">${a.status}</span>
      ${a.owner_email?` · Accepted! Email: <b>${esc(a.owner_email)}</b>`:''}</p>
      <div class="row">
        <button class="btn sm" data-dash-owner="${a.owner_id}" data-pid="${a.project_id}">💬 Message Owner</button>
        ${a.status === 'accepted' ? `<button class="btn ghost sm" data-dash-team="${a.project_id}">👥 Crew Chat</button>` : ''}
      </div>
    </div>`).join('') || '<p class="empty">Find a project to join on the browse page.</p>');

  document.querySelectorAll('[data-dash-owner]').forEach(b => {
    b.onclick = () => startDirectChat(b.dataset.dashOwner, b.dataset.pid);
  });
  document.querySelectorAll('[data-dash-team]').forEach(b => {
    b.onclick = () => startProjectChat(b.dataset.dashTeam);
  });
}

// --- CHAT PAGE ---
let cachedConversations = [];

async function refreshConvList(filterQ = ''){
  try {
    cachedConversations = await api('/conversations');
    renderConvList(cachedConversations, filterQ);
  } catch(e){}
}

function renderConvList(conversations, filterQ = ''){
  const list = $('conv-list');
  if (!list) return;
  const filtered = filterQ
    ? conversations.filter(c => (c.display_name||'').toLowerCase().includes(filterQ.toLowerCase()) || (c.project_title||'').toLowerCase().includes(filterQ.toLowerCase()))
    : conversations;

  if (!filtered.length) {
    list.innerHTML = `<li style="padding:20px;text-align:center;color:var(--muted);font-size:0.9rem">No conversations found.</li>`;
    return;
  }

  list.innerHTML = filtered.map(c => {
    const isAct = activeConvId && Number(activeConvId) === Number(c.id);
    const initial = (c.type === 'project' ? '👥' : (c.display_name || '?')[0].toUpperCase());
    let snippet = esc(c.last_text || '');
    if (c.last_file_type === 'image') snippet = '📷 Photo: ' + esc(c.last_file_name || 'image');
    else if (c.last_file_type === 'audio') snippet = '🎵 Audio: ' + esc(c.last_file_name || 'track');
    else if (c.last_file_type === 'file') snippet = '📎 ' + esc(c.last_file_name || 'file');
    if (!snippet) snippet = 'Started a conversation';

    return `<a class="chat-conv-item ${isAct ? 'active' : ''}" href="#/chats/${c.id}">
      <div class="avatar ${c.type==='project'?'project':''}">${initial}</div>
      <div class="chat-conv-info">
        <div class="chat-conv-top">
          <div class="chat-conv-name">${esc(c.display_name)}</div>
          <div class="chat-conv-time">${c.last_created ? timeStr(c.last_created) : ''}</div>
        </div>
        <div class="chat-conv-snippet">
          <span style="overflow:hidden;text-overflow:ellipsis">${snippet}</span>
          ${c.unread_count > 0 ? `<span class="chat-conv-badge">${c.unread_count}</span>` : ''}
        </div>
      </div>
    </a>`;
  }).join('');
}

function appendChatMessage(m){
  const box = $('chat-msgs');
  if (!box) return;
  if ($('msg-' + m.id)) return; // Deduplication check!

  const isMine = m.sender_id === me.id;
  const div = document.createElement('div');
  div.id = 'msg-' + m.id;
  div.className = `chat-msg ${isMine ? 'mine' : 'theirs'}`;
  div.innerHTML = renderMessageHtml(m, isMine);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  setupAudioPlayers(div);
}

function updateMessageReactions(msgId, reactions){
  const wrapper = document.querySelector(`#msg-${msgId} .reactions-list`);
  if (!wrapper) return;
  wrapper.innerHTML = renderReactionsHtml(msgId, reactions);
  bindReactionPills(wrapper);
}

function renderReactionsHtml(msgId, reactions){
  if (!reactions || !reactions.length) return '';
  return reactions.map(r => `
    <button type="button" class="reaction-pill ${r.my_reaction ? 'reacted' : ''}" data-msg-id="${msgId}" data-emoji="${esc(r.emoji)}" title="${esc(r.user_names||'')}">
      <span>${esc(r.emoji)}</span>
      <span>${r.count}</span>
    </button>`).join('');
}

function renderMessageHtml(m, isMine){
  let mediaHtml = '';
  if (m.file_url) {
    if (m.file_type === 'image') {
      mediaHtml = `
        <div class="chat-img-attachment" data-img-url="${esc(m.file_url)}" data-img-name="${esc(m.file_name||'photo')}">
          <img src="${esc(m.file_url)}" alt="${esc(m.file_name||'photo')}" loading="lazy">
          <div class="chat-file-footer">
            <span>📷 ${esc(m.file_name||'Image')}</span>
            <span>${formatBytes(m.file_size)}</span>
          </div>
        </div>`;
    } else if (m.file_type === 'audio') {
      mediaHtml = `
        <div class="chat-audio-attachment">
          <div class="chat-audio-header">
            <span class="chat-audio-icon">🎵</span>
            <div class="chat-audio-title">${esc(m.file_name||'Audio snippet')}</div>
            <div class="chat-audio-meta">${formatBytes(m.file_size)}</div>
          </div>
          <audio controls preload="metadata" src="${esc(m.file_url)}" class="chat-audio-player"></audio>
          <div class="audio-controls-row">
            <a href="${esc(m.file_url)}" download="${esc(m.file_name||'audio.webm')}" class="chat-audio-download">⬇ Download</a>
            <div class="speed-btn-group">
              <button type="button" class="speed-btn active" data-speed="1">1x</button>
              <button type="button" class="speed-btn" data-speed="1.25">1.25x</button>
              <button type="button" class="speed-btn" data-speed="1.5">1.5x</button>
              <button type="button" class="speed-btn" data-speed="2">2x</button>
            </div>
          </div>
        </div>`;
    } else {
      mediaHtml = `
        <div class="chat-file-footer" style="border-radius:6px;padding:8px">
          <span>📎 <a href="${esc(m.file_url)}" download="${esc(m.file_name||'file')}" style="color:inherit;font-weight:600">${esc(m.file_name||'Attachment')}</a></span>
          <span>${formatBytes(m.file_size)}</span>
        </div>`;
    }
  }

  const textHtml = m.text ? `<div class="chat-bubble">${esc(m.text).replace(/\n/g, '<br>')}</div>` : '';
  const senderLabel = (!isMine && m.sender_name) ? `<div class="chat-msg-sender">${esc(m.sender_name)}</div>` : '';
  const time = `<div class="chat-msg-time">${timeStr(m.created)}</div>`;

  return `
    <div class="chat-msg-wrapper">
      <button type="button" class="reaction-trigger" data-react-msg="${m.id}" title="React with emoji">😊+</button>
      <div class="reaction-picker" id="picker-${m.id}" style="display:none">
        <button type="button" class="reaction-emoji-btn" data-msg-id="${m.id}" data-emoji="❤️">❤️</button>
        <button type="button" class="reaction-emoji-btn" data-msg-id="${m.id}" data-emoji="🔥">🔥</button>
        <button type="button" class="reaction-emoji-btn" data-msg-id="${m.id}" data-emoji="👍">👍</button>
        <button type="button" class="reaction-emoji-btn" data-msg-id="${m.id}" data-emoji="🎵">🎵</button>
        <button type="button" class="reaction-emoji-btn" data-msg-id="${m.id}" data-emoji="👏">👏</button>
      </div>
      ${senderLabel}${textHtml}${mediaHtml}
      <div class="reactions-list">${renderReactionsHtml(m.id, m.reactions)}</div>
      ${time}
    </div>`;
}

function setupAudioPlayers(scope = document){
  scope.querySelectorAll('.speed-btn-group').forEach(group => {
    const audio = group.closest('.chat-audio-attachment')?.querySelector('audio');
    if (!audio) return;
    group.querySelectorAll('.speed-btn').forEach(btn => {
      btn.onclick = () => {
        const speed = parseFloat(btn.dataset.speed);
        audio.playbackRate = speed;
        group.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      };
    });
  });
}

function bindReactionPills(scope = document){
  scope.querySelectorAll('.reaction-pill').forEach(btn => {
    btn.onclick = async () => {
      const msgId = btn.dataset.msgId;
      const emoji = btn.dataset.emoji;
      try {
        const res = await api(`/messages/${msgId}/react`, 'POST', { emoji });
        updateMessageReactions(msgId, res.reactions);
      } catch(e){ toast(e.message); }
    };
  });
}

async function showNewChatModal(){
  try {
    const users = await api('/users');
    const box = $('lightbox');
    box.innerHTML = `
      <div class="lightbox-overlay" id="nc-ov">
        <div class="lightbox-content" style="background:var(--card);padding:24px;border-radius:12px;border:1px solid var(--line);width:90%;max-width:440px;color:var(--ink)">
          <div style="display:flex;justify-content:space-between;align-items:center;width:100%;margin-bottom:16px">
            <h3 style="margin:0">Start a Conversation</h3>
            <button id="nc-close" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--muted)">✕</button>
          </div>
          <input id="nc-search" placeholder="Search creators by name or email…" style="margin-bottom:16px">
          <div id="nc-list" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px"></div>
        </div>
      </div>`;

    const renderUsers = list => {
      const el = $('nc-list');
      if (!list.length) { el.innerHTML = '<p class="empty" style="padding:16px">No creators found.</p>'; return; }
      el.innerHTML = list.map(u => `
        <div class="chat-conv-item" style="border-radius:8px;border:1px solid var(--line)" data-uid="${u.id}">
          <div class="avatar">${u.name[0].toUpperCase()}</div>
          <div class="chat-conv-info"><div class="chat-conv-name">${esc(u.name)}</div><div class="meta">${esc(u.email)} ${u.bio ? '· ' + esc(u.bio) : ''}</div></div>
        </div>`).join('');
      el.querySelectorAll('[data-uid]').forEach(b => b.onclick = () => {
        box.innerHTML = '';
        startDirectChat(b.dataset.uid);
      });
    };

    renderUsers(users);
    $('nc-search').oninput = async e => {
      const q = e.target.value.trim();
      const res = await api('/users?q=' + encodeURIComponent(q));
      renderUsers(res);
    };

    const close = () => { box.innerHTML = ''; };
    $('nc-close').onclick = close;
    $('nc-ov').onclick = e => { if (e.target.id === 'nc-ov') close(); };
  } catch(e) { toast(e.message); }
}

function showCrewDrawer(c){
  const box = $('lightbox');
  box.innerHTML = `
    <div class="lightbox-overlay" id="crew-ov">
      <div class="lightbox-content" style="background:var(--card);padding:24px;border-radius:12px;border:1px solid var(--line);width:90%;max-width:440px;color:var(--ink)">
        <div style="display:flex;justify-content:space-between;align-items:center;width:100%;margin-bottom:16px">
          <h3 style="margin:0">Crew Members (${c.crew_members.length})</h3>
          <button id="crew-close" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--muted)">✕</button>
        </div>
        <div style="max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:8px">
          ${c.crew_members.map(m => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--paper)">
              <div style="display:flex;align-items:center;gap:10px">
                <div class="avatar">${m.name[0].toUpperCase()}</div>
                <div>
                  <div style="font-weight:600">${esc(m.name)}</div>
                  <div class="meta">${esc(m.role)}</div>
                </div>
              </div>
              ${m.id !== me.id ? `<button class="btn sm ghost" data-msg-crew="${m.id}">💬 Message</button>` : '<span class="status accepted">You</span>'}
            </div>
          `).join('')}
        </div>
      </div>
    </div>`;

  box.querySelectorAll('[data-msg-crew]').forEach(b => {
    b.onclick = () => {
      box.innerHTML = '';
      startDirectChat(b.dataset.msgCrew, c.project_id);
    };
  });

  const close = () => { box.innerHTML = ''; };
  $('crew-close').onclick = close;
  $('crew-ov').onclick = e => { if (e.target.id === 'crew-ov') close(); };
}

async function chatPage(convId){
  if (!me) return location.hash='#/login';
  activeConvId = convId ? Number(convId) : null;
  stagedFile = null;

  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

  app.innerHTML = `
    <div class="chat-view ${convId ? 'in-chat' : ''}">
      <aside class="chat-sidebar">
        <div class="chat-sidebar-header">
          <h2>Messages</h2>
          <button class="btn sm" id="btn-new-chat">+ New Chat</button>
        </div>
        <div class="chat-search-box">
          <input id="conv-search" placeholder="Search conversations…">
        </div>
        <ul class="chat-conv-list" id="conv-list"></ul>
      </aside>
      <section class="chat-main" id="chat-main">
        ${convId ? '<div style="margin:auto;color:var(--muted)">Loading conversation…</div>' : `
          <div class="chat-empty-state">
            <div class="chat-empty-icon">💬</div>
            <h3>Your Messages</h3>
            <p>Select a conversation on the left, or reach out to creators directly from project pages.</p>
            <button class="btn sm" id="btn-new-chat-empty" style="margin-top:12px">+ Start New Chat</button>
          </div>
        `}
      </section>
    </div>`;

  $('btn-new-chat').onclick = showNewChatModal;
  if ($('btn-new-chat-empty')) $('btn-new-chat-empty').onclick = showNewChatModal;

  $('conv-search').oninput = e => {
    renderConvList(cachedConversations, e.target.value.trim());
  };

  await refreshConvList();

  if (convId) {
    await loadConversationView(convId);
    // Background polling fallback every 3s
    pollTimer = setInterval(async () => {
      if (activeConvId && Number(activeConvId) === Number(convId)) {
        try {
          const msgs = await api(`/conversations/${convId}/messages`);
          for (const m of msgs) appendChatMessage(m);
        } catch(e){}
      }
    }, 3000);
  }
}

async function loadConversationView(convId){
  const main = $('chat-main');
  if (!main) return;
  try {
    const [c, messages] = await Promise.all([
      api('/conversations/' + convId),
      api('/conversations/' + convId + '/messages')
    ]);

    fetchUnread();

    const initial = (c.type === 'project' ? '👥' : (c.display_name||'?')[0].toUpperCase());

    main.innerHTML = `
      <header class="chat-header">
        <div class="chat-header-info">
          <button class="chat-back-btn" id="chat-back">←</button>
          <div class="avatar ${c.type==='project'?'project':''}">${initial}</div>
          <div>
            <h3 class="chat-header-name"><span class="online-dot"></span>${esc(c.display_name)}</h3>
            <div class="chat-header-meta">${c.type === 'project' ? `${c.participants.length} crew members` : (c.other_participants[0]?.email || 'Direct conversation')}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${c.type === 'project' ? `<button class="crew-toggle-btn" id="btn-view-crew">👥 View Crew</button>` : ''}
          ${c.project_id ? `<a class="chat-header-project" href="#/p/${c.project_id}">📁 Project →</a>` : ''}
        </div>
      </header>

      <div class="chat-messages" id="chat-msgs"></div>

      <footer class="chat-input-container">
        <div id="staged-preview" style="display:none"></div>
        <div id="rec-bar" style="display:none" class="chat-recording-bar">
          <div class="rec-dot"></div>
          <span class="rec-time" id="rec-timer">0:00</span>
          <span class="rec-label">Recording audio note…</span>
          <button type="button" class="rec-cancel" id="rec-cancel">Cancel</button>
          <button type="button" class="btn sm" id="rec-stop-send">Stop & Send</button>
        </div>
        <div class="chat-input-row" id="input-controls">
          <input type="file" id="file-input" accept="image/*,audio/*,.pdf,.zip" style="display:none">
          <button type="button" class="chat-action-btn" id="btn-attach" title="Share Photo or Audio (Images, MP3, WAV, etc.)">📎</button>
          <button type="button" class="chat-action-btn" id="btn-mic" title="Record Voice Note">🎙️</button>
          <textarea class="chat-input-textarea" id="chat-input" placeholder="Type a message… (or drop photos/audios here)" rows="1"></textarea>
          <button type="button" class="chat-action-btn send-btn" id="btn-send" title="Send message">➤</button>
        </div>
      </footer>`;

    $('chat-back').onclick = () => { location.hash = '#/chats'; };
    if ($('btn-view-crew')) $('btn-view-crew').onclick = () => showCrewDrawer(c);

    const msgsBox = $('chat-msgs');
    msgsBox.innerHTML = messages.map(m => {
      const isMine = m.sender_id === me.id;
      return `<div id="msg-${m.id}" class="chat-msg ${isMine ? 'mine' : 'theirs'}">${renderMessageHtml(m, isMine)}</div>`;
    }).join('');
    msgsBox.scrollTop = msgsBox.scrollHeight;

    setupAudioPlayers(msgsBox);
    bindReactionPills(msgsBox);

    // Delegation for lightboxes, reactions, and picker
    msgsBox.onclick = async e => {
      const imgTarget = e.target.closest('[data-img-url]');
      if (imgTarget) {
        openLightbox(imgTarget.dataset.imgUrl, imgTarget.dataset.imgName);
        return;
      }

      const reactTrigger = e.target.closest('[data-react-msg]');
      if (reactTrigger) {
        const mId = reactTrigger.dataset.reactMsg;
        const picker = $(`picker-${mId}`);
        if (picker) {
          picker.style.display = picker.style.display === 'none' ? 'flex' : 'none';
        }
        return;
      }

      const emojiBtn = e.target.closest('.reaction-emoji-btn');
      if (emojiBtn) {
        const msgId = emojiBtn.dataset.msgId;
        const emoji = emojiBtn.dataset.emoji;
        const picker = $(`picker-${msgId}`);
        if (picker) picker.style.display = 'none';
        try {
          const res = await api(`/messages/${msgId}/react`, 'POST', { emoji });
          updateMessageReactions(msgId, res.reactions);
        } catch(err) { toast(err.message); }
        return;
      }

      const pill = e.target.closest('.reaction-pill');
      if (pill) {
        const msgId = pill.dataset.msgId;
        const emoji = pill.dataset.emoji;
        try {
          const res = await api(`/messages/${msgId}/react`, 'POST', { emoji });
          updateMessageReactions(msgId, res.reactions);
        } catch(err) { toast(err.message); }
        return;
      }
    };

    const input = $('chat-input');
    const sendBtn = $('btn-send');
    const attachBtn = $('btn-attach');
    const fileInput = $('file-input');
    const micBtn = $('btn-mic');

    input.oninput = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };

    attachBtn.onclick = () => fileInput.click();
    fileInput.onchange = e => {
      if (e.target.files && e.target.files[0]) {
        stageFile(e.target.files[0]);
      }
    };

    main.ondragover = e => { e.preventDefault(); main.classList.add('drag-over'); };
    main.ondragleave = () => { main.classList.remove('drag-over'); };
    main.ondrop = e => {
      e.preventDefault();
      main.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        stageFile(e.dataTransfer.files[0]);
      }
    };

    micBtn.onclick = () => startVoiceRecording(convId);

    const doSend = async () => {
      const text = input.value.trim();
      if (!text && !stagedFile) return;

      sendBtn.disabled = true;
      sendBtn.textContent = '…';

      try {
        let filePayload = {};
        if (stagedFile) {
          toast('Uploading file…');
          const uploaded = await uploadFileApi(stagedFile);
          filePayload = {
            file_url: uploaded.url,
            file_name: uploaded.name,
            file_type: uploaded.type,
            file_size: uploaded.size
          };
          clearStagedFile();
        }

        const msg = await api(`/conversations/${convId}/messages`, 'POST', {
          text: text,
          ...filePayload
        });

        input.value = '';
        input.style.height = 'auto';
        appendChatMessage(msg);
        refreshConvList();
      } catch(err) {
        toast(err.message);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = '➤';
        input.focus();
      }
    };

    sendBtn.onclick = doSend;
    input.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    };

  } catch(e) {
    main.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

function stageFile(file){
  stagedFile = file;
  const preview = $('staged-preview');
  if (!preview) return;
  const isImg = file.type.startsWith('image/');
  const isAudio = file.type.startsWith('audio/');
  const icon = isImg ? '📷' : isAudio ? '🎵' : '📎';

  preview.style.display = 'block';
  preview.innerHTML = `
    <div class="chat-attachment-preview">
      ${isImg ? `<img src="${URL.createObjectURL(file)}" class="chat-attachment-thumb">` : `<span style="font-size:1.8rem">${icon}</span>`}
      <div class="chat-attachment-info">
        <div class="chat-attachment-name">${esc(file.name)}</div>
        <div class="chat-attachment-size">${formatBytes(file.size)} · Ready to send</div>
      </div>
      <button type="button" class="chat-attachment-cancel" id="btn-cancel-stage" title="Remove">✕</button>
    </div>`;

  $('btn-cancel-stage').onclick = clearStagedFile;
}

function clearStagedFile(){
  stagedFile = null;
  const preview = $('staged-preview');
  if (preview) { preview.innerHTML = ''; preview.style.display = 'none'; }
  const fileInput = $('file-input');
  if (fileInput) fileInput.value = '';
}

async function startVoiceRecording(convId){
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Audio recording is not supported in this browser.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    const recBar = $('rec-bar');
    const inputControls = $('input-controls');
    const timerEl = $('rec-timer');
    recBar.style.display = 'flex';
    inputControls.style.display = 'none';

    recSeconds = 0;
    timerEl.textContent = '0:00';
    clearInterval(recInterval);
    recInterval = setInterval(() => {
      recSeconds++;
      const m = Math.floor(recSeconds / 60);
      const s = recSeconds % 60;
      timerEl.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
    }, 1000);

    const cleanup = () => {
      clearInterval(recInterval);
      stream.getTracks().forEach(t => t.stop());
      recBar.style.display = 'none';
      inputControls.style.display = 'flex';
    };

    $('rec-cancel').onclick = () => {
      mediaRecorder.stop();
      cleanup();
    };

    $('rec-stop-send').onclick = () => {
      mediaRecorder.onstop = async () => {
        cleanup();
        if (!audioChunks.length) return;
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const voiceFile = new File([blob], `voice-note-${Date.now()}.webm`, { type: 'audio/webm' });
        try {
          toast('Sending voice note…');
          const uploaded = await uploadFileApi(voiceFile);
          const msg = await api(`/conversations/${convId}/messages`, 'POST', {
            text: '',
            file_url: uploaded.url,
            file_name: uploaded.name,
            file_type: 'audio',
            file_size: uploaded.size
          });
          appendChatMessage(msg);
          refreshConvList();
        } catch(err) {
          toast(err.message);
        }
      };
      mediaRecorder.stop();
    };

    mediaRecorder.start();
  } catch(e) {
    toast('Microphone access denied or error: ' + e.message);
  }
}

async function route(){
  nav(); const [, page, arg] = location.hash.split('/');
  try {
    if (!CATS.length) CATS = await api('/categories');
    if (page==='login'||page==='register') authPage(page);
    else if (page==='new') newProject();
    else if (page==='p') await project(arg);
    else if (page==='me') await dash();
    else if (page==='chats') await chatPage(arg);
    else await home();
  } catch(e){ app.innerHTML = `<p class="empty">${esc(e.message)}</p>` }
  window.scrollTo(0,0);
}

addEventListener('hashchange', route);
route();
if (token) {
  initSSE();
  fetchUnread();
  setInterval(fetchUnread, 30000);
}
