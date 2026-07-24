/* LearnIQ AI — application logic (SPA, no framework, design-system-first). */
"use strict";

/* ============ routing ============ */
const VIEWS = [
  ["dashboard", "Dashboard"], ["library", "Library"], ["chat", "Chat"],
  ["scan", "Scan"], ["quiz", "Quiz"], ["notes", "Notes"], ["flashcards", "Flashcards"],
  ["roadmap", "Roadmap"], ["analytics", "Analytics"], ["explain", "Explain"],
  ["settings", "Settings"],
];

function go(view) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const el = document.getElementById("view-" + view);
  if (el) el.classList.add("active");
  document.querySelectorAll("#navLinks button").forEach(b =>
    b.classList.toggle("active", b.dataset.view === view));
  const sel = document.getElementById("navSelect");
  if (sel) sel.value = view;
  location.hash = view;
  if (view === "dashboard") renderDashboard();
  if (view === "library") renderDocs();
  if (view === "chat") renderChatSide();
  if (view === "quiz") fillDocSelect("quizDoc");
  if (view === "notes") fillDocSelect("notesDoc");
  if (view === "flashcards") fillDocSelect("fcDoc");
  if (view === "analytics") renderAnalytics();
  if (view !== "scan") stopCamera();
  renderTopicBars();
  if (view === "explain" && !$("eliConcept").value) $("eliConcept").value = activeTopic("explain");
}

function buildNav() {
  const links = document.getElementById("navLinks");
  const sel = document.getElementById("navSelect");
  for (const [id, label] of VIEWS) {
    const b = document.createElement("button");
    b.textContent = label; b.dataset.view = id; b.onclick = () => go(id);
    links.appendChild(b);
    const o = document.createElement("option");
    o.value = id; o.textContent = label; sel.appendChild(o);
  }
}

/* ============ helpers ============ */
const $ = id => document.getElementById(id);
const esc = s => { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; };
const md = s => (window.marked ? marked.parse(s || "") : esc(s));
async function downloadPDF(title, markdown, filename) {
  if (!markdown || !markdown.trim()) { toast("Generate something first."); return; }
  try {
    const res = await fetch("/api/report", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, markdown, filename: filename || "learniq-report" }) });
    if (!res.ok) throw new Error("PDF generation failed.");
    const blob = await res.blob();
    const a = Object.assign(document.createElement("a"),
      { href: URL.createObjectURL(blob), download: (filename || "learniq-report") + ".pdf" });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
  } catch (err) { toast(err.message); }
}

function downloadText(filename, text, type = "text/markdown;charset=utf-8") {
  const blob = new Blob([text], { type });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}
function slug(s) { return (s || "learniq").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "learniq"; }
const _out = {};   // last raw output per feature, for downloads

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24); if (d < 7) return d + "d ago";
  return new Date(ts).toLocaleDateString();
}

function toast(message) {
  const t = $("toast"); t.textContent = message; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 3200);
}
function openModal(title, bodyHtml) {
  $("modalTitle").textContent = title; $("modalBody").innerHTML = bodyHtml;
  $("modalOverlay").classList.add("show");
}
function closeModal() { $("modalOverlay").classList.remove("show"); }

function busy(btnId, on, labelBusy) {
  const b = $(btnId); if (!b) return;
  if (on) { b.dataset.label = b.textContent; b.disabled = true; b.innerHTML = `<span class="spinner"></span>&nbsp;${labelBusy || "Working…"}`; }
  else { b.disabled = false; b.textContent = b.dataset.label || b.textContent; }
}

async function api(path, body, method = "POST") {
  const headers = { "Content-Type": "application/json" };
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let detail = "Request failed.";
    try { detail = (await res.json()).detail || detail; } catch (_) { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}

async function docsWithChunks(docId) {
  if (docId === "") return [];                 // topic mode — no documents
  const docs = await DB.getAll("docs");
  const active = docId && docId !== "all" ? docs.filter(d => d.doc_id === docId) : docs;
  return active.flatMap(d => d.chunks.map(c => ({ ...c, doc_name: d.name })));
}

async function fillDocSelect(id) {
  const docs = await DB.getAll("docs");
  const sel = $(id); if (!sel) return;
  const topic = activeTopic("quiz") || activeTopic("notes") || activeTopic("flashcards");
  const topicOpt = topic ? `<option value="" selected>Topic: ${esc(topic)}</option>` : "";
  sel.innerHTML = topicOpt + (docs.length
    ? `<option value="all">All my documents</option>` + docs.map(d => `<option value="${d.doc_id}">${esc(d.name)}</option>`).join("")
    : (topic ? "" : `<option value="">\u2014 set a topic or upload a document \u2014</option>`));
}

/* ============ gamification pill ============ */
async function renderXP() {
  const g = await gamificationState();
  $("xpPill").innerHTML = `<b>Lv ${g.level}</b> · ${g.xp} XP · ${g.streak}🔥`;
}

/* ============ dashboard ============ */
async function renderDashboard() {
  applyStudyPersonalization();
  renderVideos();
  const g = await gamificationState();
  const docs = await DB.getAll("docs");
  const quizzes = await DB.getAll("quizzes");
  const attempts = quizzes.flatMap(q => q.attempts || []);
  const acc = attempts.length ? Math.round(100 * attempts.filter(a => a.correct).length / attempts.length) : null;
  const hour = new Date().getHours();
  const u = await whoami();
  const who = u && u.name ? ", " + u.name.split(" ")[0] : "";
  $("welcomeTitle").textContent = (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening") + who + ".";
  $("dashMetrics").innerHTML = [
    ["blue", g.streak + " days", "Study streak"],
    ["", "Lv " + g.level, g.xp + " XP total"],
    ["", String(docs.length), "Documents"],
    ["", acc === null ? "—" : acc + "%", "Quiz accuracy"],
  ].map(([cls, v, l]) => `<div class="card metric"><div class="value ${cls}">${v}</div><div class="label">${l}</div></div>`).join("");
  if (g.badges.length) $("dashMetrics").innerHTML +=
    `<div class="card metric" style="grid-column:1/-1"><div class="label">Badges</div><div style="margin-top:8px">${g.badges.map(b => `<span class="tag">${b}</span>`).join("")}</div></div>`;

  const weak = weakFromHistory(attempts);
  $("dashWeak").innerHTML = weak.length
    ? weak.slice(0, 4).map(w => `<div>${esc(w.topic)} — <b>${w.accuracy}%</b></div>`).join("")
    : `<span class="muted">Take quizzes and LearnIQ will find your weak spots.</span>`;

  const plan = localStorage.getItem("learniq_roadmap");
  $("dashPlan").innerHTML = plan ? md(plan.split("\n").slice(0, 6).join("\n")) : `<span class="muted">Generate a roadmap to see today's plan.</span>`;

  $("dashDocs").innerHTML = docs.slice(-5).reverse().map(docRowHtml).join("") ||
    `<div class="empty"><div class="big">No documents yet</div>Upload your first PDF, DOCX, or TXT to begin.</div>`;
}

function weakFromHistory(attempts, threshold = 60) {
  const byTopic = {};
  for (const a of attempts) {
    const t = a.topic || "General";
    (byTopic[t] = byTopic[t] || { c: 0, n: 0 }), byTopic[t].n++, a.correct && byTopic[t].c++;
  }
  return Object.entries(byTopic)
    .filter(([, s]) => s.n >= 2 && (100 * s.c / s.n) < threshold)
    .map(([topic, s]) => ({ topic, accuracy: Math.round(100 * s.c / s.n), attempts: s.n }))
    .sort((a, b) => a.accuracy - b.accuracy);
}

/* ============ home study bar ============ */
async function homeStudy() {
  const topic = $("homeQuery").value.trim(); if (!topic) return;
  busy("homeStudyBtn", true, "Preparing\u2026");
  $("homeResult").innerHTML = "";
  try {
    const { markdown } = await api("/api/explain",
      { concept: topic, level: "intermediate", chunks: await docsWithChunks("all") });
    _out.home = markdown; $("homeDl").style.display = "inline-flex";
    $("homeResult").innerHTML = md(markdown) +
      `<div class="followups"><button onclick="go('quiz')">Quiz me on this</button>` +
      `<button onclick="go('flashcards')">Make flashcards</button>` +
      `<button onclick="$('eliConcept').value='${esc(topic).replace(/'/g, "\\'")}';go('explain')">Deeper explanation</button></div>`;
    renderVideos(topic);
    await addEvent("chat"); renderXP();
  } catch (err) { toast(err.message); }
  finally { busy("homeStudyBtn", false); }
}

function downloadHome() {
  downloadPDF(`Study — ${$("homeQuery").value || "topic"}`, _out.home, `study-${slug($("homeQuery").value || "topic")}`);
}

async function homeAsk() {
  const q = $("homeQuery").value.trim(); if (!q) return;
  busy("homeAskBtn", true, "Thinking\u2026");
  $("homeResult").innerHTML = "";
  try {
    const chunks = await docsWithChunks("all");
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, chunks, history: [] }) });
    if (!res.ok) throw new Error((await res.json()).detail || "Request failed.");
    const reader = res.body.getReader(); const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      text += decoder.decode(value, { stream: true });
      $("homeResult").innerHTML = renderAnswer(text);
    }
    const followups = [...text.matchAll(/^FOLLOW-UP:\s*(.+)$/gm)].map(m => m[1]).slice(0, 3);
    if (followups.length) $("homeResult").innerHTML = renderAnswer(text) +
      `<div class="followups">${followups.map(f =>
        `<button onclick="$('homeQuery').value=this.textContent;homeAsk()">${esc(f)}</button>`).join("")}</div>`;
    await addEvent("chat"); renderXP();
  } catch (err) { toast(err.message); }
  finally { busy("homeAskBtn", false); }
}

