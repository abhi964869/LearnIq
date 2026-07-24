/* LearnIQ AI — IndexedDB persistence layer.
   Stores: docs (with chunks), chats, quizzes (attempt history), events (XP/activity). */
"use strict";

const STORE_KEY = { docs: "doc_id", chats: "id", quizzes: "id", events: "id" };
const CLOUD_TABLE = { docs: "documents", chats: "chats", quizzes: "quizzes", events: "events" };

const DB = (() => {
  const NAME = "learniq", VERSION = 2;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "doc_id" });
        if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "id" });
        if (!db.objectStoreNames.contains("quizzes")) db.createObjectStore("quizzes", { keyPath: "id" });
        if (!db.objectStoreNames.contains("events")) db.createObjectStore("events", { keyPath: "id" });
        if (!db.objectStoreNames.contains("users")) db.createObjectStore("users", { keyPath: "email" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    });
  }

  async function getAll(store) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function cloudActive() {
    return typeof Cloud !== "undefined" && Cloud.enabled() && (await Cloud.active());
  }

  return {
    async put(store, value) {
      if (CLOUD_TABLE[store] && (await cloudActive())) {
        return Cloud.put(CLOUD_TABLE[store], value[STORE_KEY[store]], value);
      }
      return tx(store, "readwrite", s => s.put(value));
    },
    async del(store, key) {
      if (CLOUD_TABLE[store] && (await cloudActive())) return Cloud.del(CLOUD_TABLE[store], key);
      return tx(store, "readwrite", s => s.delete(key));
    },
    async getAll(store) {
      if (CLOUD_TABLE[store] && (await cloudActive())) return Cloud.getAll(CLOUD_TABLE[store]);
      return getAll(store);
    },
    async get(store, key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(store, "readonly").objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    },
    async clearAll() {
      for (const s of ["docs", "chats", "quizzes", "events"]) {
        await tx(s, "readwrite", st => st.clear());
      }
    },
  };
})();

/* ---- gamification: XP events + streak, derived on read ---- */
const XP_RULES = { upload: 20, chat: 5, quiz_correct: 10, quiz_done: 25, cards: 8, notes: 10, roadmap: 10 };

async function addEvent(kind, extra = {}) {
  const e = { id: crypto.randomUUID(), kind, xp: XP_RULES[kind] || 0, at: Date.now(), ...extra };
  await DB.put("events", e);
  return e;
}

function levelFor(xp) {
  let level = 1;
  while (xp >= Math.round(100 * Math.pow(level, 1.5))) { xp -= Math.round(100 * Math.pow(level, 1.5)); level++; }
  return level;
}

async function gamificationState() {
  const events = await DB.getAll("events");
  const xp = events.reduce((a, e) => a + (e.xp || 0), 0);
  const days = new Set(events.map(e => new Date(e.at).toDateString()));
  let streak = 0;
  for (let d = new Date(); ; d.setDate(d.getDate() - 1)) {
    if (days.has(d.toDateString())) streak++;
    else if (streak === 0 && d.toDateString() === new Date().toDateString()) continue;
    else break;
  }
  const badges = [];
  if (days.size >= 1) badges.push("First step");
  if (streak >= 3) badges.push("3-day streak");
  if (streak >= 7) badges.push("Week warrior");
  if (xp >= 500) badges.push("Scholar");
  if (xp >= 2000) badges.push("Master");
  return { xp, level: levelFor(xp), streak, badges, events };
}


/* ---- local account system (device-only) ----
   NOTE: This is a lightweight on-device login, not a secured server account.
   Passwords are salted + SHA-256 hashed and stored only in this browser so the
   app can personalise per person and gate access. Do not reuse an important
   password here. */
async function _hash(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function signup(name, email, password) {
  email = (email || "").trim().toLowerCase();
  if (!email || !password) throw new Error("Email and password are required.");
  if (password.length < 6) throw new Error("Password must be at least 6 characters.");
  if (await DB.get("users", email)) throw new Error("An account with this email already exists.");
  const salt = crypto.randomUUID();
  const passHash = await _hash(salt + password);
  await DB.put("users", { email, name: name || email.split("@")[0], salt, passHash, createdAt: Date.now() });
  localStorage.setItem("learniq_session", email);
  return { email, name };
}

async function login(email, password) {
  email = (email || "").trim().toLowerCase();
  const user = await DB.get("users", email);
  if (!user) throw new Error("No account found for this email. Create one first.");
  if ((await _hash(user.salt + password)) !== user.passHash) throw new Error("Incorrect password.");
  localStorage.setItem("learniq_session", email);
  return { email: user.email, name: user.name };
}

async function currentUser() {
  const email = localStorage.getItem("learniq_session");
  return email ? await DB.get("users", email) : null;
}

function logout() { localStorage.removeItem("learniq_session"); }
