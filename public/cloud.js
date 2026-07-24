/* LearnIQ AI — Supabase cloud layer.
   When SUPABASE_URL + SUPABASE_ANON_KEY are configured (via /api/config), a
   signed-in user's data is stored in Supabase and synced across devices.
   Guests (not signed in) transparently fall back to local IndexedDB, so login
   stays optional and the app works with zero configuration. */
"use strict";

const Cloud = (() => {
  let client = null;
  let ready = null;

  async function init() {
    if (ready) return ready;
    ready = (async () => {
      try {
        const cfg = await fetch("/api/config").then(r => r.json());
        if (cfg.supabase_url && cfg.supabase_anon_key && window.supabase) {
          client = window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
        }
      } catch (_) { /* offline or not configured — stay in local mode */ }
      return client;
    })();
    return ready;
  }

  const enabled = () => !!client;

  async function user() {
    if (!client) return null;
    const { data } = await client.auth.getUser();
    return data && data.user ? data.user : null;
  }

  // active = configured AND signed in (otherwise the app uses local storage)
  async function active() { return !!client && !!(await user()); }

  async function signUp(name, email, password) {
    const { data, error } = await client.auth.signUp({
      email, password, options: { data: { name } },
    });
    if (error) throw new Error(error.message);
    if (!data.session) throw new Error("Check your email to confirm your account, then sign in.");
    return data.user;
  }

  async function signIn(email, password) {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    return data.user;
  }

  async function signOut() { if (client) await client.auth.signOut(); }

  // ---- table ops: every store maps to a (user_id, row_key, payload) table ----
  async function getAll(table) {
    const u = await user(); if (!u) return [];
    const { data, error } = await client.from(table).select("payload").eq("user_id", u.id);
    if (error) throw new Error(error.message);
    return (data || []).map(r => r.payload);
  }

  async function put(table, rowKey, payload) {
    const u = await user(); if (!u) throw new Error("Not signed in.");
    const { error } = await client.from(table)
      .upsert({ user_id: u.id, row_key: String(rowKey), payload, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  }

  async function del(table, rowKey) {
    const u = await user(); if (!u) return;
    await client.from(table).delete().eq("user_id", u.id).eq("row_key", String(rowKey));
  }

  return { init, enabled, active, user, signUp, signIn, signOut, getAll, put, del };
})();
