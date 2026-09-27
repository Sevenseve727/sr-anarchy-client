// Kommlink-Client, Phase 1b-1.
// Tischgerät: Tischansicht mit Porträt-Sprechtasten. Handy: Sprechen, Bogen, Nachrichten, Lobby.
// Alle Texte von Mitspielern und der SL werden per textContent eingefügt, nie als HTML.
(function () {
  "use strict";

  const SERVER = ((window.SR_KONFIG && window.SR_KONFIG.server) || "").replace(/\/$/, "");
  const WS_URL = SERVER.replace(/^http/, "ws") + "/api/ws";
  const ATTRIBUT_VON = {
    Astralkampf: "WIL", Beschwören: "WIL", Hexerei: "WIL", Survival: "WIL", Biotech: "LOG", Elektronik: "LOG", Hacking: "LOG",
    Mechanik: "LOG", Spurenlesen: "LOG", Tasken: "LOG", Wissensfertigkeiten: "LOG", Einschüchtern: "CHA", Überreden: "CHA",
    Verhandlung: "CHA", Verkleiden: "CHA",
  };
  const SCHICKSAL = [null, "patzer", "gluecksfall", "neutral"];
  const SCHICKSAL_TEXT = { null: "–", patzer: "1 · Patzer", gluecksfall: "5–6 · Glück", neutral: "2–4 · nichts" };
  const MIKRO = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#ffe3ef" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10a7 7 0 0 0 14 0"></path><path d="M12 17v5"></path></svg>';

  // ------------------------------------------------------------------ Zustand

  const S = {
    token: lies("sr-token"),
    zustand: null,
    zeitVersatz: 0,
    verlauf: [],
    stream: null, // { id, text } während die SL spricht
    verbunden: false,
    ws: null,
    wiederholung: 0,
    reiter: lies("sr-reiter") || "sprechen",
    meldeEdge: false,
    meldeSchicksal: 0,
    aufnahme: null, // { fuer, zwischen, endgueltig }
    sperre: false, // Neuzeichnen während Aufnahme unterdrücken
    ausstehend: false,
    vorlesen: lies("sr-vorlesen") === "1",
    gelesen: Number(lies("sr-gelesen") || 0),
    bilder: {}, // id -> Object-URL oder "laedt"
    reihenfolgeEntwurf: null,
    lobbyOffen: false,
    tippen: false,
  };

  function lies(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function merke(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, String(v)); } catch (_) {} }

  // ------------------------------------------------------------------ DOM-Helfer

  function h(tag, attrs, ...kinder) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "style") el.setAttribute("style", v);
      else if (k === "html") el.innerHTML = v; // nur für feste, eigene SVG-Symbole
      else if (k === "value") el.value = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kind of kinder.flat(3)) {
      if (kind === null || kind === undefined || kind === false) continue;
      el.appendChild(typeof kind === "string" || typeof kind === "number" ? document.createTextNode(String(kind)) : kind);
    }
    return el;
  }

  let meldungTimer = null;
  function meldung(text, gut) {
    const m = document.getElementById("meldung");
    m.textContent = text;
    m.className = "meldung" + (gut ? " gut" : "");
    m.hidden = false;
    clearTimeout(meldungTimer);
    meldungTimer = setTimeout(() => (m.hidden = true), 4500);
  }

  // ------------------------------------------------------------------ Verbindung

  async function login(code) {
    const r = await fetch(SERVER + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 429) throw new Error("Zu viele Fehlversuche. Bitte in 10 Minuten erneut versuchen.");
    if (!r.ok) throw new Error("Code unbekannt. Bitte prüfen.");
    S.token = d.token;
    merke("sr-token", d.token);
    verbinde();
  }

  function abmelden() {
    S.token = null; S.zustand = null; S.verlauf = [];
    merke("sr-token", null);
    if (S.ws) { S.ws.onclose = null; S.ws.close(); }
    render();
  }

  function verbinde() {
    if (!S.token) return render();
    const ws = new WebSocket(WS_URL);
    S.ws = ws;
    ws.onopen = () => { S.wiederholung = 0; ws.send(JSON.stringify({ typ: "anmelden", token: S.token })); };
    ws.onmessage = (e) => empfange(JSON.parse(e.data));
    ws.onclose = (e) => {
      S.verbunden = false;
      render();
      if (e.code === 4001) { abmelden(); meldung("Abgemeldet: " + (e.reason || "neuer Code nötig")); return; }
      const warte = Math.min(15000, 1000 * 2 ** S.wiederholung++);
      setTimeout(() => { if (S.token && S.ws === ws) verbinde(); }, warte);
    };
  }

  function sende(n) {
    if (!S.ws || S.ws.readyState !== 1) return meldung("Keine Verbindung zum Server");
    S.ws.send(JSON.stringify(n));
  }

  function empfange(n) {
    switch (n.typ) {
      case "zustand":
        S.zustand = n.zustand;
        S.zeitVersatz = n.zustand.jetzt - Date.now();
        S.verbunden = true;
        break;
      case "verlauf":
        S.verlauf = n.ereignisse;
        break;
      case "ereignis":
        S.verlauf.push(n.ereignis);
        if (S.verlauf.length > 400) S.verlauf.shift();
        if (n.ereignis.typ === "sl") {
          if (S.stream && S.stream.id === n.ereignis.daten.id) S.stream = null;
          vorlesen(n.ereignis.daten.text);
        }
        if (n.ereignis.typ === "hinweis" || n.ereignis.typ === "system") meldung(n.ereignis.daten.text);
        if (n.ereignis.typ === "privat") meldung("Neue private Nachricht", true);
        break;
      case "ereignis_update": {
        const e = S.verlauf.find((x) => x.nr === n.nr);
        if (e) e.daten = n.daten;
        return;
      }
      case "sl_stream":
        S.stream = { id: n.id, text: n.text };
        if (aktualisiereStream()) return;
        break;
      case "fehler":
        if (n.code === "token_ungueltig") abmelden();
        meldung(n.meldung || "Fehler");
        return;
    }
    render();
  }

  // ------------------------------------------------------------------ Ableitungen

  const Z = () => S.zustand;
  const istTisch = () => Z() && Z().rolle === "tisch";
  function spieler(id) { return Z() && Z().spieler.find((s) => s.id === id); }
  function ich() { return spieler(Z().ich); }
  function scName(s) { return s ? (s.charakter ? s.charakter.bogen.name : s.name) : "?"; }
  function nameVon(d) { return spieler(d.von) ? scName(spieler(d.von)) : (d.vonName || "Unbekannt"); }
  function amZugId() { const z = Z().sitzung; return z.aktiv ? z.reihenfolge[z.amZug] : null; }
  function edgeRest(s) { const c = s && s.charakter; return c ? c.bogen.edge - (c.zustand.edgeVerbraucht || 0) : 0; }
  function letzteSL() {
    const sl = S.verlauf.filter((e) => e.typ === "sl");
    return { aktuell: S.stream ? S.stream.text : (sl.length ? sl[sl.length - 1].daten.text : ""), vorher: S.stream ? (sl.length ? sl[sl.length - 1].daten.text : "") : (sl.length > 1 ? sl[sl.length - 2].daten.text : "") };
  }
  function privateNachrichten() { return S.verlauf.filter((e) => e.sicht === "privat").slice().reverse(); }

  // ------------------------------------------------------------------ Bilder

  function bildUrl(id) {
    if (!id) return null;
    const v = S.bilder[id];
    if (v && v !== "laedt") return v;
    if (!v) {
      S.bilder[id] = "laedt";
      fetch(SERVER + "/api/bild/" + id, { headers: { Authorization: "Bearer " + S.token } })
        .then((r) => (r.ok ? r.blob() : Promise.reject()))
        .then((b) => { S.bilder[id] = URL.createObjectURL(b); render(); })
        .catch(() => { delete S.bilder[id]; });
    }
    return null;
  }

  /** Porträt aus dem gespeicherten Ausschnitt (Quadrat, Anteile von Breite/Höhe) */
  function portraet(s, groesse, klasse) {
    const el = h("div", { class: "portraet " + (klasse || ""), style: `width:${groesse}px;height:${groesse}px;font-size:${Math.round(groesse / 2.6)}px`, "aria-hidden": "true" });
    const b = s && s.bild;
    const url = b && bildUrl(b.id);
    if (url && b.ausschnitt) {
      const a = b.ausschnitt;
      const k = groesse / (a.s * a.w);
      el.style.backgroundImage = `url("${url}")`;
      el.style.backgroundSize = `${a.w * k}px ${a.h * k}px`;
      el.style.backgroundPosition = `${-a.x * a.w * k}px ${-a.y * a.h * k}px`;
    } else {
      el.textContent = scName(s).slice(0, 1).toUpperCase();
    }
    return el;
  }

  function monitor(max, schaden, art, gross) {
    const m = h("span", { class: `monitor ${art}${gross ? " gross" : ""}`, role: "img", "aria-label": `${schaden} von ${max}` });
    let i = 0;
    for (let r = 0; r < max; r += 3) {
      const reihe = h("span", { class: "reihe" });
      for (let k = r; k < Math.min(r + 3, max); k++) reihe.appendChild(h("i", { class: i++ < schaden ? "v" : "" }));
      m.appendChild(reihe);
    }
    return m;
  }

  function punkte(n) {
    const p = h("span", { class: "pp", role: "img", "aria-label": `${n} Plotpunkte` });
    for (let i = 0; i < Math.max(5, n); i++) p.appendChild(h("i", { class: i < n ? "v" : "" }));
    return p;
  }

  // ------------------------------------------------------------------ Sprache

  const Erkennung = window.SpeechRecognition || window.webkitSpeechRecognition;

  function aufnahmeStart(fuer) {
    if (!Erkennung) { S.tippen = true; render(); meldung("Spracherkennung wird hier nicht unterstützt. Bitte tippen (auf dem iPad: Safari)."); return; }
    if (S.aufnahme) return;
    const r = new Erkennung();
    r.lang = "de-DE";
    r.interimResults = true;
    r.continuous = true;
    const auf = { fuer, erkennung: r, endgueltig: "", zwischen: "", laeuft: true };
    r.onresult = (e) => {
      let zw = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) auf.endgueltig += (auf.endgueltig ? " " : "") + t.trim();
        else zw += t;
      }
      auf.zwischen = zw;
      const el = document.getElementById("zwischentext");
      if (el) el.textContent = (auf.endgueltig + " " + auf.zwischen).trim();
    };
    r.onerror = (e) => { if (e.error === "not-allowed") meldung("Kein Zugriff aufs Mikrofon. Bitte in den Browser-Einstellungen erlauben."); };
    r.onend = () => { if (auf.laeuft) { try { r.start(); } catch (_) {} } }; // Safari beendet bei Pausen
    S.aufnahme = auf;
    S.sperre = true;
    try { r.start(); } catch (_) {}
    zeigeAufnahme(true);
  }

  function aufnahmeStopp() {
    const auf = S.aufnahme;
    if (!auf || auf.stoppt) return; // Taste und Dokument melden das Loslassen beide
    auf.stoppt = true;
    auf.laeuft = false;
    try { auf.erkennung.stop(); } catch (_) {}
    // Kurz warten, damit das letzte Ergebnis noch eintrifft
    setTimeout(() => {
      const text = (auf.endgueltig + " " + auf.zwischen).trim();
      S.aufnahme = null;
      S.sperre = false;
      if (text) sende({ typ: "sprache", text, fuer: istTisch() ? auf.fuer : undefined });
      render();
    }, 450);
    zeigeAufnahme(false);
  }

  function zeigeAufnahme(an) {
    const t = document.getElementById("sprechtaste");
    if (t) t.classList.toggle("aktiv", an);
    const hw = document.getElementById("sprech-hinweis");
    if (hw) hw.textContent = an ? "HÖRT ZU …" : "HALTEN ZUM SPRECHEN";
    const zw = document.getElementById("zwischentext");
    if (zw && an) zw.textContent = "";
    if (S.aufnahme && istTisch()) render(true);
  }

  function vorlesen(text) {
    if (!istTisch() || !S.vorlesen || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(String(text || "").replace(/\[Platzhalter-SL\]\s*/g, ""));
    u.lang = "de-DE";
    const stimme = speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith("de"));
    if (stimme) u.voice = stimme;
    speechSynthesis.speak(u);
  }

  // ------------------------------------------------------------------ Rendering

  function render(erzwingen) {
    if (S.sperre && !erzwingen) { S.ausstehend = true; return; }
    const app = document.getElementById("app");
    const aktiv = document.activeElement;
    const fokus = aktiv && aktiv.id;
    const auswahl = aktiv && typeof aktiv.selectionStart === "number" ? [aktiv.selectionStart, aktiv.selectionEnd] : null;
    const scroll = window.scrollY;
    const feed = document.getElementById("tisch-feed");
    const feedUnten = !feed || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    const feedPos = feed ? feed.scrollTop : 0;
    app.textContent = "";
    if (!SERVER || SERVER.includes("DEIN-NAME")) {
      app.appendChild(h("div", { class: "login" }, h("div", { class: "glas karte ecken" }, h("h1", null, "Nicht eingerichtet"), h("p", null, "In config.js fehlt die Adresse des Servers."))));
      return;
    }
    if (!S.token) return app.appendChild(renderLogin());
    if (!Z()) return app.appendChild(h("div", { class: "login" }, h("p", { class: "etikett" }, "Verbinde …")));
    app.appendChild(istTisch() ? renderTisch() : renderHandy());
    if (fokus) {
      const el = document.getElementById(fokus);
      if (el) { el.focus({ preventScroll: true }); if (auswahl && el.setSelectionRange) { try { el.setSelectionRange(auswahl[0], auswahl[1]); } catch (_) {} } }
    }
    window.scrollTo(0, scroll);
    const neuFeed = document.getElementById("tisch-feed");
    if (neuFeed) neuFeed.scrollTop = feedUnten ? neuFeed.scrollHeight : feedPos;
  }

  /** Nur den laufenden SL-Text austauschen, ohne alles neu zu zeichnen */
  function aktualisiereStream() {
    const el = document.getElementById("sl-text");
    if (!el || !S.stream) return false;
    const feed = document.getElementById("tisch-feed");
    const unten = feed && feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    el.textContent = S.stream.text;
    if (unten) feed.scrollTop = feed.scrollHeight;
    return true;
  }

  function renderLogin() {
    const eingabe = h("input", { id: "code", type: "text", autocomplete: "one-time-code", autocapitalize: "characters", placeholder: "XXXX-XXXX", "aria-label": "Code" });
    const knopf = h("button", { class: "knopf voll", type: "submit" }, "Einloggen");
    return h("div", { class: "login" }, h("form", {
      class: "glas karte ecken",
      onsubmit: async (e) => { e.preventDefault(); knopf.disabled = true; try { await login(eingabe.value); } catch (err) { meldung(err.message); } finally { knopf.disabled = false; } },
    }, h("p", { class: "etikett" }, "Kommlink · Anmeldung"), h("h1", null, "Shadowrun Anarchy"),
    h("p", { class: "leise" }, "Gib deinen Spielercode ein, oder den Tisch-Code für das zentrale Gerät."), eingabe, knopf));
  }

  // ---------- Gemeinsame Bausteine

  function probeText(p) {
    let gegen;
    if (p.gegen.art === "schwierigkeit") gegen = { 4: "Sehr Einfach", 6: "Einfach", 8: "Durchschnittlich", 10: "Schwierig", 12: "Sehr Schwierig" }[p.gegen.wert] + ` (${p.gegen.wert})`;
    else if (p.gegen.art === "angriff") gegen = `den Angriff von ${p.gegen.name} (${p.gegen.erfolge} Erfolge)`;
    else if (p.gegen.art === "npc") gegen = `${p.gegen.name} (${p.gegen.wert} Würfel)`;
    else gegen = `Gegner-Pool ${p.gegen.wert}`;
    return { pool: `${p.bezeichnung} = ${p.pool} Würfel`, gegen: `gegen ${gegen} · Regelwerk ${p.seite || "S. 50"}` };
  }

  // ---------- Chronik

  const CHRONIK_TYPEN = ["sitzung_start", "sitzung_ende", "runde", "sl", "erzaehlung", "probe", "npc_angriff", "plotpunkt", "plotpunkt_belohnung", "einspruch_ergebnis", "freie_rede", "sl_hinweis"];

  function chronikEintrag(e, neu) {
    const d = e.daten || {};
    switch (e.typ) {
      case "sitzung_start": return h("div", { class: "ch-sys" }, `Sitzung ${d.nr} · ${new Date(e.zeit).toLocaleDateString("de-DE")}`);
      case "sitzung_ende": return h("div", { class: "ch-sys" }, `Sitzung ${d.nr} beendet`);
      case "runde": return h("div", { class: "ch-sys" }, `— Runde ${d.runde} —`);
      case "sl": return h("p", { class: "ch-sl" + (neu ? " neu" : "") }, d.text);
      case "erzaehlung": return h("p", { class: "ch-erz" }, h("b", null, nameVon(d) + ": "), d.korrigiert || d.text);
      case "probe": {
        const erg = d.art === "verteidigung" ? (d.vergleich.getroffen ? `getroffen, ${d.vergleich.netto} netto` : "abgewehrt") : (d.vergleich.gelungen ? `gelungen, ${d.vergleich.netto} netto` : "misslungen");
        return h("p", { class: "ch-probe" }, `${nameVon(d)} · ${d.bezeichnung}: ${d.eigen.erfolge} gegen ${d.gegner.erfolge}, ${erg}${(d.folgen || []).length ? ". " + d.folgen.join(". ") : ""}`);
      }
      case "npc_angriff": return h("p", { class: "ch-probe" }, `${d.name} greift ${spieler(d.ziel) ? scName(spieler(d.ziel)) : (d.zielName || "Unbekannt")} an`);
      case "plotpunkt": return h("p", { class: "ch-probe" }, `${nameVon(d)} setzt Plotpunkt ein: ${(Z().effekte || {})[d.effekt] || d.effekt}`);
      case "plotpunkt_belohnung": return h("p", { class: "ch-probe" }, `Plotpunkt für ${nameVon(d)}: ${d.grund}`);
      case "einspruch_ergebnis": return h("p", { class: "ch-probe", style: "color:var(--amber);border-color:var(--amber)" }, `Einspruch ${d.angenommen ? "angenommen" : "abgelehnt"}: ${d.begruendung}`);
      case "freie_rede": return h("div", { class: "ch-sys" }, d.an ? "Freie Rede" : "Freie Rede beendet");
      case "sl_hinweis": return h("p", { class: "ch-probe", style: "color:var(--amber);border-color:var(--amber)" }, `Rückmeldung ${d.quelle === "ki" ? "der SL" : "des Systems"} (Playtest): ${d.text}`);
      default: return null;
    }
  }

  /** Verlauf mit dem laufenden SL-Text am Ende; die letzte SL-Antwort ist hervorgehoben */
  function renderChronik(anzahl) {
    const liste = S.verlauf.filter((e) => CHRONIK_TYPEN.includes(e.typ)).slice(-anzahl);
    const letzteSL = [...liste].reverse().find((e) => e.typ === "sl");
    const box = h("div", { class: "chronik" }, liste.map((e) => chronikEintrag(e, !S.stream && e === letzteSL)));
    if (S.stream && !S.verlauf.some((e) => e.typ === "sl" && e.daten.id === S.stream.id)) {
      box.appendChild(h("p", { class: "ch-sl neu", id: "sl-text" }, S.stream.text));
    }
    if (!liste.length && !S.stream) box.appendChild(h("p", { class: "leise" }, "Noch nichts passiert."));
    return box;
  }

  async function chronikLaden() {
    const r = await fetch(SERVER + "/api/chronik", { headers: { Authorization: "Bearer " + S.token } });
    if (!r.ok) throw new Error("Chronik konnte nicht geladen werden");
    return r.text();
  }

  function renderChronikReiter(rumpf) {
    rumpf.appendChild(h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
      h("button", { class: "knopf cyan", onclick: async () => {
        try {
          const text = await chronikLaden();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
          a.download = `chronik-${(Z().szene.run || "run").toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-")}.md`;
          document.body.appendChild(a); a.click(); a.remove();
        } catch (e) { meldung(e.message); }
      } }, "Als Datei speichern"),
      h("button", { class: "knopf", onclick: async () => {
        try { await navigator.clipboard.writeText(await chronikLaden()); meldung("Chronik kopiert", true); } catch (e) { meldung("Kopieren nicht möglich"); }
      } }, "Kopieren")));
    rumpf.appendChild(h("p", { class: "leise", style: "font-size:.85rem" }, "Öffentlicher Verlauf des Runs als Markdown, ohne private Nachrichten. Als Referenz für eure Gruppe, für Bildprompts und für spätere Runs."));
    rumpf.appendChild(h("section", { class: "glas karte" }, renderChronik(400)));
  }

  // ---------- Einspruch und Abstimmung

  function renderAbstimmung(tisch) {
    const a = Z().abstimmung;
    if (!a) return null;
    const abgegeben = Object.keys(a.stimmen).length;
    const art = a.art === "regelpruefung" ? "Regelprüfung" : "Zurückspulen";
    const karte = h("section", { class: "glas karte", style: "border-color:var(--amber)" },
      h("p", { class: "etikett", style: "color:var(--amber)" }, `Einspruch · ${art} · ${abgegeben} von ${a.teilnehmer.length} Stimmen`),
      h("p", null, `${scName(spieler(a.von))}: "${a.begruendung}"`),
      h("p", { class: "mono leise", style: "font-size:.8rem" }, a.teilnehmer.map((t) => `${scName(spieler(t))} ${t in a.stimmen ? (a.stimmen[t] ? "✓" : "✗") : "…"}`).join("   ")));
    if (tisch) return karte;
    const ichId = Z().ich;
    if (a.teilnehmer.includes(ichId) && !(ichId in a.stimmen)) {
      karte.appendChild(h("div", { style: "display:flex;gap:8px" },
        h("button", { class: "knopf voll", onclick: () => sende({ typ: "stimme", ja: true }) }, "Zustimmen"),
        h("button", { class: "knopf", onclick: () => sende({ typ: "stimme", ja: false }) }, "Ablehnen")));
    }
    if (Z().overrideSpieler === ichId && abgegeben < a.teilnehmer.length) {
      karte.appendChild(h("p", { class: "leise", style: "font-size:.85rem" }, "Es fehlen Stimmen. Als Override kannst du entscheiden:"));
      karte.appendChild(h("div", { style: "display:flex;gap:8px" },
        h("button", { class: "knopf amber", onclick: () => { if (confirm("Einspruch per Override annehmen?")) sende({ typ: "override", ja: true }); } }, "Override: annehmen"),
        h("button", { class: "knopf", onclick: () => { if (confirm("Einspruch per Override ablehnen?")) sende({ typ: "override", ja: false }); } }, "Override: ablehnen")));
    }
    return karte;
  }

  function zeigeEinspruch() {
    let art = "zurueckspulen";
    const feld = h("input", { type: "text", placeholder: "Kurz begründen, z. B. Kessler ist doch längst tot", "aria-label": "Begründung" });
    const knopfArt = (wert, text, erklaerung) => h("button", {
      class: "knopf" + (art === wert ? " an" : ""), style: "text-align:left;padding:8px 12px;display:flex;flex-direction:column;align-items:flex-start;gap:2px",
      onclick: (e) => { art = wert; e.currentTarget.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("an")); e.currentTarget.classList.add("an"); },
    }, h("span", null, text), h("span", { class: "leise", style: "font-weight:400;font-size:.8rem" }, erklaerung));
    dialog(h("div", { class: "glas karte ecken dialog" },
      h("h2", null, "Einspruch gegen die letzte SL-Antwort"),
      h("div", { style: "display:grid;gap:8px" },
        knopfArt("zurueckspulen", "Zurückspulen", "Antwort verwerfen, die KI antwortet neu. Würfel bleiben stehen."),
        knopfArt("regelpruefung", "Regelprüfung", "Die KI prüft ihre Regelanwendung am Regelwerk und korrigiert.")),
      feld,
      h("p", { class: "leise", style: "font-size:.85rem" }, "Alle Teilnehmer stimmen ab; es gilt die Mehrheit, Gleichstand lehnt ab."),
      h("div", { style: "display:flex;gap:8px" },
        h("button", { class: "knopf voll", onclick: () => { if (!feld.value.trim()) return meldung("Bitte kurz begründen"); sende({ typ: "einspruch", art, begruendung: feld.value.trim() }); schliesseDialog(); } }, "Einspruch einlegen"),
        h("button", { class: "knopf", onclick: schliesseDialog }, "Abbrechen"))));
  }

  function zeigeKorrektur(k) {
    let edge = k.edge, schicksal = SCHICKSAL.indexOf(k.schicksal === "neutral" ? "neutral" : k.schicksal);
    if (schicksal < 0) schicksal = 0;
    const inhalt = h("div", { class: "glas karte ecken dialog" });
    const zeichne = () => {
      inhalt.textContent = "";
      inhalt.append(
        h("h2", null, "Meldung korrigieren"),
        h("p", { class: "leise" }, `Bisher: ${k.erfolge} Erfolge${k.edge ? ", mit Edge" : ""}${k.schicksal ? ", Schicksalswürfel " + SCHICKSAL_TEXT[k.schicksal] : ""}. Die Würfel der Gegenseite bleiben, die SL erzählt neu.`),
        h("div", { class: "schalter" },
          h("button", { class: "knopf" + (edge ? " an" : ""), onclick: () => { edge = !edge; zeichne(); } }, h("span", null, "Edge eingesetzt"), h("span", null, edge ? "AN" : "AUS")),
          h("button", { class: "knopf" + (schicksal ? " an" : ""), onclick: () => { schicksal = (schicksal + 1) % SCHICKSAL.length; zeichne(); } }, h("span", null, "Schicksalswürfel"), h("span", null, SCHICKSAL_TEXT[SCHICKSAL[schicksal]]))),
        h("div", { class: "chips" }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => h("button", { class: "knopf", onclick: () => { sende({ typ: "probe_korrigieren", erfolge: n, edge, schicksal: SCHICKSAL[schicksal] }); schliesseDialog(); } }, n))),
        h("button", { class: "knopf", onclick: schliesseDialog }, "Abbrechen"));
    };
    zeichne();
    dialog(inhalt);
  }

  function renderMitschriften(nurEigene) {
    const liste = (Z().mitschriften || []).filter((m) => !nurEigene || m.von === Z().ich || m.durch === Z().ich);
    return liste.map((m) => {
      const rest = Math.max(0, m.faellig - (Date.now() + S.zeitVersatz));
      return h("div", { class: "mitschrift" },
        h("span", null, h("span", { class: "etikett" }, `Mitschrift · ${scName(spieler(m.von))}`), " ", h("span", { class: "zitat" }, `"${m.text}"`)),
        h("button", { class: "knopf", onclick: () => sende({ typ: "mitschrift_abbrechen", id: m.id }) }, "Rückgängig"),
        h("div", { class: "balken" }, h("span", { style: `animation-duration:${rest}ms` })));
    });
  }

  // ---------- Tischansicht

  function renderTisch() {
    const z = Z();
    const sz = z.sitzung;
    const sl = letzteSL();
    const dran = amZugId();
    const szene = z.szene || {};
    const kopf = h("header", { class: "tisch-kopf" },
      h("div", { style: "display:flex;align-items:baseline;gap:16px;flex-wrap:wrap" },
        h("span", { class: "ort" }, szene.ort || "Kommlink"),
        szene.zeit ? h("span", { class: "mono leise" }, szene.zeit) : null),
      h("div", { class: "daten" },
        szene.run ? h("span", null, `RUN: ${szene.run.toUpperCase()}`) : null,
        szene.szene ? h("span", null, `SZENE ${szene.szene}`) : null,
        sz.aktiv ? h("span", null, `RUNDE ${sz.runde}`) : h("span", null, "KEINE SITZUNG"),
        sz.freieRede ? h("span", { class: "sl" }, "FREIE REDE") : null,
        h("span", { class: "sl" }, `SL-PLOTPUNKTE ${z.slPlotpunkte}`),
        h("button", { class: "knopf" + (S.vorlesen ? " cyan" : ""), onclick: () => { S.vorlesen = !S.vorlesen; merke("sr-vorlesen", S.vorlesen ? "1" : "0"); if (!S.vorlesen && "speechSynthesis" in window) speechSynthesis.cancel(); render(); } }, S.vorlesen ? "Vorlesen an" : "Vorlesen aus"),
        h("button", { class: "knopf", onclick: () => { S.lobbyOffen = !S.lobbyOffen; render(); } }, "Lobby"),
        h("span", { class: "punkt" + (S.verbunden ? " an" : ""), title: S.verbunden ? "verbunden" : "getrennt" })));

    const haupt = h("main", { class: "tisch-haupt" });
    if (S.lobbyOffen || !sz.aktiv) {
      haupt.appendChild(renderLobbyKarte(true));
    } else {
      haupt.appendChild(h("section", { class: "glas tisch-sl", id: "tisch-feed" },
        h("p", { class: "etikett", style: "margin-bottom:12px" }, S.stream ? "Chronik ▸ Spielleitung live" : (z.slDenkt ? "Chronik ▸ Spielleitung denkt nach …" : "Chronik")),
        renderChronik(80)));
    }
    if (z.offeneProbe) {
      const p = z.offeneProbe;
      const t = probeText(p);
      haupt.appendChild(h("section", { class: "probe" },
        h("div", { class: "seite" }, "PROBE", h("br"), scName(spieler(p.spieler)).toUpperCase()),
        h("div", { class: "inhalt" }, h("div", { class: "pool" }, t.pool), h("div", { class: "gegen" }, t.gegen + " · würfeln und Erfolge ansagen"))));
    }
    renderMitschriften(false).forEach((m) => haupt.appendChild(m));
    const abst = renderAbstimmung(true);
    if (abst) haupt.appendChild(abst);

    const team = h("aside", { class: "tisch-team", "aria-label": "Team" },
      h("p", { class: "etikett" }, `Team ▸ ${z.spieler.length} Runner · Porträt antippen zum Sprechen`),
      z.spieler.map((s) => renderRunner(s, dran, sz)),
      (z.npcs || []).length ? h("p", { class: "etikett", style: "margin-top:8px;color:var(--magenta)" }, "Gegner") : null,
      (z.npcs || []).map((n) => h("div", { class: "runner", style: "border-color:rgba(255,46,136,.4);padding:8px 12px;align-items:center" },
        h("span", { class: "name", style: "flex:1" }, n.name),
        h("span", { class: "mono", style: `font-size:.8rem;color:${n.stufe === "außer Gefecht" ? "var(--leise)" : n.stufe === "unverletzt" ? "var(--cyan-hell)" : "var(--schaden)"}` }, n.stufe.toUpperCase()))));

    return h("div", { class: "tisch" }, kopf, h("div", { class: "tisch-rumpf" }, haupt, team));
  }

  function renderRunner(s, dran, sz) {
    const c = s.charakter;
    const passiv = sz.aktiv && !sz.reihenfolge.includes(s.id);
    const nimmtAuf = S.aufnahme && S.aufnahme.fuer === s.id;
    const klasse = "runner" + (s.id === dran ? " aktiv" : "") + (passiv ? " passiv" : "") + (nimmtAuf ? " nimmt-auf" : "");
    const knopf = h("button", {
      class: klasse,
      "aria-label": nimmtAuf ? `Aufnahme für ${scName(s)} beenden` : `Für ${scName(s)} sprechen`,
      disabled: !sz.aktiv || passiv || (S.aufnahme && !nimmtAuf) || null,
      onclick: () => (nimmtAuf ? aufnahmeStopp() : aufnahmeStart(s.id)),
    }, portraet(s, 64, s.id === dran ? "aktiv" : ""));
    const kern = h("div", { class: "kern" },
      h("div", { style: "display:flex;justify-content:space-between;align-items:baseline;gap:8px" },
        h("span", { class: "name" }, scName(s)),
        nimmtAuf ? h("span", { class: "marke rec" }, "HÖRT ZU") : (s.id === dran ? h("span", { class: "marke" }, "AM ZUG") : (passiv ? h("span", { class: "mono leise" }, "IM HINTERGRUND") : null))));
    if (nimmtAuf) kern.appendChild(h("div", { id: "zwischentext", class: "zwischentext", style: "text-align:left;padding:0" }, ""));
    if (c) {
      kern.appendChild(h("div", { class: "werte" },
        h("span", null, "K"), monitor(c.zustand.monitore.K.max, c.zustand.monitore.K.schaden, "k"),
        h("span", null, "G"), monitor(c.zustand.monitore.G.max, c.zustand.monitore.G.schaden, "g"),
        h("span", null, "P"), monitor(c.zustand.panzerung.max, c.zustand.panzerung.schaden, "p")));
      kern.appendChild(h("div", { class: "zeile" }, h("span", null, "PLOT ", punkte(s.plotpunkte)), h("span", null, `EDGE ${edgeRest(s)}/${c.bogen.edge}`)));
    } else {
      kern.appendChild(h("span", { class: "mono leise" }, "Kein Charakterbogen"));
    }
    knopf.appendChild(kern);
    return knopf;
  }

  // ---------- Handyansicht

  function renderHandy() {
    const me = ich();
    const sz = Z().sitzung;
    const dran = amZugId();
    const c = me && me.charakter;
    let status = "Keine laufende Sitzung";
    if (sz.aktiv) status = sz.freieRede ? `Runde ${sz.runde} · Freie Rede` : (dran === Z().ich ? `Runde ${sz.runde} · Du bist dran` : `Runde ${sz.runde} · Am Zug: ${scName(spieler(dran))}`);

    const kopf = h("header", { class: "handy-kopf" },
      portraet(me, 52, "aktiv"),
      h("div", { class: "wer" }, h("div", { class: "name" }, scName(me)), h("div", { class: "status" + (dran === Z().ich ? " du" : "") }, status)),
      c ? h("div", { class: "konten" }, h("span", null, "PP ", punkte(me.plotpunkte)), h("span", null, `EDGE ${edgeRest(me)}/${c.bogen.edge}`), h("span", { class: "punkt" + (S.verbunden ? " an" : "") })) : null);

    const monitore = c ? h("div", { class: "handy-monitore" },
      h("span", null, "K"), monitor(c.zustand.monitore.K.max, c.zustand.monitore.K.schaden, "k"), h("span", null, `${c.zustand.monitore.K.schaden}/${c.zustand.monitore.K.max}`),
      h("span", null, "G"), monitor(c.zustand.monitore.G.max, c.zustand.monitore.G.schaden, "g"), h("span", null, `${c.zustand.monitore.G.schaden}/${c.zustand.monitore.G.max}`)) : null;

    const rumpf = h("main", { class: "handy-rumpf" });
    if (S.reiter === "sprechen") renderSprechen(rumpf);
    if (S.reiter === "bogen") renderBogen(rumpf);
    if (S.reiter === "nachrichten") renderNachrichten(rumpf);
    if (S.reiter === "lobby") rumpf.appendChild(renderLobbyKarte(false));
    if (S.reiter === "chronik") renderChronikReiter(rumpf);

    const neu = privateNachrichten().filter((e) => e.nr > S.gelesen).length;
    const reiter = [["sprechen", "Sprechen"], ["chronik", "Chronik"], ["bogen", "Bogen"], ["nachrichten", "Privat"], ["lobby", "Lobby"]];
    const nav = h("nav", { class: "handy-nav", role: "tablist" }, reiter.map(([k, t]) => h("button", {
      role: "tab", "aria-selected": String(S.reiter === k),
      onclick: () => { S.reiter = k; merke("sr-reiter", k); if (k === "nachrichten") markiereGelesen(); render(); },
    }, t, k === "nachrichten" && neu ? h("span", { class: "badge" }, neu) : null)));

    return h("div", { class: "handy" }, kopf, monitore, rumpf, nav);
  }

  function renderSprechen(rumpf) {
    const z = Z();
    const sl = letzteSL();
    rumpf.appendChild(h("section", { class: "glas sl-karte" },
      h("p", { class: "etikett", style: "margin-bottom:6px" }, S.stream ? "Spielleitung ▸ live" : (z.slDenkt ? "Spielleitung ▸ denkt nach …" : "Spielleitung")),
      h("p", { class: "text", id: "sl-text" }, sl.aktuell || (z.sitzung.aktiv ? "Warte auf die Spielleitung …" : "Die Sitzung wird in der Lobby gestartet."))));

    const p = z.offeneProbe;
    if (p && p.spieler === z.ich) rumpf.appendChild(renderMeineProbe(p));
    else if (p) {
      const t = probeText(p);
      rumpf.appendChild(h("section", { class: "probe", style: "padding:10px 14px" }, h("div", { class: "titel" }, `PROBE FÜR ${scName(spieler(p.spieler)).toUpperCase()}`), h("div", { class: "gegen" }, t.pool)));
    }
    renderMitschriften(true).forEach((m) => rumpf.appendChild(m));
    const abst = renderAbstimmung(false);
    if (abst) rumpf.appendChild(abst);
    if (z.korrigierbar && !(p && p.spieler === z.ich)) {
      const k = z.korrigierbar;
      rumpf.appendChild(h("div", { class: "mitschrift", style: "border-color:var(--magenta)" },
        h("span", { class: "leise" }, `Deine letzte Meldung: ${k.erfolge} Erfolge${k.edge ? " mit Edge" : ""}. Vergessen, Edge oder den Schicksalswürfel anzusagen?`),
        h("button", { class: "knopf magenta", onclick: () => zeigeKorrektur(k) }, "Korrigieren")));
    }

    if (!z.sitzung.aktiv) return;
    rumpf.appendChild(h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
      h("button", { class: "knopf cyan", disabled: amZugId() !== z.ich || !!z.offeneProbe || null, onclick: () => sende({ typ: "zug_beenden" }) }, "Zug beenden"),
      h("button", { class: "knopf", onclick: () => zeigePlotpunkte() }, "Plotpunkt einsetzen"),
      z.ki ? h("button", { class: "knopf amber", disabled: !!z.abstimmung || null, onclick: () => zeigeEinspruch() }, "Einspruch") : null));

    // Die Sprechtaste bleibt immer sichtbar über der Reiterleiste
    const leiste = h("div", { class: "sprechleiste" });
    if (Erkennung && !S.tippen) {
      const taste = h("button", {
        id: "sprechtaste", class: "sprechtaste" + (S.aufnahme ? " aktiv" : ""), "aria-label": "Halten zum Sprechen", html: MIKRO,
        onpointerdown: (e) => { e.preventDefault(); try { e.target.setPointerCapture(e.pointerId); } catch (_) {} aufnahmeStart(z.ich); },
        onpointerup: () => aufnahmeStopp(),
        onpointercancel: () => aufnahmeStopp(),
        oncontextmenu: (e) => e.preventDefault(),
      });
      leiste.append(taste, h("div", { class: "rechts" },
        h("div", { id: "sprech-hinweis", class: "sprech-hinweis" }, "HALTEN ZUM SPRECHEN"),
        h("div", { id: "zwischentext", class: "zwischentext leise", style: "font-size:.85rem" }, 'z. B. "Vier Erfolge mit Edge"'),
        h("button", { class: "knopf", style: "min-height:32px;align-self:flex-start;padding:0 10px;font-size:.8rem", onclick: () => { S.tippen = true; render(); } }, "Stattdessen tippen")));
    } else {
      const feld = h("input", { id: "tipp-feld", type: "text", placeholder: "Was tut dein Charakter?", "aria-label": "Text statt Sprache" });
      leiste.append(h("div", { class: "rechts" },
        h("form", { class: "tippen", onsubmit: (e) => { e.preventDefault(); if (feld.value.trim()) { sende({ typ: "sprache", text: feld.value.trim() }); feld.value = ""; } } },
          feld, h("button", { class: "knopf voll", type: "submit" }, "Senden")),
        Erkennung ? h("button", { class: "knopf", style: "min-height:32px;align-self:flex-start;padding:0 10px;font-size:.8rem", onclick: () => { S.tippen = false; render(); } }, "Zurück zur Sprechtaste") : null));
    }
    rumpf.appendChild(leiste);
  }

  function renderMeineProbe(p) {
    const t = probeText(p);
    const melde = (n) => { sende({ typ: "probe_melden", erfolge: n, edge: S.meldeEdge, schicksal: SCHICKSAL[S.meldeSchicksal] }); S.meldeEdge = false; S.meldeSchicksal = 0; };
    const chips = h("div", { class: "chips" }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => h("button", { class: "knopf", onclick: () => melde(n) }, n)));
    const mehr = h("button", { class: "knopf", style: "min-height:36px", onclick: () => { const x = Number.parseInt(prompt("Wie viele Erfolge?") || "", 10); if (Number.isInteger(x) && x >= 0) melde(x); } }, "10 oder mehr");
    const schalter = h("div", { class: "schalter" },
      h("button", { class: "knopf" + (S.meldeEdge ? " an" : ""), "aria-pressed": String(S.meldeEdge), onclick: () => { S.meldeEdge = !S.meldeEdge; render(); } }, h("span", null, "Edge eingesetzt"), h("span", null, S.meldeEdge ? "AN" : "AUS")),
      h("button", { class: "knopf" + (S.meldeSchicksal ? " an" : ""), "aria-pressed": String(!!S.meldeSchicksal), onclick: () => { S.meldeSchicksal = (S.meldeSchicksal + 1) % SCHICKSAL.length; render(); } }, h("span", null, "Schicksalswürfel"), h("span", null, SCHICKSAL_TEXT[SCHICKSAL[S.meldeSchicksal]])));
    return h("section", { class: "probe" },
      h("div", { style: "display:flex;justify-content:space-between;align-items:baseline" }, h("span", { class: "titel" }, "PROBE FÜR DICH"), h("span", { class: "mono gegen" }, p.seite || "")),
      h("div", { class: "pool" }, t.pool),
      h("div", { class: "gegen" }, t.gegen.replace(/ · Regelwerk.*$/, "") + " · würfle und sag deine Erfolge an"),
      h("div", { class: "mono gegen", style: "font-size:.75rem" }, "ODER ANTIPPEN:"),
      schalter, chips, mehr,
      h("button", { class: "knopf", style: "min-height:36px", onclick: () => sende({ typ: "probe_tool", edge: S.meldeEdge, schicksal: !!S.meldeSchicksal }) }, "Online: das Tool würfeln lassen"));
  }

  function zeigePlotpunkte() {
    const z = Z();
    const effekte = Object.entries(z.effekte || {}).filter(([k]) => k !== "lebe_gefaehrlich" && k !== "kreativ");
    const ziel = h("select", { "aria-label": "Ziel für Erste Hilfe" }, z.spieler.filter((s) => s.charakter).map((s) => h("option", { value: s.id }, scName(s))));
    ziel.value = z.ich;
    const mon = h("select", { "aria-label": "Monitor" }, h("option", { value: "K" }, "Körperlich"), h("option", { value: "G" }, "Geistig"));
    const notiz = h("input", { type: "text", placeholder: "Was passiert? (optional)", "aria-label": "Notiz" });
    dialog(h("div", { class: "glas karte ecken dialog" },
      h("h2", null, `Plotpunkt einsetzen (${ich().plotpunkte})`),
      h("p", { class: "leise" }, "Kostet 1 Plotpunkt, er geht an die Spielleitung (S. 47 f.). Lebe gefährlich wählst du bei der Probe über den Schicksalswürfel."),
      notiz,
      h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:8px" }, ziel, mon),
      h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:8px" }, effekte.map(([k, t]) => h("button", {
        class: "knopf magenta", disabled: ich().plotpunkte < 1 || null,
        onclick: () => { sende({ typ: "plotpunkt", effekt: k, notiz: notiz.value, ziel: ziel.value, monitor: mon.value }); schliesseDialog(); },
      }, t))),
      h("button", { class: "knopf", onclick: schliesseDialog }, "Abbrechen")));
  }

  // ---------- Bogen

  function renderBogen(rumpf) {
    const me = ich();
    const c = me && me.charakter;
    const url = me.bild && bildUrl(me.bild.id);
    rumpf.appendChild(h("figure", { class: "sin" }, url ? h("img", { src: url, alt: `Bild von ${scName(me)}` }) : h("div", { class: "sin-leer" }, "Noch kein Bild. Lade eine SIN-Karte oder ein Porträt hoch.")));
    rumpf.appendChild(h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
      h("label", { class: "knopf cyan", style: "display:inline-flex;align-items:center" }, url ? "Bild ändern" : "Bild hochladen",
        h("input", { type: "file", accept: "image/*", style: "display:none", onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) bildWaehlen(f); } })),
      url ? h("button", { class: "knopf", onclick: () => zuschnittDialog(url, me.bild.ausschnitt, null) }, "Porträtausschnitt") : null));

    const text = h("textarea", { id: "aussehen", placeholder: "Wie sieht dein Charakter aus? Ab Phase 1b-2 schlägt die KI eine Beschreibung aus dem Bild vor." });
    text.value = me.aussehen || "";
    rumpf.appendChild(h("section", { class: "glas karte" },
      h("p", { class: "etikett" }, "Aussehen · die SL beschreibt dich danach"),
      text,
      h("button", { class: "knopf cyan", onclick: () => { sende({ typ: "aussehen", text: text.value }); meldung("Gespeichert", true); } }, "Speichern")));

    if (!c) { rumpf.appendChild(h("p", { class: "leerzustand" }, "Noch kein Charakterbogen hinterlegt.")); return; }
    const b = c.bogen, zs = c.zustand;
    rumpf.appendChild(h("div", { class: "attribute" },
      ["STR", "GES", "WIL", "LOG", "CHA"].map((a) => h("div", null, h("span", null, a), h("strong", null, b.attribute[a]))),
      h("div", null, h("span", null, "EDGE"), h("strong", null, `${edgeRest(me)}/${b.edge}`))));
    rumpf.appendChild(h("section", { class: "abschnitt" },
      h("div", { class: "handy-monitore", style: "padding:0;border:0;grid-template-columns:64px minmax(0,1fr) auto" },
        h("span", null, "KÖRPER"), monitor(zs.monitore.K.max, zs.monitore.K.schaden, "k", true), h("span", null, `${zs.monitore.K.schaden}/${zs.monitore.K.max}`),
        h("span", null, "GEIST"), monitor(zs.monitore.G.max, zs.monitore.G.schaden, "g", true), h("span", null, `${zs.monitore.G.schaden}/${zs.monitore.G.max}`),
        h("span", null, "PANZER"), monitor(zs.panzerung.max, zs.panzerung.schaden, "p", true), h("span", null, `${zs.panzerung.max - zs.panzerung.schaden}/${zs.panzerung.max}`))));
    rumpf.appendChild(h("section", { class: "abschnitt" }, h("p", { class: "etikett" }, "Fertigkeiten · Pool"),
      h("div", { class: "liste" }, Object.entries(b.fertigkeiten || {}).map(([f, w]) => {
        const attr = ATTRIBUT_VON[f] || "GES";
        const spez = (w.spezialisierungen || []).map((x) => `${x.name} +${x.bonus || 2}`).join(", ");
        return h("div", null, h("span", null, f, " ", h("span", { class: "leise", style: "font-size:.85rem" }, spez)), h("span", { class: "rechts" }, `${w.wert + b.attribute[attr]} (${w.wert}+${attr})`));
      }))));
    if ((b.waffen || []).length) {
      rumpf.appendChild(h("section", { class: "abschnitt" }, h("p", { class: "etikett" }, "Waffen · Schaden · Nah / Mittel / Weit"),
        h("div", { class: "liste" }, b.waffen.map((w) => {
          const r = w.reichweiten || {};
          const f = (x) => (x === null || x === undefined || x === "-" ? "–" : String(x));
          return h("div", null, h("span", null, w.name), h("span", { class: "rechts" }, `${w.schaden}${w.art} · ${f(r.nah)} / ${f(r.mittel)} / ${f(r.weit)}`));
        }))));
    }
    for (const [titel, feld] of [["Schattenbooster", "booster"], ["Vorteile", "vorteile"], ["Nachteile", "nachteile"], ["Ausrüstung", "ausruestung"], ["Connections", "connections"], ["Stichworte", "stichworte"], ["Zitate", "zitate"]]) {
      const l = b[feld];
      if (!l || !l.length) continue;
      rumpf.appendChild(h("section", { class: "abschnitt" }, h("p", { class: "etikett" }, titel),
        h("div", { class: "liste" }, l.map((e) => h("div", null, h("span", null, typeof e === "string" ? e : (e.name || "") + (e.beschreibung ? ": " + e.beschreibung : "")))))));
    }
    rumpf.appendChild(h("p", { class: "mono leise", style: "font-size:.8rem" }, `KARMA ${zs.karma || 0} · GESAMT ${zs.gesamtKarma || 0}`));
  }

  // ---------- Bilder hochladen und zuschneiden

  async function verkleinere(datei) {
    const bild = await ladeBild(datei);
    const max = 1600;
    const faktor = Math.min(1, max / Math.max(bild.width, bild.height));
    const w = Math.round(bild.width * faktor), hh = Math.round(bild.height * faktor);
    const leinwand = document.createElement("canvas");
    leinwand.width = w; leinwand.height = hh;
    leinwand.getContext("2d").drawImage(bild, 0, 0, w, hh);
    const alsBlob = (typ, q) => new Promise((ok) => leinwand.toBlob(ok, typ, q));
    let blob = await alsBlob("image/webp", 0.82);
    if (!blob || blob.type !== "image/webp") blob = await alsBlob("image/jpeg", 0.85); // Safari kann kein WebP erzeugen
    for (let q = 0.75; blob.size > 1800000 && q > 0.3; q -= 0.15) blob = await alsBlob("image/jpeg", q);
    return { blob, w, h: hh };
  }

  function ladeBild(datei) {
    return new Promise((ok, fehler) => {
      const url = URL.createObjectURL(datei);
      const img = new Image();
      img.onload = () => { ok(img); };
      img.onerror = () => fehler(new Error("Bild nicht lesbar"));
      img.src = url;
    });
  }

  async function bildWaehlen(datei) {
    try {
      const { blob, w, h: hh } = await verkleinere(datei);
      const url = URL.createObjectURL(blob);
      const seite = Math.min(w, hh) * 0.45;
      zuschnittDialog(url, { x: (w - seite) / 2 / w, y: (hh - seite) / 2 / hh, s: seite / w, w, h: hh }, blob);
    } catch (e) { meldung(e.message || "Bild konnte nicht verarbeitet werden"); }
  }

  /** Quadratischen Porträtrahmen auf dem Bild verschieben und in der Größe ändern */
  function zuschnittDialog(url, start, blob) {
    const a = { ...start };
    const bildEl = h("img", { src: url, alt: "" });
    const rahmen = h("div", { class: "rahmen" });
    const flaeche = h("div", { class: "zuschnitt" }, bildEl, rahmen);
    const groesse = h("input", { type: "range", min: "0.08", max: String(Math.min(1, a.h / a.w)), step: "0.01", value: String(a.s), "aria-label": "Größe des Ausschnitts" });
    function zeichne() {
      const W = flaeche.clientWidth, H = W * (a.h / a.w);
      const seite = a.s * W;
      a.x = Math.min(Math.max(0, a.x), 1 - a.s);
      a.y = Math.min(Math.max(0, a.y), Math.max(0, 1 - seite / H));
      Object.assign(rahmen.style, { left: a.x * W + "px", top: a.y * H + "px", width: seite + "px", height: seite + "px" });
    }
    let zug = null;
    rahmen.addEventListener("pointerdown", (e) => { zug = { x: e.clientX, y: e.clientY, ax: a.x, ay: a.y }; rahmen.setPointerCapture(e.pointerId); });
    rahmen.addEventListener("pointermove", (e) => {
      if (!zug) return;
      const W = flaeche.clientWidth, H = W * (a.h / a.w);
      a.x = zug.ax + (e.clientX - zug.x) / W;
      a.y = zug.ay + (e.clientY - zug.y) / H;
      zeichne();
    });
    rahmen.addEventListener("pointerup", () => (zug = null));
    groesse.addEventListener("input", () => { a.s = Number(groesse.value); zeichne(); });
    bildEl.addEventListener("load", zeichne);
    const speichern = h("button", { class: "knopf voll" }, blob ? "Hochladen" : "Speichern");
    speichern.addEventListener("click", async () => {
      speichern.disabled = true;
      try {
        const ausschnitt = { x: a.x, y: a.y, s: a.s, w: a.w, h: a.h };
        const r = blob
          ? await fetch(SERVER + "/api/bild?art=sc", { method: "POST", headers: { Authorization: "Bearer " + S.token, "Content-Type": blob.type, "X-Ausschnitt": JSON.stringify(ausschnitt) }, body: blob })
          : await fetch(SERVER + "/api/bild/ausschnitt", { method: "PUT", headers: { Authorization: "Bearer " + S.token, "Content-Type": "application/json" }, body: JSON.stringify(ausschnitt) });
        if (!r.ok) throw new Error(r.status === 413 ? "Bild zu groß" : "Speichern fehlgeschlagen");
        schliesseDialog();
        meldung("Gespeichert", true);
      } catch (e) { meldung(e.message); speichern.disabled = false; }
    });
    dialog(h("div", { class: "glas karte ecken dialog" },
      h("h2", null, "Porträtausschnitt"),
      h("p", { class: "leise" }, "Zieh den Rahmen auf das Gesicht. Dieser Ausschnitt erscheint in der Teamleiste."),
      flaeche, h("label", { class: "feld" }, "Größe"), groesse,
      h("div", { style: "display:flex;gap:8px" }, speichern, h("button", { class: "knopf", onclick: schliesseDialog }, "Abbrechen"))));
    requestAnimationFrame(zeichne);
  }

  function dialog(inhalt) {
    const d = document.getElementById("dialog");
    d.textContent = "";
    d.appendChild(h("div", { class: "dialog-hintergrund", onclick: (e) => { if (e.target === e.currentTarget) schliesseDialog(); } }, inhalt));
  }
  function schliesseDialog() { document.getElementById("dialog").textContent = ""; }

  // ---------- Nachrichten

  function markiereGelesen() {
    const n = privateNachrichten();
    if (n.length) { S.gelesen = Math.max(S.gelesen, n[0].nr); merke("sr-gelesen", S.gelesen); }
  }

  function renderNachrichten(rumpf) {
    rumpf.appendChild(h("p", { class: "etikett" }, "Verschlüsselt · nur du siehst diesen Kanal"));
    const liste = privateNachrichten();
    if (!liste.length) { rumpf.appendChild(h("p", { class: "leerzustand" }, "Noch keine privaten Nachrichten. Hier landet, was nur dein Charakter erfährt.")); return; }
    for (const e of liste) {
      const zeit = new Date(e.zeit).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      rumpf.appendChild(h("article", { class: "glas nachricht" + (e.nr > S.gelesen ? " neu" : "") },
        h("div", { class: "kopfzeile" }, h("span", null, e.typ === "hinweis" ? "HINWEIS" : "NUR FÜR DICH"), h("span", null, zeit)),
        h("p", null, e.daten.text)));
    }
    markiereGelesen();
  }

  // ---------- Lobby (Handy und Tisch)

  function renderLobbyKarte(tisch) {
    const z = Z();
    const sz = z.sitzung;
    if (!S.reihenfolgeEntwurf) {
      const bekannt = sz.reihenfolge.filter((id) => spieler(id));
      S.reihenfolgeEntwurf = [...bekannt, ...z.spieler.map((s) => s.id).filter((id) => !bekannt.includes(id))];
    }
    const entwurf = S.reihenfolgeEntwurf.filter((id) => spieler(id));
    z.spieler.forEach((s) => { if (!entwurf.includes(s.id)) entwurf.push(s.id); });
    const verschiebe = (i, d) => { const j = i + d; if (j < 0 || j >= entwurf.length) return; [entwurf[i], entwurf[j]] = [entwurf[j], entwurf[i]]; S.reihenfolgeEntwurf = entwurf; render(); };
    return h("section", { class: "glas karte ecken" },
      h("h2", null, sz.aktiv ? `Sitzung ${sz.nr} läuft` : "Lobby"),
      h("p", { class: "leise" }, "Reihenfolge der Erzählungen (S. 45). Wer beim Start offline ist oder keinen Bogen hat, bleibt passiv im Hintergrund."),
      h("ol", { class: "spielerliste" }, entwurf.map((id, i) => {
        const s = spieler(id);
        return h("li", null, h("span", { class: "punkt" + (s.online ? " an" : "") }), portraet(s, 32), h("span", { class: "n" }, `${scName(s)} (${s.name})`),
          h("button", { class: "knopf", "aria-label": "nach oben", disabled: i === 0 || null, onclick: () => verschiebe(i, -1) }, "↑"),
          h("button", { class: "knopf", "aria-label": "nach unten", disabled: i === entwurf.length - 1 || null, onclick: () => verschiebe(i, 1) }, "↓"));
      })),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
        h("button", { class: "knopf", onclick: () => sende({ typ: "reihenfolge", reihenfolge: entwurf }) }, "Reihenfolge übernehmen"),
        sz.aktiv
          ? h("button", { class: "knopf amber", onclick: () => { if (confirm("Sitzung für alle beenden?")) sende({ typ: "sitzung_beenden" }); } }, "Sitzung beenden")
          : h("button", { class: "knopf voll", onclick: () => { sende({ typ: "reihenfolge", reihenfolge: entwurf }); setTimeout(() => { sende({ typ: "sitzung_starten" }); S.lobbyOffen = false; }, 250); } }, "Sitzung starten"),
        sz.aktiv ? h("button", { class: "knopf", onclick: () => sende({ typ: "freie_rede", an: !sz.freieRede }) }, sz.freieRede ? "Freie Rede beenden" : "Freie Rede") : null,
        tisch && sz.aktiv ? h("button", { class: "knopf cyan", onclick: () => { S.lobbyOffen = false; render(); } }, "Zurück zur Szene") : null),
      h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px" },
        h("span", { class: "mono leise" }, tisch ? "TISCHGERÄT" : `ANGEMELDET ALS ${ich().name.toUpperCase()}`),
        h("button", { class: "knopf", onclick: () => { if (confirm("Auf diesem Gerät abmelden?")) abmelden(); } }, "Abmelden")));
  }

  // ------------------------------------------------------------------ Start

  document.addEventListener("pointerup", () => { if (S.aufnahme && !istTisch()) aufnahmeStopp(); });
  setInterval(() => { if (S.ausstehend && !S.sperre) { S.ausstehend = false; render(); } }, 500);
  render();
  if (S.token) verbinde();
})();