/* ============ library ============ */
function docRowHtml(d) {
  return `<div class="doc-row">
    <div><div class="doc-name" onclick="previewDoc('${d.doc_id}')">${d.favorite ? "★ " : ""}${esc(d.name)}</div>
      <div class="doc-meta">${d.meta.words.toLocaleString()} words${d.meta.pages ? " · " + d.meta.pages + " pages" : ""} · ${d.chunks.length} chunks${(d.tags || []).map(t => ` · <span class="tag">${esc(t)}</span>`).join("")}</div></div>
    <div class="doc-actions">
      <button class="btn-link" onclick="toggleFav('${d.doc_id}')">${d.favorite ? "Unfavorite" : "Favorite"}</button>
      <button class="btn-link" onclick="tagDoc('${d.doc_id}')">Tag</button>
      <button class="btn-link" onclick="renameDoc('${d.doc_id}')">Rename</button>
      <button class="btn-link btn-danger-link" onclick="deleteDoc('${d.doc_id}')">Delete</button>
    </div></div>`;
}

async function renderDocs() {
  const docs = await DB.getAll("docs");
  docs.sort((a, b) => (b.favorite - a.favorite) || (b.added - a.added));
  $("docList").innerHTML = docs.map(docRowHtml).join("") ||
    `<div class="empty"><div class="big">Your library is empty</div>Everything you upload stays in your browser.</div>`;
}

async function handleFiles(files) {
  for (const file of files) {
    toast(`Processing ${file.name}…`);
    const form = new FormData(); form.append("file", file);
    try {
      const res = await fetch("/api/extract", { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json()).detail || "Extraction failed.");
      const data = await res.json();
      await DB.put("docs", { ...data, doc_id: data.doc_id, favorite: false, tags: [], added: Date.now() });
      await addEvent("upload");
      toast(`${file.name} added — ${data.chunks.length} chunks indexed.`);
    } catch (err) { toast(err.message); }
  }
  renderDocs(); renderXP();
}

async function previewDoc(id) {
  const d = (await DB.getAll("docs")).find(x => x.doc_id === id);
  if (d) openModal(d.name, `<p class="muted">${d.meta.words.toLocaleString()} words</p><blockquote>${esc(d.preview)}…</blockquote>`);
}
async function toggleFav(id) {
  const d = (await DB.getAll("docs")).find(x => x.doc_id === id);
  if (d) { d.favorite = !d.favorite; await DB.put("docs", d); renderDocs(); }
}
async function renameDoc(id) {
  const d = (await DB.getAll("docs")).find(x => x.doc_id === id);
  const name = d && prompt("Rename document", d.name);
  if (name) { d.name = name; await DB.put("docs", d); renderDocs(); }
}
async function tagDoc(id) {
  const d = (await DB.getAll("docs")).find(x => x.doc_id === id);
  const tags = d && prompt("Tags (comma-separated)", (d.tags || []).join(", "));
  if (tags !== null && d) { d.tags = tags.split(",").map(t => t.trim()).filter(Boolean); await DB.put("docs", d); renderDocs(); }
}
async function deleteDoc(id) {
  if (confirm("Delete this document and its chunks?")) { await DB.del("docs", id); renderDocs(); toast("Deleted."); }
}

async function semanticSearch() {
  const q = $("libSearch").value.trim(); if (!q) return;
  const chunks = await docsWithChunks("all");
  if (!chunks.length) return toast("Upload a document first.");
  try {
    const { results } = await api("/api/search", { query: q, chunks });
    $("searchResults").innerHTML = `<h2 class="section-title">Results for “${esc(q)}”</h2>` +
      (results.length ? results.map(r =>
        `<div class="doc-row"><div><div class="doc-name">${esc(r.doc_name || "")} <span class="tag">${r.score}</span></div>
         <div class="doc-meta">${esc(r.text.slice(0, 220))}…</div></div></div>`).join("")
        : `<div class="empty">No matches.</div>`);
  } catch (err) { toast(err.message); }
}

/* ============ chat ============ */
let chat = { id: crypto.randomUUID(), title: null, messages: [], docId: "all" };

