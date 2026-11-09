// Lee un calendario en formato iCal (.ics) y devuelve los eventos de un día.
// Soporta horas con zona horaria (TZID), eventos de todo el día, repeticiones (RRULE),
// excepciones (EXDATE) y cambios a una sola repetición (RECURRENCE-ID).

function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseLine(line) {
  const i = line.indexOf(":");
  if (i < 0) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = head.split(";");
  const params = {};
  parts.slice(1).forEach((p) => {
    const j = p.indexOf("=");
    if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, "");
  });
  return { name: parts[0].toUpperCase(), params, value };
}

const unescapeText = (s) => String(s || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

// Diferencia (ms) entre la hora local de una zona y UTC en un instante dado.
const fmtCache = {};
function tzOffset(ms, tz) {
  let f = fmtCache[tz];
  if (!f) {
    f = fmtCache[tz] = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }
  const p = {};
  f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function validTz(tz) {
  if (!tz) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch (e) { return null; }
}

// Hora "de pared" en una zona -> instante UTC (ms).
function wallToUtc(w, tz) {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h || 0, w.mi || 0, w.s || 0);
  if (!tz) return guess;
  let t = guess - tzOffset(guess, tz);
  const o2 = tzOffset(t, tz);
  t = guess - o2;
  return t;
}

// "20261109T150000Z" | "20261109T150000" | "20261109"
function parseDate(prop, defTz) {
  if (!prop) return null;
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const w = { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  if (!m[4] || prop.params.VALUE === "DATE") return { allDay: true, w };
  if (m[7]) return { allDay: false, w, tz: "UTC", utc: Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) };
  const tz = validTz(prop.params.TZID) || defTz;
  return { allDay: false, w, tz, utc: wallToUtc(w, tz) };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || "").trim());
  if (!m) return 0;
  const ms = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const dayNum = (w) => Math.floor(Date.UTC(w.y, w.m - 1, w.d) / 86400000);
const fromDayNum = (n, w) => { const d = new Date(n * 86400000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: w.h, mi: w.mi, s: w.s }; };
const weekday = (w) => new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const wkey = (w) => `${w.y}-${w.m}-${w.d}-${w.h}-${w.mi}`;

function parseRule(v) {
  const r = {};
  String(v || "").split(";").forEach((p) => { const [k, x] = p.split("="); if (k) r[k.toUpperCase()] = x || ""; });
  return r;
}

