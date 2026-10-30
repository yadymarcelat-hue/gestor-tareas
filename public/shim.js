/*
 * Conecta la app con Supabase.
 * La app se escribió sobre una interfaz pequeña (claude.use("db" | "user" | "assets")).
 * Este archivo implementa esa misma interfaz con Supabase: base de datos, login y archivos.
 */
(function () {
  "use strict";

  const META = { fromCache: false, hasPendingWrites: false };
  let clientPromise = null;
  let sessionPromise = null;
  let mePromise = null;
  let workspacePromise = null;
  const listeners = {}; // colección -> Set de funciones que recargan
  const WS_KEY = "pj-workspace";

  function client() {
    if (!clientPromise) {
      clientPromise = fetch("/api/config")
        .then((r) => r.json())
        .then((c) => {
          if (!c.url || !c.anonKey) throw new Error("Faltan las variables de Supabase");
          return window.supabase.createClient(c.url, c.anonKey, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
          });
        });
    }
    return clientPromise;
  }

  // Sesión obligatoria: sin sesión, manda al login.
  function session() {
    if (!sessionPromise) {
      sessionPromise = client().then(async (sb) => {
        const { data } = await sb.auth.getSession();
        if (!data.session) {
          location.replace("/login");
          return new Promise(() => {});
        }
        return data.session;
      });
    }
    return sessionPromise;
  }

  // Empresas a las que pertenece la persona y cuál está activa.
  function workspace() {
    if (!workspacePromise) {
      workspacePromise = session().then(async (s) => {
        const sb = await client();
        const uid = s.user.id;
        const [{ data: rows }, { data: profile }] = await Promise.all([
          sb.from("docs").select("workspace_id,data").eq("collection", "members").eq("id", uid),
          sb.from("profiles").select("is_superadmin").eq("id", uid).maybeSingle(),
        ]);
        const ids = (rows || []).map((r) => r.workspace_id);
        const { data: spaces } = ids.length
          ? await sb.from("workspaces").select("id,name").in("id", ids)
          : { data: [] };
        const list = (spaces || [])
          .map((w) => ({ id: w.id, name: w.name, role: ((rows || []).find((r) => r.workspace_id === w.id) || {}).data?.role || "member" }))
          .sort((a, b) => a.name.localeCompare(b.name));
        let saved = null;
        try { saved = localStorage.getItem(WS_KEY); } catch (e) {}
        const current = list.find((w) => w.id === saved) || list[0] || null;
        return { list, current, isSuperadmin: !!(profile && profile.is_superadmin) };
      });
    }
    return workspacePromise;
  }

  async function wsId() {
    const w = await workspace();
    if (!w.current) throw Object.assign(new Error("Sin empresa"), { code: "invalid_argument" });
    return w.current.id;
  }

  function toError(e) {
    const err = new Error(e.message || "Error");
    const txt = (e.message || "") + " " + (e.code || "");
    err.code = /row-level|permission|42501|sin permiso/i.test(txt) ? "invalid_argument" : "unavailable";
    return err;
  }

  function bump(collection) {
    (listeners[collection] || new Set()).forEach((fn) => fn());
  }

  function snapshot(rows) {
    const docs = rows.map((r) => ({ id: r.id, exists: true, data: () => r.data, metadata: META }));
    return { docs, size: docs.length, empty: docs.length === 0, metadata: META, docChanges: () => [] };
  }

  async function load(collection, filters) {
    const sb = await client();
    const w = await workspace();
    if (!w.current) return [];
    let q = sb.from("docs").select("id,data").eq("workspace_id", w.current.id).eq("collection", collection);
    for (const [field, value] of filters) q = q.eq("data->>" + field, String(value));
    const { data, error } = await q.limit(5000);
    if (error) throw toError(error);
    return data || [];
  }

  function randomId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-5);
  }

  function docRef(collection, id) {
    return {
      id,
      path: collection + "/" + id,
      async get() {
        const sb = await client();
        const { data, error } = await sb.from("docs").select("id,data").eq("workspace_id", await wsId()).eq("collection", collection).eq("id", id).maybeSingle();
        if (error) throw toError(error);
        return data
          ? { id, exists: true, data: () => data.data, metadata: META }
          : { id, exists: false, data: () => undefined, metadata: META };
      },
      async set(body) {
        const sb = await client();
        const { error } = await sb
          .from("docs")
          .upsert({ workspace_id: await wsId(), collection, id, data: body, updated_at: new Date().toISOString() });
        if (error) throw toError(error);
        bump(collection);
      },
      async update(patch) {
        const sb = await client();
        const { error } = await sb.rpc("doc_update", { w: await wsId(), c: collection, i: id, patch });
        if (error) throw toError(error);
        bump(collection);
      },
      async delete() {
        const sb = await client();
        const { error } = await sb.from("docs").delete().eq("workspace_id", await wsId()).eq("collection", collection).eq("id", id);
        if (error) throw toError(error);
        bump(collection);
      },
    };
  }

  function query(collection, filters) {
    return {
      path: collection,
      where(field, op, value) {
        if (op !== "==") throw new Error("Solo se admite ==");
        return query(collection, filters.concat([[field, value]]));
      },
      orderBy() { return this; },
      limit() { return this; },
      async get() { return snapshot(await load(collection, filters)); },
      doc(id) { return docRef(collection, id || randomId()); },
      async add(body) { const ref = docRef(collection, randomId()); await ref.set(body); return ref; },
      onSnapshot(next, onError) {
        let dead = false;
        let timer = null;
        let channel = null;
        const run = async () => {
          try {
            const rows = await load(collection, filters);
            if (!dead) next(snapshot(rows));
          } catch (e) {
            console.error(e);
            if (onError && !dead) onError({ code: e.code || "unavailable", message: e.message });
          }
        };
        const soon = () => { clearTimeout(timer); timer = setTimeout(run, 120); };
        (listeners[collection] = listeners[collection] || new Set()).add(soon);
        Promise.all([client(), workspace()]).then(([sb, w]) => {
          if (dead || !w.current) return;
          // Un solo filtro por canal: se escuchan los cambios de la empresa activa y se filtra la colección aquí.
          channel = sb
            .channel("docs-" + collection + "-" + randomId())
            .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "workspace_id=eq." + w.current.id },
              (payload) => {
                const row = payload.new && payload.new.collection ? payload.new : payload.old;
                if (!row || !row.collection || row.collection === collection) soon();
              })
            .subscribe();
        });
        run();
        return () => {
          dead = true;
          listeners[collection].delete(soon);
          client().then((sb) => channel && sb.removeChannel(channel));
        };
      },
    };
  }

  const db = {
    collection: (path) => query(path, []),
    doc: (path) => { const i = path.lastIndexOf("/"); return docRef(path.slice(0, i), path.slice(i + 1)); },
  };

  function getMe() {
    if (!mePromise) {
      mePromise = session().then(async (s) => {
        const sb = await client();
        const uid = s.user.id;
        const w = await workspace();
        const { data: profile } = await sb.from("profiles").select("id,name,email").eq("id", uid).maybeSingle();
        const isAdmin = !!(w.current && w.current.role === "admin");
        return {
          id: uid,
          name: (profile && profile.name) || s.user.email,
          email: s.user.email,
          avatarUrl: "",
          color: "#1667ff",
          isOwner: isAdmin,
          canEdit: isAdmin,
        };
      });
    }
    return mePromise;
  }

  const user = {
    me: getMe,
    id: async () => (await getMe()).id,
    name: async () => (await getMe()).name,
    email: async () => (await getMe()).email,
    isOwner: async () => (await getMe()).isOwner,
    canEdit: async () => (await getMe()).canEdit,
    can: async () => true,
    search: async () => [],
    async profiles(ids) {
      const list = [...new Set([].concat(ids).filter(Boolean))];
      const me = await getMe();
      const out = {};
      list.forEach((id) => { out[id] = { id, name: "", email: null, avatarUrl: "", color: "#1667ff", isMe: id === me.id, guest: false }; });
      if (!list.length) return out;
      const sb = await client();
      const { data } = await sb.from("profiles").select("id,name,email").in("id", list);
      (data || []).forEach((p) => { out[p.id] = Object.assign(out[p.id], { name: p.name || p.email || "", email: p.email }); });
      return out;
    },
  };

  const assets = {
    async upload(file, options) {
      const s = await session();
      const sb = await client();
      const type = (options && options.type) || file.type || "application/octet-stream";
      const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-120);
      const path = (await wsId()) + "/" + s.user.id + "/" + (crypto.randomUUID ? crypto.randomUUID() : randomId()) + "-" + safeName;
      const { error } = await sb.storage.from("files").upload(path, file, { contentType: type, upsert: false });
      if (error) {
        const err = new Error(error.message);
        err.code = /size|large|exceed/i.test(error.message) ? "too_large" : "upstream_error";
        throw err;
      }
      const { data } = sb.storage.from("files").getPublicUrl(path);
      return { id: path, url: data.publicUrl, sizeBytes: file.size, contentType: type };
    },
    async delete(id) {
      const sb = await client();
      await sb.storage.from("files").remove([id]);
      return { deleted: true };
    },
    async list() { return { assets: [], usage: {} }; },
  };

  window.claude = {
    async use(name) {
      try { await session(); } catch (e) { console.error(e); return null; }
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "assets") return assets;
      return null;
    },
  };

  window.appWorkspace = {
    info: workspace,
    switchTo(id) {
      try { localStorage.setItem(WS_KEY, id); } catch (e) {}
      location.replace("/");
    },
  };

  window.appAuth = {
    client,
    async token() {
      const sb = await client();
      const { data } = await sb.auth.getSession();
      return data.session ? data.session.access_token : "";
    },
    async signOut() {
      const sb = await client();
      await sb.auth.signOut();
      location.replace("/login");
    },
  };
})();