async function renderChatSide() {
  const docs = await DB.getAll("docs");
  $("chatDocPick").innerHTML = [`<label class="doc-pick"><input type="radio" name="cdoc" value="all" ${chat.docId === "all" ? "checked" : ""} onchange="chat.docId='all'"> All documents</label>`]
    .concat(docs.map(d => `<label class="doc-pick"><input type="radio" name="cdoc" value="${d.doc_id}" ${chat.docId === d.doc_id ? "checked" : ""} onchange="chat.docId='${d.doc_id}'"> ${esc(d.name)}</label>`)).join("");
  const chats = (await DB.getAll("chats")).sort((a, b) => (b.at || 0) - (a.at || 0));
  $("chatHistoryList").innerHTML = chats.length
    ? chats.map(c => `<div class="chat-hist ${c.id === chat.id ? "active" : ""}">
        <button class="chat-hist-open" onclick="loadChat('${c.id}')" title="${esc(c.title || "Untitled chat")}">
          <span class="chat-hist-title">${esc(c.title || "Untitled chat")}</span>
          <span class="chat-hist-time">${relTime(c.at || Date.now())}</span>
        </button>
        <button class="chat-hist-del" onclick="deleteChat(event,'${c.id}')" title="Delete chat">\u00d7</button>
      </div>`).join("")
    : `<span class="muted">No saved chats yet.</span>`;
}

function renderChatLog() {
  $("chatLog").innerHTML = chat.messages.map((m, i) => m.role === "user"
    ? `<div class="msg user">${esc(m.content)}</div>`
    : `<div class="msg ai"><div class="md">${renderAnswer(m.content)}</div>${m.followups?.length ? `<div class="followups">${m.followups.map(f => `<button onclick="askFollowup(this)">${esc(f)}</button>`).join("")}</div>` : ""}
       <div class="row" style="margin-top:8px"><button class="btn-link" onclick="bookmarkMsg(${i})">Bookmark</button></div></div>`).join("");
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
}

function renderAnswer(text) {
  const clean = text.replace(/^FOLLOW-UP:.*$/gm, "").trim();
  let html = md(clean);
  html = html.replace(/\[([\w-]+-c\d+)\]/g, (_, id) => `<span class="cite" onclick="showSource('${id}')">${id}</span>`);
  return html;
}

async function showSource(chunkId) {
  const chunks = await docsWithChunks("all");
  const c = chunks.find(x => x.id === chunkId);
  openModal(c ? `Source — ${c.doc_name}` : "Source", c ? `<blockquote>${esc(c.text)}</blockquote>` : "Source not found (document may have been deleted).");
}

function askFollowup(btn) { $("chatInput").value = btn.textContent; sendChat(); }

async function sendChat() {
  const q = $("chatInput").value.trim(); if (!q) return;
  $("chatInput").value = "";
  chat.messages.push({ role: "user", content: q });
  chat.title = chat.title || q.slice(0, 48);
  chat.at = Date.now();
  await DB.put("chats", { id: chat.id, title: chat.title, messages: chat.messages, docId: chat.docId, at: chat.at });
  renderChatLog(); renderChatSide();
  const aiMsg = { role: "assistant", content: "", followups: [] };
  chat.messages.push(aiMsg);
  busy("chatSend", true, "…");
  try {
    const headers = { "Content-Type": "application/json" };
    const chunks = await docsWithChunks(chat.docId);
    const history = chat.messages.slice(0, -2).map(m => ({ role: m.role, content: m.content }));
    const res = await fetch("/api/chat", { method: "POST", headers, body: JSON.stringify({ query: q, chunks, history }) });
    if (!res.ok) throw new Error((await res.json()).detail || "Chat failed.");
    const reader = res.body.getReader(); const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      aiMsg.content += decoder.decode(value, { stream: true });
      renderChatLog();
    }
    aiMsg.followups = [...aiMsg.content.matchAll(/^FOLLOW-UP:\s*(.+)$/gm)].map(m => m[1]).slice(0, 3);
    renderChatLog();
    chat.at = Date.now();
    await DB.put("chats", { id: chat.id, title: chat.title, messages: chat.messages, docId: chat.docId, at: chat.at });
    await addEvent("chat"); renderXP(); renderChatSide();
  } catch (err) {
    aiMsg.content = "> ⚠ " + err.message; renderChatLog();
  } finally { busy("chatSend", false); }
}

async function loadChat(id) {
  const c = (await DB.getAll("chats")).find(x => x.id === id);
  if (c) { chat = c; renderChatLog(); renderChatSide(); }
}
function newChat() { chat = { id: crypto.randomUUID(), title: null, messages: [], docId: chat.docId }; renderChatLog(); renderChatSide(); }

async function deleteChat(ev, id) {
  ev.stopPropagation();
  if (!confirm("Delete this chat?")) return;
  await DB.del("chats", id);
  if (chat.id === id) newChat();
  renderChatSide();
  toast("Chat deleted.");
}
function exportChat() {
  if (!chat.messages.length) return toast("Nothing to export.");
  const md2 = chat.messages.map(m => (m.role === "user" ? "## You\n" : "## LearnIQ\n") + m.content.replace(/^FOLLOW-UP:.*$/gm, "").trim()).join("\n\n");
  downloadPDF(chat.title || "Chat", md2, slug(chat.title || "chat"));
}
async function bookmarkMsg(i) {
  const m = chat.messages[i]; if (!m) return;
  await addEvent("chat", { bookmark: m.content.slice(0, 2000) });
  toast("Bookmarked (find it in exported data).");
}

/* ============ quiz ============ */
let quiz = null, quizTimerHandle = null;

async function startQuiz() {
  const docId = $("quizDoc").value;                 // "" = topic mode
  const topic = activeTopic("quiz");
  if (!docId && !topic) return toast("Set a topic (top of page) or upload a document first.");
  const types = [...document.querySelectorAll(".qtype:checked")].map(c => c.value);
  if (!types.length) return toast("Pick at least one question type.");
  busy("quizStartBtn", true, "Generating…");
  try {
    const chunks = await docsWithChunks(docId);
    const g = getStudy();
    const { questions } = await api("/api/quiz/generate", {
      chunks, count: +$("quizCount").value, difficulty: $("quizDiff").value, types,
      topic: chunks.length ? "" : activeTopic("quiz"), subject: g.subject });
    quiz = { questions, index: 0, answers: {}, started: Date.now(), docId };
    $("quizSetup").style.display = "none"; $("quizResults").style.display = "none";
    $("quizRun").style.display = "block";
    quizTimerHandle = setInterval(() => {
      const s = Math.floor((Date.now() - quiz.started) / 1000);
      $("quizTimer").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }, 1000);
    renderQuestion();
  } catch (err) { toast(err.message); }
  finally { busy("quizStartBtn", false); }
}