// Genera las fechas (hora de pared) de una regla, en orden, hasta "limitDay" (número de día).
function* expand(start, rule, limitDay) {
  const freq = rule.FREQ;
  const interval = Math.max(1, parseInt(rule.INTERVAL || "1", 10) || 1);
  const byday = rule.BYDAY ? rule.BYDAY.split(",").map((x) => { const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x.trim()); return m ? { n: m[1] ? +m[1] : 0, wd: DAYS.indexOf(m[2]) } : null; }).filter(Boolean) : [];
  const bymd = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(",").map((x) => parseInt(x, 10)).filter((x) => !isNaN(x)) : [];
  const bymonth = rule.BYMONTH ? rule.BYMONTH.split(",").map((x) => parseInt(x, 10)) : [];
  const startDay = dayNum(start);
  let guard = 0;
  if (freq === "DAILY") {
    for (let n = startDay; n <= limitDay && guard < 20000; n += interval, guard++) {
      const w = fromDayNum(n, start);
      if (bymonth.length && !bymonth.includes(w.m)) continue;
      if (byday.length && !byday.some((b) => b.wd === weekday(w))) continue;
      yield w;
    }
  } else if (freq === "WEEKLY") {
    const days = byday.length ? byday.map((b) => b.wd) : [weekday(start)];
    // Semanas que empiezan en lunes (WKST=MO, el valor por defecto de Google).
    const monday = startDay - ((weekday(start) + 6) % 7);
    for (let wk = monday; wk <= limitDay && guard < 5000; wk += 7 * interval, guard++) {
      const list = days.map((d) => wk + ((d + 6) % 7)).sort((a, b) => a - b);
      for (const n of list) {
        if (n < startDay || n > limitDay) continue;
        yield fromDayNum(n, start);
      }
    }
  } else if (freq === "MONTHLY" || freq === "YEARLY") {
    const step = freq === "YEARLY" ? 12 * interval : interval;
    let y = start.y, m = start.m;
    for (; guard < 3000; guard++) {
      const months = freq === "YEARLY" && bymonth.length ? bymonth.slice().sort((a, b) => a - b) : [m];
      for (const mm of months) {
        const dim = daysInMonth(y, mm);
        let ds = [];
        if (byday.length) {
          for (const b of byday) {
            const all = [];
            for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, mm - 1, d)).getUTCDay() === b.wd) all.push(d);
            if (b.n > 0) { if (all[b.n - 1]) ds.push(all[b.n - 1]); } else if (b.n < 0) { if (all[all.length + b.n]) ds.push(all[all.length + b.n]); } else ds.push(...all);
          }
        } else if (bymd.length) {
          ds = bymd.map((d) => (d < 0 ? dim + d + 1 : d)).filter((d) => d >= 1 && d <= dim);
        } else if (start.d <= dim) ds = [start.d];
        if (rule.BYSETPOS && ds.length) { const sp = parseInt(rule.BYSETPOS, 10); ds.sort((a, b) => a - b); ds = [ds[sp > 0 ? sp - 1 : ds.length + sp]].filter(Boolean); }
        for (const d of [...new Set(ds)].sort((a, b) => a - b)) {
          const w = { y, m: mm, d, h: start.h, mi: start.mi, s: start.s };
          const n = dayNum(w);
          if (n < startDay) continue;
          if (n > limitDay) return;
          yield w;
        }
      }
      m += step;
      while (m > 12) { m -= 12; y++; }
      if (dayNum({ y, m, d: 1 }) > limitDay) return;
    }
  }
}

function meetingLink(ev) {
  const x = ev["X-GOOGLE-CONFERENCE"];
  if (x) return x.value.trim();
  const hay = [ev.LOCATION && ev.LOCATION.value, ev.DESCRIPTION && ev.DESCRIPTION.value, ev.URL && ev.URL.value].filter(Boolean).join(" ");
  const m = /https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|teams\.live\.com)\/[^\s"<>\\]+/i.exec(hay);
  return m ? m[0] : "";
}

/*
 * text: contenido .ics · day: "AAAA-MM-DD" · tz: zona horaria de quien mira · email: para saltar reuniones rechazadas.
 * Devuelve [{ id, title, start, end, allDay, location, link }] ordenados (start/end en ISO; en todo el día, "AAAA-MM-DD").
 */