function renderQuestion() {
  const q = quiz.questions[quiz.index];
  $("quizProgress").textContent = `Question ${quiz.index + 1} of ${quiz.questions.length} — ${q.topic}`;
  let body = `<div class="quiz-q"><div class="qtext">${esc(q.question)}</div>`;
  if (q.type === "mcq") body += q.options.map(o => `<button class="quiz-opt" onclick="answer(this,'${esc(o).replace(/'/g, "&#39;")}')">${esc(o)}</button>`).join("");
  else if (q.type === "true_false") body += ["True", "False"].map(o => `<button class="quiz-opt" onclick="answer(this,'${o}')">${o}</button>`).join("");
  else body += `<div class="row"><input type="text" id="freeAnswer" placeholder="Your answer…" style="flex:1" onkeydown="if(event.key==='Enter')answerFree()"><button class="btn btn-primary btn-sm" id="freeBtn" onclick="answerFree()">Submit</button></div>`;
  body += `<div id="qFeedback"></div></div>`;
  $("quizQuestion").innerHTML = body;
}

function decodeEntities(s) { const d = document.createElement("textarea"); d.innerHTML = s; return d.value; }

async function answer(btn, value) {
  value = decodeEntities(value);
  const q = quiz.questions[quiz.index];
  const correct = value.trim().toLowerCase() === q.answer.trim().toLowerCase();
  document.querySelectorAll(".quiz-opt").forEach(b => {
    b.disabled = true;
    const isAnswer = b.textContent.trim().toLowerCase() === q.answer.trim().toLowerCase();
    if (isAnswer) b.classList.add("right");
    else if (b === btn) b.classList.add("wrong");
  });
  finishQuestion(q, value, correct, q.explanation);
}

async function answerFree() {
  const q = quiz.questions[quiz.index];
  const value = $("freeAnswer").value.trim(); if (!value) return;
  $("freeAnswer").disabled = true; busy("freeBtn", true, "Grading…");
  let correct, feedback = q.explanation;
  if (q.type === "short_answer") {
    try {
      const g = await api("/api/quiz/grade", { question: q.question, correct_answer: q.answer, student_answer: value });
      correct = g.correct; feedback = g.feedback + (q.explanation ? "\n\n" + q.explanation : "");
    } catch (err) { toast(err.message); correct = false; }
  } else {
    correct = value.toLowerCase() === q.answer.trim().toLowerCase();
  }
  busy("freeBtn", false);
  finishQuestion(q, value, correct, `**Answer:** ${q.answer}\n\n${feedback || ""}`);
}

function finishQuestion(q, value, correct, explanation) {
  quiz.answers[q.id] = { value, correct, topic: q.topic };
  $("qFeedback").innerHTML = `<div class="explain-box md"><b style="color:${correct ? "var(--blue)" : "var(--carbon)"}">${correct ? "Correct." : "Not quite."}</b><div>${md(explanation || "")}</div></div>
    <div style="margin-top:16px"><button class="btn btn-primary" onclick="nextQuestion()">${quiz.index + 1 < quiz.questions.length ? "Next" : "Finish"}</button></div>`;
}

async function nextQuestion() {
  quiz.index++;
  if (quiz.index < quiz.questions.length) return renderQuestion();
  clearInterval(quizTimerHandle);
  const attempts = quiz.questions.map(q => ({ topic: q.topic, correct: !!quiz.answers[q.id]?.correct }));
  const score = attempts.filter(a => a.correct).length;
  const secs = Math.floor((Date.now() - quiz.started) / 1000);
  await DB.put("quizzes", { id: crypto.randomUUID(), at: Date.now(), docId: quiz.docId, secs, attempts,
    score, total: attempts.length });
  await addEvent("quiz_done"); for (const a of attempts) if (a.correct) await addEvent("quiz_correct");
  renderXP();
  const wrong = quiz.questions.filter(q => !quiz.answers[q.id]?.correct);
  $("quizRun").style.display = "none";
  $("quizResults").style.display = "block";
  $("quizResults").innerHTML = `<div class="hero"><h1>${score} / ${attempts.length}</h1>
    <p>${score === attempts.length ? "Flawless. Your streak thanks you." : score >= attempts.length * 0.7 ? "Strong work — a little revision and you own this." : "Good effort — LearnIQ has logged what to revise."}
    &nbsp;·&nbsp; ${Math.floor(secs / 60)}m ${secs % 60}s</p>
    <div class="cta-row">
      ${wrong.length ? `<button class="btn btn-primary" onclick="retryWrong()">Retry ${wrong.length} incorrect</button>` : ""}
      <button class="btn btn-secondary" onclick="downloadQuiz()">Download</button>
      <button class="btn btn-secondary" onclick="resetQuiz()">New quiz</button>
    </div></div>`;
}

function retryWrong() {
  const wrong = quiz.questions.filter(q => !quiz.answers[q.id]?.correct);
  quiz = { ...quiz, questions: wrong, index: 0, answers: {}, started: Date.now() };
  $("quizResults").style.display = "none"; $("quizRun").style.display = "block";
  quizTimerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - quiz.started) / 1000);
    $("quizTimer").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }, 1000);
  renderQuestion();
}
function resetQuiz() { $("quizResults").style.display = "none"; $("quizSetup").style.display = "block"; }

function downloadQuiz() {
  if (!quiz) return;
  const lines = [];
  quiz.questions.forEach((q, i) => {
    const a = quiz.answers[q.id] || {};
    lines.push(`## ${i + 1}. ${q.question}`);
    if (q.options) q.options.forEach(o => lines.push(`- ${o}`));
    lines.push(`- Your answer: ${a.value ?? "\u2014"} ${a.correct ? "(correct)" : "(incorrect)"}`);
    lines.push(`- Correct answer: **${q.answer}**`);
    if (q.explanation) lines.push(`- Explanation: ${q.explanation}`);
    lines.push("");
  });
  downloadPDF("Quiz Results", lines.join("\n"), "quiz-results");
}

/* ============ notes / flashcards / roadmap / explain ============ */
async function makeNotes() {
  const docId = $("notesDoc").value;
  if (!docId && !activeTopic("notes")) return toast("Set a topic (top of page) or upload a document first.");
  busy("notesBtn", true, "Writing…");
  try {
    const g = getStudy(); const chunks = await docsWithChunks(docId);
    const { markdown } = await api("/api/notes", { chunks, mode: $("notesMode").value,
      topic: chunks.length ? "" : activeTopic("notes"), subject: g.subject });
    _out.notes = markdown; $("notesOut").innerHTML = md(markdown);
    $("notesDl").style.display = "inline-flex";
    await addEvent("notes"); renderXP();
  } catch (err) { toast(err.message); }
  finally { busy("notesBtn", false); }
}

let cards = [], cardIndex = 0, showBack = false, reviewed = new Set();

function downloadNotes() {
  downloadPDF(`Notes — ${$("notesMode").value}`, _out.notes, `notes-${slug($("notesMode").value)}`);
}

async function makeCards() {
  const docId = $("fcDoc").value;
  if (!docId && !activeTopic("flashcards")) return toast("Set a topic (top of page) or upload a document first.");
  busy("fcBtn", true, "Creating…");
  try {
    const g = getStudy(); const chunks = await docsWithChunks(docId);
    const res = await api("/api/flashcards", { chunks, count: +$("fcCount").value,
      topic: chunks.length ? "" : activeTopic("fc") || activeTopic("flashcards"), subject: g.subject });
    cards = res.cards; cardIndex = 0; showBack = false; reviewed = new Set();
    renderCard(); $("fcDl").style.display = "inline-flex"; await addEvent("cards"); renderXP();
  } catch (err) { toast(err.message); }
  finally { busy("fcBtn", false); }
}

function renderCard() {
  if (!cards.length) { $("fcArea").innerHTML = ""; return; }
  const c = cards[cardIndex]; reviewed.add(cardIndex);
  $("fcArea").innerHTML = `
    <div class="flashcard" onclick="showBack=!showBack;renderCard()">
      <div>${esc(showBack ? c.back : c.front)}<span class="hint">${showBack ? c.topic : "click to flip"}</span></div>
    </div>
    <div class="row" style="justify-content:center">
      <button class="btn btn-secondary btn-sm" onclick="prevCard()">Previous</button>
      <span class="muted">${cardIndex + 1} / ${cards.length} · ${reviewed.size} reviewed</span>
      <button class="btn btn-primary btn-sm" onclick="nextCard()">Next</button>
    </div>`;
}
function nextCard() { cardIndex = (cardIndex + 1) % cards.length; showBack = false; renderCard(); }
function prevCard() { cardIndex = (cardIndex - 1 + cards.length) % cards.length; showBack = false; renderCard(); }
function shuffleCards() {
  for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
  cardIndex = 0; showBack = false; if (cards.length) renderCard();
}

function downloadCards() {
  if (!cards.length) return toast("Generate flashcards first.");
  const md2 = cards.map((c, i) => `### ${i + 1}. ${c.front}\n${c.back}\n\n_Topic: ${c.topic}_`).join("\n\n");
  downloadPDF("Flashcards", md2, "flashcards");
}

async function makeRoadmap() {
  busy("rmBtn", true, "Planning…");
  try {
    const docs = await DB.getAll("docs");
    const quizzes = await DB.getAll("quizzes");
    const { markdown } = await api("/api/roadmap", {
      documents: docs.map(d => ({ name: d.name, words: d.meta.words })),
      quiz_history: quizzes.flatMap(q => q.attempts || []),
      horizon: $("rmHorizon").value, minutes_per_day: +$("rmMinutes").value });
    _out.roadmap = markdown; $("rmOut").innerHTML = md(markdown);
    $("rmDl").style.display = "inline-flex";
    localStorage.setItem("learniq_roadmap", markdown);
    await addEvent("roadmap"); renderXP();
  } catch (err) { toast(err.message); }
  finally { busy("rmBtn", false); }
}

function downloadRoadmap() {
  downloadPDF(`Study Roadmap — ${$("rmHorizon").value}`, _out.roadmap, `roadmap-${$("rmHorizon").value}`);
}

async function explainConcept() {
  const concept = $("eliConcept").value.trim(); if (!concept) return;
  busy("eliBtn", true, "Thinking…");
  try {
    const { markdown } = await api("/api/explain", { concept, level: $("eliLevel").value, chunks: await docsWithChunks("all") });
    _out.eli = markdown; _out.eliConcept = concept; $("eliOut").innerHTML = md(markdown);
    $("eliDl").style.display = "inline-flex";
  } catch (err) { toast(err.message); }
  finally { busy("eliBtn", false); }
}

function downloadEli() {
  downloadPDF(`Explained — ${_out.eliConcept || ""}`, _out.eli, `explain-${slug(_out.eliConcept)}`);
}