export function eventsForDay(text, day, tz, email) {
  tz = validTz(tz) || "UTC";
  const [Y, M, D] = day.split("-").map(Number);
  const winStart = wallToUtc({ y: Y, m: M, d: D }, tz);
  const next = new Date(Date.UTC(Y, M - 1, D + 1));
  const winEnd = wallToUtc({ y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() }, tz);
  const targetDay = dayNum({ y: Y, m: M, d: D });

  const lines = unfold(text);
  let calTz = null;
  const events = [];
  let cur = null, depth = 0;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { _ex: [], _att: [] }; depth = 0; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) { if (line.startsWith("X-WR-TIMEZONE:")) calTz = validTz(line.slice(14).trim()); continue; }
    if (line.startsWith("BEGIN:")) { depth++; continue; }
    if (line.startsWith("END:")) { depth--; continue; }
    if (depth > 0) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "EXDATE") cur._ex.push(p);
    else if (p.name === "ATTENDEE") cur._att.push(p);
    else cur[p.name] = p;
  }
  const defTz = calTz || tz;
  const me = String(email || "").toLowerCase();

  // Repeticiones cambiadas a mano: UID -> claves de la fecha original que se reemplazan.
  const overridden = {};
  events.forEach((ev) => {
    if (ev["RECURRENCE-ID"] && ev.UID) {
      const r = parseDate(ev["RECURRENCE-ID"], defTz);
      if (r) (overridden[ev.UID.value] = overridden[ev.UID.value] || new Set()).add(r.allDay ? `d${dayNum(r.w)}` : `t${r.utc}`);
    }
  });

  const out = [];
  const push = (ev, s, e, allDay) => {
    out.push({
      id: (ev.UID ? ev.UID.value : "") + "|" + s,
      title: unescapeText(ev.SUMMARY ? ev.SUMMARY.value : "") || "(Sin título)",
      start: s, end: e, allDay,
      location: unescapeText(ev.LOCATION ? ev.LOCATION.value : ""),
      link: meetingLink(ev),
    });
  };

  for (const ev of events) {
    if (ev.STATUS && ev.STATUS.value.trim().toUpperCase() === "CANCELLED") continue;
    if (me && ev._att.some((a) => a.value.toLowerCase().replace(/^mailto:/, "") === me && (a.params.PARTSTAT || "").toUpperCase() === "DECLINED")) continue;
    const ds = parseDate(ev.DTSTART, defTz);
    if (!ds) continue;
    const de = parseDate(ev.DTEND, defTz);
    const dur = de ? (ds.allDay ? (dayNum(de.w) - dayNum(ds.w)) * 86400000 : de.utc - ds.utc) : ev.DURATION ? parseDuration(ev.DURATION.value) : ds.allDay ? 86400000 : 0;

    const ex = new Set();
    ev._ex.forEach((p) => p.value.split(",").forEach((v) => {
      const d = parseDate({ value: v, params: p.params }, defTz);
      if (d) ex.add(d.allDay ? `d${dayNum(d.w)}` : `t${d.utc}`);
    }));
    const ov = ev.RRULE && ev.UID ? overridden[ev.UID.value] : null;

    const consider = (w) => {
      if (ds.allDay) {
        const n = dayNum(w);
        const days = Math.max(1, Math.round(dur / 86400000));
        if (ex.has(`d${n}`) || (ov && ov.has(`d${n}`))) return;
        if (targetDay >= n && targetDay < n + days) {
          const endW = fromDayNum(n + days, w);
          const iso = (x) => `${x.y}-${String(x.m).padStart(2, "0")}-${String(x.d).padStart(2, "0")}`;
          push(ev, iso(w), iso(endW), true);
        }
        return;
      }
      const s = ds.tz === "UTC" ? Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) : wallToUtc(w, ds.tz);
      if (ex.has(`t${s}`) || (ov && ov.has(`t${s}`))) return;
      const e = s + Math.max(0, dur);
      if (s < winEnd && (e > winStart || (e === s && s >= winStart))) push(ev, new Date(s).toISOString(), new Date(e).toISOString(), false);
    };

    if (!ev.RRULE) { consider(ds.w); continue; }
    const rule = parseRule(ev.RRULE.value);
    let until = null;
    if (rule.UNTIL) { const u = parseDate({ value: rule.UNTIL, params: {} }, ds.tz === "UTC" ? "UTC" : ds.tz); if (u) until = u; }
    const count = rule.COUNT ? parseInt(rule.COUNT, 10) : 0;
    const limitDay = targetDay + 2;
    let i = 0;
    for (const w of expand(ds.w, rule, limitDay)) {
      if (until) {
        if (until.allDay ? dayNum(w) > dayNum(until.w) : (ds.allDay ? Date.UTC(w.y, w.m - 1, w.d) : wallToUtc(w, ds.tz === "UTC" ? null : ds.tz)) > until.utc) break;
      }
      i++;
      if (count && i > count) break;
      consider(w);
    }
  }

  const seen = new Set();
  return out
    .filter((x) => (seen.has(x.id) ? false : seen.add(x.id)))
    .sort((a, b) => (b.allDay - a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}