/* ============ analytics ============ */
async function renderAnalytics() {
  const g = await gamificationState();
  const quizzes = await DB.getAll("quizzes");
  const attempts = quizzes.flatMap(q => q.attempts || []);
  const acc = attempts.length ? Math.round(100 * attempts.filter(a => a.correct).length / attempts.length) : null;
  const studyMin = Math.round(quizzes.reduce((a, q) => a + (q.secs || 0), 0) / 60 + g.events.length * 1.5);
  $("anMetrics").innerHTML = [
    ["", studyMin + " min", "Est. study time"],
    ["blue", acc === null ? "—" : acc + "%", "Overall accuracy"],
    ["", String(quizzes.length), "Quizzes taken"],
    ["", g.streak + " days", "Current streak"],
  ].map(([cls, v, l]) => `<div class="card metric"><div class="value ${cls}">${v}</div><div class="label">${l}</div></div>`).join("");

  /* heatmap: last 26 weeks x 7 days */
  const counts = {};
  for (const e of g.events) { const k = new Date(e.at).toDateString(); counts[k] = (counts[k] || 0) + 1; }
  const cells = [];
  const start = new Date(); start.setDate(start.getDate() - 181);
  for (let i = 0; i < 182; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const n = counts[d.toDateString()] || 0;
    cells.push(`<div class="${n > 6 ? "l4" : n > 3 ? "l3" : n > 1 ? "l2" : n > 0 ? "l1" : ""}" title="${d.toDateString()}: ${n}"></div>`);
  }
  $("anHeatmap").innerHTML = cells.join("");

  if (window.Plotly) {
    const layoutBase = { font: { family: "Inter", size: 12, color: "#393C41" },
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", margin: { t: 36, r: 8, b: 40, l: 40 } };
    Plotly.newPlot("anAccuracy", [{
      x: quizzes.map(q => new Date(q.at)), y: quizzes.map(q => Math.round(100 * q.score / q.total)),
      mode: "lines+markers", line: { color: "#3E6AE1", width: 2 }, marker: { color: "#3E6AE1" } }],
      { ...layoutBase, title: { text: "Quiz accuracy over time", font: { size: 14, color: "#171A20" } }, yaxis: { range: [0, 105] } },
      { displayModeBar: false, responsive: true });
    const byTopic = {};
    for (const a of attempts) { const t = a.topic || "General"; (byTopic[t] = byTopic[t] || { c: 0, n: 0 }), byTopic[t].n++, a.correct && byTopic[t].c++; }
    const topics = Object.entries(byTopic).map(([t, s]) => [t, Math.round(100 * s.c / s.n)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    Plotly.newPlot("anMastery", [{
      x: topics.map(t => t[1]), y: topics.map(t => t[0]), type: "bar", orientation: "h", marker: { color: "#3E6AE1" } }],
      { ...layoutBase, title: { text: "Topic mastery (%)", font: { size: 14, color: "#171A20" } }, xaxis: { range: [0, 105] }, margin: { ...layoutBase.margin, l: 140 } },
      { displayModeBar: false, responsive: true });
  }
}

async function refreshWeak() {
  busy("weakBtn", true, "Analyzing…");
  try {
    const quizzes = await DB.getAll("quizzes");
    const history = quizzes.flatMap(q => q.attempts || []);
    if (!history.length) { $("anWeak").innerHTML = `<p class="muted">No quiz history yet.</p>`; return; }
    const res = await api("/api/weak-topics", { quiz_history: history });
    $("anWeak").innerHTML = (res.weak_topics.length
      ? res.weak_topics.map(w => `<span class="tag">${esc(w.topic)} · ${w.accuracy}%</span>`).join(" ") : "")
      + md(res.recommendation || "**No weak topics — keep it up.**");
  } catch (err) { toast(err.message); }
  finally { busy("weakBtn", false); }
}

/* ============ settings ============ */
async function keyStatus() {
  try {
    const h = await api("/api/health", null, "GET");
    $("keyStatus").textContent = h.has_server_key
      ? "AI service connected."
      : "AI service not configured — the owner must set ANTHROPIC_API_KEY on the server.";
  } catch (_) { $("keyStatus").textContent = "Server unreachable."; }
}
async function wipeAll() {
  if (!confirm("Erase all documents, chats, and progress from this browser?")) return;
  await DB.clearAll(); localStorage.removeItem("learniq_roadmap"); localStorage.removeItem("learniq_key");
  toast("All local data erased."); renderXP(); renderDashboard();
}

/* ============ ask-a-doubt floating widget ============ */
let doubtMsgs = [];

function openDoubt() {                 // now a TOGGLE, anchored to the button
  const w = $("doubtWidget");
  if (w.classList.contains("open")) { closeDoubt(); return; }
  const g = getStudy();
  const topic = g.topic || g.subject || "";
  $("doubtTopic").textContent = topic ? `About ${topic} \u00b7 or ask anything` : "Ask anything";
  positionDoubt();
  w.classList.add("open"); w.setAttribute("aria-hidden", "false");
  renderDoubtLog();
  const seed = ($("homeQuery") && $("homeQuery").value.trim()) || "";
  if (seed) { $("doubtInput").value = seed; $("homeQuery").value = ""; }
  setTimeout(() => $("doubtInput").focus(), 300);
}

function positionDoubt() {
  const w = $("doubtWidget"), btn = $("homeAskBtn");
  if (!btn) return;
  if (window.innerWidth <= 560) {           // small screens: bottom sheet
    Object.assign(w.style, { left: "12px", right: "12px", bottom: "12px", top: "auto", width: "auto", height: "70vh" });
    w.style.transformOrigin = "bottom center";
    return;
  }
  const r = btn.getBoundingClientRect();
  const width = 320, gap = 8;
  let left = r.right - width;                 // right edge aligns with the button
  left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
  w.style.width = width + "px";
  w.style.height = "";
  w.style.right = "auto"; w.style.bottom = "auto";
  w.style.left = left + "px";
  w.style.top = (r.bottom + gap) + "px";      // drops just below the button
  w.style.transformOrigin = "top right";
}

function closeDoubt() {
  const w = $("doubtWidget");
  w.classList.remove("open"); w.setAttribute("aria-hidden", "true");
}

function renderDoubtLog() {
  const log = $("doubtLog");
  if (!doubtMsgs.length) {
    log.innerHTML = `<div class="doubt-empty">Ask a doubt about your topic \u2014 or anything else.</div>`;
    return;
  }
  log.innerHTML = doubtMsgs.map(m => m.role === "user"
    ? `<div class="doubt-msg user">${esc(m.content)}</div>`
    : `<div class="doubt-msg ai"><div class="md">${renderAnswer(m.content)}</div></div>`).join("");
  log.scrollTop = log.scrollHeight;
}

async function sendDoubt() {
  const q = $("doubtInput").value.trim(); if (!q) return;
  $("doubtInput").value = "";
  doubtMsgs.push({ role: "user", content: q });
  const ai = { role: "assistant", content: "" };
  doubtMsgs.push(ai);
  renderDoubtLog();
  busy("doubtSend", true, "\u2026");
  try {
    const g = getStudy();
    const topic = g.topic || g.subject || "";
    // give the model the current topic as gentle context, but it can answer anything
    const query = topic ? `${q}\n\n(My current study focus is ${topic}, but answer whatever I asked.)` : q;
    const chunks = await docsWithChunks("all");
    const history = doubtMsgs.slice(0, -2).map(m => ({ role: m.role, content: m.content }));
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, chunks, history }) });
    if (!res.ok) throw new Error((await res.json()).detail || "Request failed.");
    const reader = res.body.getReader(); const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      ai.content += dec.decode(value, { stream: true });
      renderDoubtLog();
    }
    await addEvent("chat"); renderXP();
  } catch (err) { ai.content = "> \u26a0 " + err.message; renderDoubtLog(); }
  finally { busy("doubtSend", false); }
}

/* ============ scan a question (camera + gallery, vision) ============ */
let scanStream = null, scanBlob = null;

async function startCamera() {
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const v = $("scanVideo");
    v.srcObject = scanStream; v.style.display = "block"; await v.play();
    $("scanStartCam").style.display = "none";
    $("scanSnap").style.display = "inline-flex";
    $("scanStopCam").style.display = "inline-block";
  } catch (err) {
    toast("Camera unavailable — use gallery upload instead.");
  }
}

function stopCamera() {
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  const v = $("scanVideo");
  if (v) { v.style.display = "none"; v.srcObject = null; }
  const s = $("scanStartCam"), snap = $("scanSnap"), stop = $("scanStopCam");
  if (s) s.style.display = "inline-flex";
  if (snap) snap.style.display = "none";
  if (stop) stop.style.display = "none";
}

function snapPhoto() {
  const v = $("scanVideo"), c = $("scanCanvas");
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  c.toBlob(blob => { setScanImage(blob); stopCamera(); }, "image/jpeg", 0.92);
}

function setScanImage(blob) {
  scanBlob = blob;
  const url = URL.createObjectURL(blob);
  $("scanPreview").src = url;
  $("scanPreviewWrap").style.display = "block";
  $("scanAnswer").innerHTML = "";
  $("scanPreviewWrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function downloadScan() {
  downloadPDF("Scanned Question — Answer", _out.scan, "scanned-answer");
}

async function renderScanVideos(topics) {
  const box = $("scanVideos"), title = $("scanVideosTitle");
  if (!topics || !topics.length) { box.innerHTML = ""; title.style.display = "none"; return; }
  title.style.display = "block";
  box.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:24px"><span class="spinner"></span></div>`;
  const real = await fetchVideos(topics.slice(0, 2).join(" "), 4);
  if (real) { box.innerHTML = real.map(realVideoCard).join(""); return; }
  box.innerHTML = topics.map(t => searchVideoCard(t, `${t} lecture india`, "Related lecture")).join("");
}

function clearScan() {
  scanBlob = null;
  $("scanPreviewWrap").style.display = "none";
  $("scanAnswer").innerHTML = "";
  $("scanVideos").innerHTML = ""; $("scanVideosTitle").style.display = "none";
}

async function solveScan() {
  if (!scanBlob) return toast("Capture or upload a photo first.");
  busy("scanSolveBtn", true, "Reading\u2026");
  $("scanAnswer").innerHTML = "";
  try {
    const form = new FormData();
    form.append("file", scanBlob, "question.jpg");
    const prompt = $("scanPrompt").value.trim();
    if (prompt) form.append("prompt", prompt);
    const headers = {};
    const res = await fetch("/api/solve", { method: "POST", body: form, headers });
    if (!res.ok) throw new Error((await res.json()).detail || "Couldn't read the image.");
    const { markdown } = await res.json();
    const topics = [...markdown.matchAll(/^TOPICS:\s*(.+)$/gim)]
      .flatMap(m => m[1].split(",")).map(s => s.trim()).filter(Boolean).slice(0, 4);
    const clean = markdown.replace(/^TOPICS:.*$/gim, "").trim();
    _out.scan = clean; $("scanAnswer").innerHTML = md(clean);
    $("scanDl").style.display = "inline-flex";
    renderScanVideos(topics);
    await addEvent("chat"); renderXP();
  } catch (err) { toast(err.message); }
  finally { busy("scanSolveBtn", false); }
}

/* ============ onboarding (subject + topic) ============ */
function getStudy() {
  return {
    subject: localStorage.getItem("learniq_subject") || "",
    topic: localStorage.getItem("learniq_topic") || "",
  };
}

function openOnboarding(force) {
  const s = getStudy();
  if (s.subject && !force) return;              // already set — skip unless forced
  $("onboardSubject").value = s.subject;
  $("onboardTopic").value = s.topic;
  $("onboardOverlay").classList.add("show");
  setTimeout(() => $("onboardSubject").focus(), 50);
}

function saveOnboarding() {
  const subject = $("onboardSubject").value.trim();
  const topic = $("onboardTopic").value.trim();
  localStorage.setItem("learniq_subject", subject);
  localStorage.setItem("learniq_topic", topic);
  $("onboardOverlay").classList.remove("show");
  applyStudyPersonalization();
  renderTopicBars();
  toast(subject || topic ? `Topic set${topic ? ": " + topic : ""}.` : "You can set a topic anytime.");
}

function skipOnboarding() {
  localStorage.setItem("learniq_subject", localStorage.getItem("learniq_subject") || "");
  $("onboardOverlay").classList.remove("show");
}

// A real, embeddable YouTube video card (thumbnail -> click to play inline)
function realVideoCard(v) {
  return `<div class="video-card" onclick="playVideo(this,'${v.id}')">
    <div class="video-thumb">
      <img src="${esc(v.thumbnail)}" alt="" loading="lazy">
      <span class="video-play">\u25B6</span>
    </div>
    <div class="video-label" title="${esc(v.title)}">${esc(v.title)}</div>
    <div class="video-sub">${esc(v.channel)}</div>
  </div>`;
}

// Fallback card (no API key): a VIDEO-ONLY YouTube search link (sp=EgIQAQ = Type:Video)
function searchVideoCard(label, query, sub) {
  const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(query) + "&sp=EgIQAQ%3D%3D";
  return `<a class="video-card" href="${url}" target="_blank" rel="noopener noreferrer">
    <div class="video-thumb"><span class="video-play">\u25B6</span></div>
    <div class="video-label">${esc(label)}</div>
    <div class="video-sub">${esc(sub)}</div>
  </a>`;
}

function playVideo(el, id) {
  const thumb = el.querySelector(".video-thumb");
  if (!thumb) return;
  thumb.innerHTML = `<iframe src="https://www.youtube.com/embed/${id}?autoplay=1&rel=0&modestbranding=1"
    title="video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  el.onclick = null; el.style.cursor = "default";
}

async function fetchVideos(topic, n = 4) {
  try {
    const r = await fetch(`/api/videos?topic=${encodeURIComponent(topic)}&max_results=${n}`);
    const data = await r.json();
    if (data.configured && Array.isArray(data.videos) && data.videos.length) return data.videos;
  } catch (_) { /* fall through to search links */ }
  return null;
}

let _videoTopic = null;   // guards against out-of-order async responses

async function renderVideos(explicitTopic) {
  const box = $("dashVideos"); if (!box) return;
  const g = getStudy();
  const topic = (explicitTopic || g.topic || g.subject || "").trim();
  const title = $("videosTitle");
  if (!topic) {
    if (title) title.textContent = "Recommended videos";
    box.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:32px"><span class="muted">Set a subject to get video recommendations.</span></div>`;
    return;
  }
  if (title) title.textContent = `Recommended videos on ${topic}`;
  box.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:24px"><span class="spinner"></span></div>`;
  const subj = (g.subject || "").trim();
  const query = subj && subj.toLowerCase() !== topic.toLowerCase() ? `${topic} ${subj}` : topic;
  _videoTopic = topic;
  const real = await fetchVideos(query, 4);
  if (_videoTopic !== topic) return;   // a newer request superseded this one
  if (real) { box.innerHTML = real.map(realVideoCard).join(""); return; }
  const picks = [
    ["Lecture", `${topic} lecture india`],
    ["Full course", `${topic} full course india`],
    ["Concept explained", `${topic} concept explained hindi`],
    ["Worked examples", `${topic} example problems solved`],
  ];
  box.innerHTML = picks.map(([l, q]) => searchVideoCard(l, q, `${topic} \u00b7 lecture`)).join("");
}

function applyStudyPersonalization() {
  const s = getStudy();
  const line = $("studyingLine");
  if (line) {
    line.innerHTML = s.subject
      ? `Studying <b style="color:var(--carbon)">${esc(s.subject)}</b>${s.topic ? " \u00b7 " + esc(s.topic) : ""} \u00b7 <button class="btn-link" onclick="openOnboarding(true)">change</button>`
      : `Your documents, turned into a personal learning operating system. <button class="btn-link" onclick="openOnboarding(true)">set your subject</button>`;
  }
  // prefill the home study bar with the topic (or subject) for one-click studying
  const hq = $("homeQuery");
  if (hq && !hq.value) hq.value = s.topic || s.subject || "";
  renderVideos();
}

/* ============ authentication (device-local) ============ */
let authMode = "login";

function toggleAuthMode() {
  authMode = authMode === "login" ? "signup" : "login";
  const signup = authMode === "signup";
  $("authNameRow").style.display = signup ? "block" : "none";
  $("authTagline").textContent = signup ? "Create your learning workspace" : "Sign in to your learning workspace";
  $("authSubmit").textContent = signup ? "Create account" : "Sign in";
  $("authSwitchText").textContent = signup ? "Already have an account?" : "New here?";
  $("authSwitch").textContent = signup ? "Sign in" : "Create an account";
}

async function submitAuth() {
  const email = $("authEmail").value, pw = $("authPassword").value;
  try {
    if (Cloud.enabled()) {
      if (authMode === "signup") await Cloud.signUp($("authName").value, email, pw);
      else await Cloud.signIn(email, pw);
    } else {
      if (authMode === "signup") await signup($("authName").value, email, pw);
      else await login(email, pw);
    }
    await enterApp();
  } catch (err) { toast(err.message); }
}

async function enterApp() {
  closeAuth();
  await refreshAuthButton();
  renderDashboard();
  applyStudyPersonalization();
  toast("Signed in.");
}

async function doLogout() {
  if (Cloud.enabled()) await Cloud.signOut(); else logout();
  await refreshAuthButton();
  renderDashboard();
  go("dashboard");
  toast("Logged out.");
}

function openAuth() {
  authMode = "login";
  $("authNameRow").style.display = "none";
  $("authTagline").textContent = "Sign in to your learning workspace";
  $("authSubmit").textContent = "Sign in";
  $("authSwitchText").textContent = "New here?";
  $("authSwitch").textContent = "Create an account";
  $("authOverlay").classList.add("show");
  setTimeout(() => $("authEmail").focus(), 50);
}
function closeAuth() { $("authOverlay").classList.remove("show"); }

async function refreshAuthButton() {
  const user = await whoami();
  const btn = $("authBtn");
  if (!btn) return;
  if (user) { btn.textContent = user.name ? user.name.split(" ")[0] : "Account"; btn.onclick = () => go("settings"); }
  else { btn.textContent = "Log in"; btn.onclick = openAuth; }
}

/* ============ per-page topic context ============ */
// override map: view -> topic string chosen for that page (defaults to global)
const pageTopic = {};   // deprecated: topic is global now

function activeTopic(_view) {
  const g = getStudy();
  return (g.topic || g.subject || "").trim();   // one global topic across all sections
}

function renderTopicBars() {
  document.querySelectorAll(".topicbar").forEach(bar => {
    const view = bar.id.replace("topicbar-", "");
    if (bar.dataset.editing === "1") return;   // don't clobber an open editor
    const topic = activeTopic(view);
    bar.innerHTML = topic
      ? `<span class="label">Topic</span>
         <span class="value">${esc(topic)}</span>
         <button class="btn-link" onclick="editPageTopic('${view}')">Change topic</button>
         <button class="btn-link" onclick="resetPageTopic('${view}')">Clear</button>`
      : `<span class="label">No topic set.</span>
         <button class="btn-link" onclick="editPageTopic('${view}')">Set a topic</button>`;
  });
}

function editPageTopic(view) {
  const bar = $("topicbar-" + view);
  bar.dataset.editing = "1";
  const current = activeTopic(view) || "";
  bar.innerHTML = `<span class="label">Topic for this page</span>
    <input type="text" id="topicedit-${view}" value="${esc(current)}"
           placeholder="e.g. Thermodynamics" onkeydown="if(event.key==='Enter')savePageTopic('${view}');if(event.key==='Escape'){delete this.closest('.topicbar').dataset.editing;renderTopicBars();}">
    <button class="btn btn-primary btn-sm" onclick="savePageTopic('${view}')">Set</button>
    <button class="btn-link" onclick="delete document.getElementById('topicbar-${view}').dataset.editing;renderTopicBars()">Cancel</button>`;
  setTimeout(() => $("topicedit-" + view).focus(), 30);
}

function savePageTopic(view) {
  const val = ($("topicedit-" + view) || {}).value?.trim() || "";
  const bar = $("topicbar-" + view);
  if (bar) delete bar.dataset.editing;
  localStorage.setItem("learniq_topic", val);   // GLOBAL — reflected everywhere
  reflectTopicEverywhere(view);
  toast(val ? `Topic set to: ${val}` : "Topic cleared.");
}

function resetPageTopic(view) {
  localStorage.setItem("learniq_topic", "");
  reflectTopicEverywhere(view);
  toast("Topic cleared.");
}

// push a topic change into every section, the dashboard line, and the videos
function reflectTopicEverywhere(view) {
  renderTopicBars();
  applyStudyPersonalization();       // dashboard subtitle + home bar + videos
  syncTopicToView(view);
  ["quiz", "notes", "flashcards"].forEach(v => {
    const id = v === "quiz" ? "quizDoc" : v === "notes" ? "notesDoc" : "fcDoc";
    if ($(id)) fillDocSelect(id);
  });
}

// keep page inputs in step with the chosen topic
function syncTopicToView(view) {
  const t = activeTopic(view);
  if (view === "explain" && $("eliConcept")) $("eliConcept").value = t;
  if (["quiz", "notes", "flashcards"].includes(view)) {
    const selId = view === "quiz" ? "quizDoc" : view === "notes" ? "notesDoc" : "fcDoc";
    fillDocSelect(selId);
  }
}

/* ============ unified identity ============ */
async function whoami() {
  if (typeof Cloud !== "undefined" && Cloud.enabled()) {
    const u = await Cloud.user();
    return u ? { email: u.email, name: (u.user_metadata && u.user_metadata.name) || u.email.split("@")[0] } : null;
  }
  return await currentUser();
}

/* ============ boot ============ */
window.addEventListener("DOMContentLoaded", () => {
  buildNav();
  const zone = $("uploadZone"), input = $("fileInput");
  zone.onclick = () => input.click();
  input.onchange = () => { handleFiles([...input.files]); input.value = ""; };
  ["dragover", "dragenter"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove("drag"); }));
  zone.addEventListener("drop", e => handleFiles([...e.dataTransfer.files]));
  const sZone = $("scanZone"), sFile = $("scanFile");
  if (sZone && sFile) {
    sZone.onclick = () => sFile.click();
    sFile.onchange = () => { if (sFile.files[0]) setScanImage(sFile.files[0]); sFile.value = ""; };
    ["dragover", "dragenter"].forEach(ev => sZone.addEventListener(ev, e => { e.preventDefault(); sZone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach(ev => sZone.addEventListener(ev, e => { e.preventDefault(); sZone.classList.remove("drag"); }));
    sZone.addEventListener("drop", e => { if (e.dataTransfer.files[0]) setScanImage(e.dataTransfer.files[0]); });
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeDoubt(); });
  const reanchor = () => { if ($("doubtWidget").classList.contains("open")) positionDoubt(); };
  window.addEventListener("resize", reanchor);
  window.addEventListener("scroll", reanchor, true);
  // click-away closes the popover (but not clicks on the button or inside it)
  document.addEventListener("click", e => {
    const w = $("doubtWidget");
    if (!w.classList.contains("open")) return;
    if (!w.contains(e.target) && e.target.id !== "homeAskBtn") closeDoubt();
  });
  Cloud.init().then(() => {
    renderXP(); keyStatus(); refreshAuthButton();
    go(location.hash.replace("#", "") || "dashboard");
    applyStudyPersonalization();
    openOnboarding(false);
  });
});
