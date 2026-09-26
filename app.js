// Client für den KI-Spielleiter, Phase 1a (ohne KI).
// Kein Build-Schritt; alle Texte von Mitspielern werden per textContent eingefügt.
(function () {
  "use strict";

  const SERVER = (window.SR_KONFIG && window.SR_KONFIG.server || "").replace(/\/$/, "");
  const WS_URL = SERVER.replace(/^http/, "ws") + "/api/ws";

  const FERTIGKEITEN = ["Athletik", "Bodenfahrzeuge", "Entfesseln", "Fahrzeugwaffen", "Feuerwaffen", "Heimlichkeit", "Nahkampf",
    "Projektilwaffen", "Schwere Waffen", "Steuern", "Astralkampf", "Beschwören", "Hexerei", "Survival", "Biotech", "Elektronik",
    "Hacking", "Mechanik", "Spurenlesen", "Tasken", "Wissensfertigkeiten", "Einschüchtern", "Überreden", "Verhandlung", "Verkleiden"];
  const ATTRIBUTE = ["STR", "GES", "WIL", "LOG", "CHA"];
  const SCHWIERIGKEITEN = [[4, "Sehr Einfach (4)"], [6, "Einfach (6)"], [8, "Durchschnittlich (8)"], [10, "Schwierig (10)"], [12, "Sehr Schwierig (12)"]];
  const ATTRIBUTSPROBEN = {
    wahrnehmung: { name: "Wahrnehmung (LOG + WIL)", attribute: ["LOG", "WIL"] },
    verteidigung: { name: "Verteidigung (GES + LOG)", attribute: ["GES", "LOG"] },
    heben: { name: "Heben (STR × 2)", attribute: ["STR"], verdoppeln: true },
    fangen: { name: "Fangen (GES × 2)", attribute: ["GES"], verdoppeln: true },
    erinnern: { name: "Erinnern (LOG × 2)", attribute: ["LOG"], verdoppeln: true },
    absichten: { name: "Absichten einschätzen (CHA × 2)", attribute: ["CHA"], verdoppeln: true },
    folter: { name: "Folter widerstehen (WIL + STR)", attribute: ["WIL", "STR"] },
  };

  // ------------------------------------------------------------ Zustand

  const S = {
    token: speicherLies("sr-token"),
    zustand: null,
    verlauf: [],
    reiter: "erzaehlung",
    verbunden: false,
    ws: null,
    wiederholung: 0,
    vorschau: null,
    entwurf: speicherLies("sr-entwurf") || "",
    probe: { art: "fertigkeit", fertigkeit: "", spezialisierung: "", attributsprobe: "wahrnehmung", mod: 0, modQuelle: "", slMod: false, gegenArt: "schwierigkeit", gegenWert: 8, edgeVorher: false, lebeGefaehrlich: false, bezeichnung: "" },
    bogenAnsicht: null,
    reihenfolgeEntwurf: null,
  };

  function speicherLies(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function speicherSchreib(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} }

  // ------------------------------------------------------------ DOM-Helfer

  function h(tag, attrs, ...kinder) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kind of kinder.flat()) {
      if (kind === null || kind === undefined || kind === false) continue;
      el.appendChild(typeof kind === "string" || typeof kind === "number" ? document.createTextNode(String(kind)) : kind);
    }
    return el;
  }

  let meldungTimer = null;
  function meldung(text) {
    const m = document.getElementById("meldung");
    m.textContent = text;
    m.hidden = false;
    clearTimeout(meldungTimer);
    meldungTimer = setTimeout(() => (m.hidden = true), 4500);
  }

  // ------------------------------------------------------------ Server

  async function login(code) {
    const r = await fetch(SERVER + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 429) throw new Error("Zu viele Fehlversuche. Bitte in 10 Minuten erneut versuchen.");
    if (!r.ok) throw new Error("Code unbekannt. Bitte prüfen.");
    S.token = d.token;
    speicherSchreib("sr-token", d.token);
    verbinde();
  }

  function abmelden() {
    S.token = null;
    S.zustand = null;
    S.verlauf = [];
    speicherSchreib("sr-token", null);
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
        S.verbunden = true;
        break;
      case "verlauf":
        S.verlauf = n.ereignisse;
        break;
      case "ereignis":
        S.verlauf.push(n.ereignis);
        if (S.verlauf.length > 500) S.verlauf.shift();
        break;
      case "probe_vorschau":
        S.vorschau = n.ergebnis;
        return renderVorschau();
      case "fehler":
        if (n.code === "token_ungueltig") { abmelden(); }
        meldung(n.meldung || "Fehler");
        return;
    }
    render();
  }

  // ------------------------------------------------------------ Ableitungen

  function ich() { return S.zustand && S.zustand.spieler.find((s) => s.id === S.zustand.ich); }
  function spieler(id) { return S.zustand && S.zustand.spieler.find((s) => s.id === id); }
  function name(id) {
    const s = spieler(id);
    if (!s) return "?";
    return s.charakter ? `${s.charakter.bogen.name} (${s.name})` : s.name;
  }
  /** Name des Urhebers eines Ereignisses; fällt auf den gespeicherten Namen zurück */
  function nameVon(d) { return spieler(d.von) ? name(d.von) : (d.vonName || "Unbekannt"); }

  function amZugId() {
    const z = S.zustand && S.zustand.sitzung;
    return z && z.aktiv ? z.reihenfolge[z.amZug] : null;
  }
  function binDran() { return amZugId() === S.zustand.ich; }
  function darfErzaehlen() { const z = S.zustand.sitzung; return z.aktiv && (binDran() || z.freieRede); }
  function edgeRest(s) { const c = s && s.charakter; return c ? c.bogen.edge - (c.zustand.edgeVerbraucht || 0) : 0; }

  // ------------------------------------------------------------ Rendering

  function render() {
    const app = document.getElementById("app");
    const aktiv = document.activeElement;
    const fokus = aktiv && aktiv.id;
    const auswahl = aktiv && typeof aktiv.selectionStart === "number" ? [aktiv.selectionStart, aktiv.selectionEnd] : null;
    const scroll = window.scrollY;
    const nahUnten = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
    app.textContent = "";
    if (!SERVER || SERVER.includes("DEIN-NAME")) {
      app.appendChild(h("main", null, h("div", { class: "karte" }, h("h1", null, "Noch nicht eingerichtet"),
        h("p", null, "In config.js fehlt die Adresse des Servers."))));
      return;
    }
    if (!S.token) return app.appendChild(renderLogin());
    if (!S.zustand) {
      return app.appendChild(h("main", null, h("p", { class: "leise" }, "Verbinde …")));
    }
    app.appendChild(renderKopf());
    const main = h("main", null, renderReiter());
    if (S.reiter === "erzaehlung") main.appendChild(renderErzaehlung());
    if (S.reiter === "bogen") main.appendChild(renderBogen());
    if (S.reiter === "lobby") main.appendChild(renderLobby());
    app.appendChild(main);
    if (fokus) {
      const el = document.getElementById(fokus);
      if (el) {
        el.focus({ preventScroll: true });
        if (auswahl && typeof el.setSelectionRange === "function") { try { el.setSelectionRange(auswahl[0], auswahl[1]); } catch (_) {} }
      }
    }
    window.scrollTo(0, scroll);
    // Nur nachscrollen, wenn man ohnehin am Ende des Verlaufs war
    if (S.reiter === "erzaehlung" && nahUnten && !fokus) {
      const letzter = document.querySelector(".verlauf .eintrag:last-child");
      if (letzter) letzter.scrollIntoView({ block: "nearest" });
    }
  }

  /** details-Elemente behalten ihren Auf-/Zu-Zustand über Neuzeichnungen */
  function klappbar(schluessel, standardOffen, ...inhalt) {
    const offen = (speicherLies("sr-offen-" + schluessel) ?? (standardOffen ? "1" : "0")) === "1";
    return h("details", { class: "karte", open: offen || null, ontoggle: (e) => speicherSchreib("sr-offen-" + schluessel, e.target.open ? "1" : "0") }, ...inhalt);
  }

  function renderLogin() {
    const eingabe = h("input", { id: "code", type: "text", autocomplete: "one-time-code", autocapitalize: "characters", placeholder: "XXXX-XXXX", "aria-label": "Spielercode" });
    const knopf = h("button", { type: "submit" }, "Anmelden");
    const form = h("form", {
      class: "karte",
      onsubmit: async (e) => {
        e.preventDefault();
        knopf.disabled = true;
        try { await login(eingabe.value); } catch (err) { meldung(err.message); } finally { knopf.disabled = false; }
      },
    },
    h("h1", null, "Shadowrun Anarchy"),
    h("p", { class: "leise" }, "Gib deinen Spielercode ein. Du bekommst ihn von Severin."),
    h("div", { class: "feld" }, eingabe),
    knopf);
    return h("main", null, form);
  }

  function renderMonitor(max, schaden, klasse) {
    const m = h("span", { class: "monitor " + (klasse || ""), role: "img", "aria-label": `${schaden} von ${max}` });
    let rest = max, i = 0;
    while (rest > 0) {
      const reihe = h("span", { class: "reihe" });
      for (let k = 0; k < Math.min(3, rest); k++) reihe.appendChild(h("i", { class: i++ < schaden ? "voll" : "" }));
      m.appendChild(reihe);
      rest -= 3;
    }
    return m;
  }

  function renderPunkte(n, max) {
    const p = h("span", { class: "punkte", role: "img", "aria-label": `${n} Plotpunkte` });
    for (let i = 0; i < Math.max(max, n); i++) p.appendChild(h("i", { class: i < n ? "voll" : "" }));
    return p;
  }

  function renderKopf() {
    const me = ich();
    const c = me && me.charakter;
    const dran = amZugId();
    const sz = S.zustand.sitzung;
    let zugText = "Keine laufende Sitzung";
    if (sz.aktiv) zugText = sz.freieRede ? `Runde ${sz.runde} · Freie Rede` : (dran === S.zustand.ich ? `Runde ${sz.runde} · Du bist dran` : `Runde ${sz.runde} · Am Zug: ${name(dran)}`);
    return h("header", { class: "kopf" }, h("div", { class: "kopf-innen" },
      h("div", { class: "kopf-oben" },
        h("span", { class: "marke" }, c ? c.bogen.name : (me ? me.name : "")),
        h("span", { class: "amzug" + (dran === S.zustand.ich && !sz.freieRede ? " du" : "") }, zugText)),
      c ? h("div", { class: "werte" },
        h("span", null, "Plotpunkte ", renderPunkte(me.plotpunkte, 5)),
        h("span", null, `Edge ${edgeRest(me)}/${c.bogen.edge}`),
        h("span", null, "K ", renderMonitor(c.zustand.monitore.K.max, c.zustand.monitore.K.schaden)),
        h("span", null, "G ", renderMonitor(c.zustand.monitore.G.max, c.zustand.monitore.G.schaden)),
        h("span", { title: S.verbunden ? "verbunden" : "getrennt" }, h("i", { class: "verbindung" + (S.verbunden ? " an" : "") }))) : null));
  }

  function renderReiter() {
    const r = [["erzaehlung", "Erzählung"], ["bogen", "Charakterbogen"], ["lobby", "Lobby"]];
    return h("nav", { class: "reiter", role: "tablist" }, r.map(([k, t]) =>
      h("button", { role: "tab", "aria-selected": String(S.reiter === k), onclick: () => { S.reiter = k; render(); } }, t)));
  }

  // ---------- Erzählung

  function renderErzaehlung() {
    const box = h("section", null);
    const liste = h("div", { class: "verlauf", "aria-live": "polite" });
    const sichtbar = S.verlauf.slice(-150);
    if (!sichtbar.length) liste.appendChild(h("p", { class: "leise" }, "Noch nichts passiert."));
    for (const e of sichtbar) liste.appendChild(renderEreignis(e));
    box.appendChild(liste);

    const sz = S.zustand.sitzung;
    if (!sz.aktiv) {
      box.appendChild(h("p", { class: "leise" }, "Die Sitzung wird in der Lobby gestartet."));
      return box;
    }
    box.appendChild(renderEingabe());
    box.appendChild(renderProbe());
    box.appendChild(renderPlotpunkte());
    return box;
  }

  function renderEreignis(e) {
    const d = e.daten || {};
    switch (e.typ) {
      case "erzaehlung":
        return h("div", { class: "eintrag erzaehlung" }, h("span", { class: "wer" }, nameVon(d)), h("span", { class: "text" }, d.text));
      case "probe":
        return renderProbenEintrag(e);
      case "probe_edge":
        return h("div", { class: "eintrag probe" },
          h("span", { class: "wer" }, nameVon(d)), "setzt Edge nach dem Wurf ein.",
          renderWuerfel(d.eigen.wuerfe, false, d.eigen.schicksal),
          h("div", null, `Neu: ${d.eigen.erfolge} gegen ${d.gegner.erfolge} Erfolge – `, renderErgebnis(d.vergleich)));
      case "plotpunkt": {
        const eff = (S.zustand.effekte || {})[d.effekt] || d.effekt;
        let zusatz = "";
        if (d.wirkung && d.effekt === "erste_hilfe") zusatz = ` → ${name(d.wirkung.ziel)}: ${d.wirkung.geheilt} Kreis ${d.wirkung.monitor} geheilt`;
        return h("div", { class: "eintrag plotpunkt" }, h("span", { class: "wer" }, nameVon(d)), `Plotpunkt: ${eff}${zusatz}`,
          d.notiz ? h("div", { class: "text leise" }, d.notiz) : null);
      }
      case "runde": return h("div", { class: "eintrag system" }, `— Runde ${d.runde} —`);
      case "sitzung_start": return h("div", { class: "eintrag system" }, `Sitzung ${d.nr} beginnt. Reihenfolge: ${d.reihenfolge.join(", ")}`);
      case "sitzung_ende": return h("div", { class: "eintrag system" }, `Sitzung ${d.nr} beendet.`);
      case "reihenfolge": return h("div", { class: "eintrag system" }, `Neue Reihenfolge: ${d.reihenfolge.join(", ")}`);
      case "freie_rede": return h("div", { class: "eintrag system" }, d.an ? "Freie Rede: alle dürfen erzählen." : "Freie Rede beendet.");
      default: return h("div", { class: "eintrag system" }, e.typ);
    }
  }

  function renderWuerfel(wuerfe, vieren, schicksal) {
    const w = h("div", { class: "wuerfel" });
    for (const x of wuerfe) w.appendChild(h("b", { class: x >= 5 || (vieren && x === 4) ? "erfolg" : "" }, x));
    if (schicksal) {
      w.appendChild(h("b", {
        class: "schicksal " + (schicksal.ergebnis === "patzer" ? "patzer" : schicksal.ergebnis === "gluecksfall" ? "erfolg" : ""),
        title: "Schicksalswürfel",
      }, schicksal.wurf));
    }
    return w;
  }

  function renderErgebnis(v) {
    return h("span", { class: "ergebnis " + (v.gelungen ? "ja" : "nein") }, v.gelungen ? `gelungen, ${v.netto} netto` : "misslungen");
  }

  function renderProbenEintrag(e) {
    const d = e.daten;
    const teile = d.teile.map((t) => `${t.quelle} ${t.wert >= 0 && t !== d.teile[0] ? "+" : ""}${t.wert}`).join(", ");
    const gegen = d.gegen.art === "schwierigkeit" ? `Schwierigkeit ${d.gegen.wert}` : `Gegner-Pool ${d.gegen.wert}`;
    const eintrag = h("div", { class: "eintrag probe" },
      h("div", null, h("span", { class: "wer" }, nameVon(d)), d.bezeichnung || "Probe"),
      h("div", { class: "aufschluesselung" }, `${d.pool} Würfel (${teile})${d.eigen.edgeVorher ? ", Edge vor dem Wurf" : ""} gegen ${gegen}`),
      renderWuerfel(d.eigen.wuerfe, d.eigen.vieren, d.eigen.schicksal),
      h("div", { class: "aufschluesselung" }, "Gegenseite:"),
      renderWuerfel(d.gegner.wuerfe, false, null),
      h("div", null, `${d.eigen.erfolge} gegen ${d.gegner.erfolge} Erfolge – `, renderErgebnis(d.vergleich)),
      d.eigen.schicksal && d.eigen.schicksal.ergebnis ? h("div", { class: "ergebnis " + (d.eigen.schicksal.ergebnis === "patzer" ? "nein" : "ja") },
        d.eigen.schicksal.ergebnis === "patzer" ? "Patzer! Eine Komplikation tritt ein (S. 51)." : "Glücksfall! Etwas unerwartet Gutes passiert (S. 51).") : null,
      d.hinweise && d.hinweise.length ? h("div", { class: "aufschluesselung" }, d.hinweise.join(" · ")) : null);

    const eigene = d.von === S.zustand.ich;
    const letzte = eigene && !S.verlauf.some((x) => x.nr > e.nr && ((x.typ === "probe" && x.daten.von === d.von) || (x.typ === "probe_edge" && x.daten.bezug === e.nr)));
    if (letzte && !d.eigen.edgeVorher && edgeRest(ich()) > 0) {
      eintrag.appendChild(h("button", { class: "zweit", onclick: () => sende({ typ: "edge_nachher", nr: e.nr }) }, "Edge nach dem Wurf: Nicht-Erfolge neu würfeln"));
    }
    return eintrag;
  }

  function renderEingabe() {
    const darf = darfErzaehlen();
    const text = h("textarea", {
      id: "erzaehlung-text",
      placeholder: darf ? "Was tut dein Charakter?" : "Entwurf für deine nächste Erzählung …",
      "aria-label": "Erzählung",
      oninput: (e) => { S.entwurf = e.target.value; speicherSchreib("sr-entwurf", S.entwurf); },
    });
    text.value = S.entwurf;
    const senden = h("button", {
      disabled: !darf,
      onclick: () => {
        if (!S.entwurf.trim()) return;
        sende({ typ: "erzaehlung", text: S.entwurf });
        S.entwurf = ""; speicherSchreib("sr-entwurf", null); render();
      },
    }, "Erzählung senden");
    const beenden = h("button", { class: "zweit", disabled: !binDran(), onclick: () => sende({ typ: "zug_beenden" }) }, "Zug beenden");
    return h("div", { class: "karte aktionen" }, text, h("div", { class: "zeile", style: "margin-top:.5rem" }, senden, beenden),
      !darf ? h("p", { class: "leise klein" }, "Du kannst schon schreiben; senden geht, sobald du dran bist.") : null);
  }

  function probenAnfrage() {
    const p = S.probe;
    const mods = [];
    if (Number(p.mod)) mods.push({ quelle: p.modQuelle || (p.slMod ? "SL-Modifikator" : "Modifikator"), wert: Number(p.mod), sl: p.slMod });
    if (p.art === "fertigkeit") {
      return { fertigkeit: p.fertigkeit, spezialisierung: p.spezialisierung || undefined, modifikatoren: mods };
    }
    const a = ATTRIBUTSPROBEN[p.attributsprobe];
    return { attribute: a.attribute, verdoppeln: a.verdoppeln, modifikatoren: mods };
  }

  function probenBezeichnung() {
    const p = S.probe;
    if (p.bezeichnung) return p.bezeichnung;
    return p.art === "fertigkeit" ? `${p.fertigkeit}${p.spezialisierung ? " (" + p.spezialisierung + ")" : ""}` : ATTRIBUTSPROBEN[p.attributsprobe].name;
  }

  let vorschauTimer = null;
  function fordereVorschau() {
    clearTimeout(vorschauTimer);
    vorschauTimer = setTimeout(() => {
      if (S.probe.art === "fertigkeit" && !S.probe.fertigkeit) { S.vorschau = null; return renderVorschau(); }
      sende({ typ: "probe_vorschau", anfrage: probenAnfrage() });
    }, 150);
  }

  function renderVorschau() {
    const el = document.getElementById("probe-vorschau");
    if (!el) return;
    el.textContent = "";
    const v = S.vorschau;
    if (!v) return;
    if (v.ok === false) { el.appendChild(h("span", { class: "ergebnis nein" }, v.meldung)); return; }
    el.appendChild(h("strong", null, `${v.wuerfel} Würfel`));
    el.appendChild(h("span", { class: "leise" }, " = " + v.teile.map((t) => `${t.quelle} ${t.wert}`).join(" + ")));
    if (v.hinweise.length) el.appendChild(h("div", { class: "leise klein" }, v.hinweise.join(" · ")));
  }

  function renderProbe() {
    const p = S.probe;
    const me = ich();
    const bogen = me.charakter ? me.charakter.bogen : { fertigkeiten: {} };
    const eigene = Object.keys(bogen.fertigkeiten || {});
    if (!p.fertigkeit && eigene.length) p.fertigkeit = eigene[0];

    const setze = (feld, wert, neuRender) => { p[feld] = wert; if (neuRender) render(); fordereVorschau(); };

    const art = h("select", { id: "probe-art", onchange: (e) => setze("art", e.target.value, true) },
      h("option", { value: "fertigkeit" }, "Fertigkeitsprobe"),
      h("option", { value: "attribut" }, "Reine Attributsprobe"));
    art.value = p.art;

    let auswahl;
    if (p.art === "fertigkeit") {
      const sel = h("select", { id: "probe-fertigkeit", onchange: (e) => { p.spezialisierung = ""; setze("fertigkeit", e.target.value, true); } },
        h("optgroup", { label: "Auf dem Bogen" }, eigene.map((f) => h("option", { value: f }, `${f} ${bogen.fertigkeiten[f].wert}`))),
        h("optgroup", { label: "Ungeübt (nur Attribut)" }, FERTIGKEITEN.filter((f) => !eigene.includes(f)).map((f) => h("option", { value: f }, f))));
      sel.value = p.fertigkeit;
      const spez = ((bogen.fertigkeiten[p.fertigkeit] || {}).spezialisierungen || []);
      const spezSel = spez.length ? h("select", { id: "probe-spez", onchange: (e) => setze("spezialisierung", e.target.value) },
        h("option", { value: "" }, "keine Spezialisierung"),
        spez.map((s) => h("option", { value: s.name }, `${s.name} +${s.bonus || 2}`))) : null;
      if (spezSel) spezSel.value = p.spezialisierung;
      auswahl = h("div", { class: "zeile" }, h("div", null, h("label", { for: "probe-fertigkeit" }, "Fertigkeit"), sel),
        spezSel ? h("div", null, h("label", { for: "probe-spez" }, "Spezialisierung"), spezSel) : null);
    } else {
      const sel = h("select", { id: "probe-attr", onchange: (e) => setze("attributsprobe", e.target.value) },
        Object.entries(ATTRIBUTSPROBEN).map(([k, a]) => h("option", { value: k }, a.name)));
      sel.value = p.attributsprobe;
      auswahl = h("div", null, h("label", { for: "probe-attr" }, "Probe (S. 50)"), sel);
    }

    const mod = h("input", { id: "probe-mod", type: "number", min: "-10", max: "10", value: p.mod, onchange: (e) => setze("mod", e.target.value) });
    const modQuelle = h("input", { id: "probe-modquelle", type: "text", placeholder: "z. B. Dunkelheit", value: p.modQuelle, onchange: (e) => setze("modQuelle", e.target.value) });
    const slMod = h("label", { class: "check" }, h("input", { type: "checkbox", checked: p.slMod, onchange: (e) => setze("slMod", e.target.checked) }), "SL-Modifikator (max. ±5, S. 49)");

    const gegenArt = h("select", { id: "probe-gegenart", onchange: (e) => { p.gegenArt = e.target.value; p.gegenWert = p.gegenArt === "schwierigkeit" ? 8 : 6; render(); } },
      h("option", { value: "schwierigkeit" }, "Schwierigkeit (S. 50)"), h("option", { value: "pool" }, "Pool eines Gegners"));
    gegenArt.value = p.gegenArt;
    const gegenWert = p.gegenArt === "schwierigkeit"
      ? h("select", { id: "probe-gegenwert", onchange: (e) => (p.gegenWert = Number(e.target.value)) }, SCHWIERIGKEITEN.map(([w, t]) => h("option", { value: w }, t)))
      : h("input", { id: "probe-gegenwert", type: "number", min: "0", max: "40", value: p.gegenWert, onchange: (e) => (p.gegenWert = Number(e.target.value)) });
    gegenWert.value = p.gegenWert;

    const edgeOk = edgeRest(me) > 0;
    const ppOk = me.plotpunkte > 0;
    const edge = h("label", { class: "check" }, h("input", { type: "checkbox", disabled: !edgeOk, checked: p.edgeVorher && edgeOk, onchange: (e) => (p.edgeVorher = e.target.checked) }),
      `Edge vor dem Wurf: +1 Würfel, Vieren zählen (noch ${edgeRest(me)})`);
    const lebe = h("label", { class: "check" }, h("input", { type: "checkbox", disabled: !ppOk, checked: p.lebeGefaehrlich && ppOk, onchange: (e) => (p.lebeGefaehrlich = e.target.checked) }),
      "Lebe gefährlich: Schicksalswürfel (1 Plotpunkt)");
    const bez = h("input", { id: "probe-bez", type: "text", placeholder: "optional, z. B. Schloss knacken", value: p.bezeichnung, onchange: (e) => (p.bezeichnung = e.target.value) });

    const wuerfeln = h("button", {
      disabled: !me.charakter,
      onclick: () => {
        sende({
          typ: "probe_wuerfeln",
          bezeichnung: probenBezeichnung(),
          anfrage: probenAnfrage(),
          gegen: { art: p.gegenArt, wert: Number(p.gegenWert) },
          edgeVorher: p.edgeVorher && edgeOk,
          schicksalswuerfel: p.lebeGefaehrlich && ppOk,
        });
        p.edgeVorher = false; p.lebeGefaehrlich = false; p.bezeichnung = "";
      },
    }, "Würfeln");

    const box = klappbar("probe", false,
      h("summary", null, "Probe würfeln"),
      h("div", { class: "feld" }, h("label", { for: "probe-art" }, "Art"), art),
      h("div", { class: "feld" }, auswahl),
      h("div", { class: "zeile feld" }, h("div", null, h("label", { for: "probe-mod" }, "Modifikator"), mod), h("div", null, h("label", { for: "probe-modquelle" }, "Grund"), modQuelle)),
      h("div", { class: "feld" }, slMod),
      h("div", { class: "zeile feld" }, h("div", null, h("label", { for: "probe-gegenart" }, "Gegenseite"), gegenArt), h("div", null, h("label", { for: "probe-gegenwert" }, "Würfel der Gegenseite"), gegenWert)),
      h("div", { class: "feld" }, edge, lebe),
      h("div", { class: "feld" }, h("label", { for: "probe-bez" }, "Bezeichnung"), bez),
      h("div", { class: "feld", id: "probe-vorschau", "aria-live": "polite" }),
      wuerfeln);
    requestAnimationFrame(() => { renderVorschau(); fordereVorschau(); });
    return box;
  }

  function renderPlotpunkte() {
    const me = ich();
    const effekte = Object.entries(S.zustand.effekte || {}).filter(([k]) => k !== "lebe_gefaehrlich");
    const zielSel = h("select", { id: "pp-ziel" }, S.zustand.spieler.filter((s) => s.charakter).map((s) => h("option", { value: s.id }, s.charakter.bogen.name)));
    zielSel.value = S.zustand.ich;
    const monSel = h("select", { id: "pp-monitor" }, h("option", { value: "K" }, "Körperlich"), h("option", { value: "G" }, "Geistig"));
    const notiz = h("input", { id: "pp-notiz", type: "text", placeholder: "Was passiert? (optional)", value: S.ppNotiz || "", oninput: (e) => (S.ppNotiz = e.target.value) });
    return klappbar("plotpunkte", false,
      h("summary", null, `Plotpunkte einsetzen (${me.plotpunkte})`),
      h("p", { class: "leise klein" }, "Jeder Einsatz kostet 1 Plotpunkt und geht an die Spielleitung (S. 47 f.). Lebe gefährlich wählst du direkt bei der Probe."),
      h("div", { class: "feld" }, h("label", { for: "pp-notiz" }, "Notiz"), notiz),
      h("div", { class: "zeile feld" }, h("div", null, h("label", { for: "pp-ziel" }, "Ziel für Erste Hilfe"), zielSel), h("div", null, h("label", { for: "pp-monitor" }, "Monitor"), monSel)),
      h("div", { class: "effekte" }, effekte.map(([k, t]) => h("button", {
        class: "zweit", disabled: me.plotpunkte < 1,
        onclick: () => {
          if (!confirm(`${t} für 1 Plotpunkt einsetzen?`)) return;
          sende({ typ: "plotpunkt", effekt: k, notiz: notiz.value, ziel: zielSel.value, monitor: monSel.value });
          S.ppNotiz = "";
        },
      }, t))));
  }

  // ---------- Charakterbogen

  function renderBogen() {
    const mitBogen = S.zustand.spieler.filter((s) => s.charakter);
    if (!mitBogen.length) return h("p", { class: "leise" }, "Noch kein Charakterbogen hinterlegt.");
    const id = S.bogenAnsicht && spieler(S.bogenAnsicht) && spieler(S.bogenAnsicht).charakter ? S.bogenAnsicht : (ich().charakter ? S.zustand.ich : mitBogen[0].id);
    const s = spieler(id);
    const b = s.charakter.bogen;
    const z = s.charakter.zustand;
    const wahl = h("select", { id: "bogen-wahl", onchange: (e) => { S.bogenAnsicht = e.target.value; render(); } },
      mitBogen.map((x) => h("option", { value: x.id }, `${x.charakter.bogen.name} (${x.name})`)));
    wahl.value = id;

    const liste = (titel, eintraege) => eintraege && eintraege.length ? [h("h3", null, titel), h("ul", null, eintraege.map((e) => h("li", null, typeof e === "string" ? e : (e.name || "") + (e.beschreibung ? ": " + e.beschreibung : ""))))] : [];

    return h("section", null,
      h("div", { class: "feld" }, h("label", { for: "bogen-wahl" }, "Bogen von"), wahl),
      h("div", { class: "karte" },
        h("h2", null, b.name),
        h("p", { class: "leise" }, [b.metatyp, b.konzept].filter(Boolean).join(" · ")),
        h("div", { class: "werteliste" },
          ATTRIBUTE.map((a) => h("div", null, h("span", null, a), h("strong", null, b.attribute[a]))),
          h("div", null, h("span", null, "Edge"), h("strong", null, `${edgeRest(s)}/${b.edge}`)),
          h("div", null, h("span", null, "Plotpunkte"), h("strong", null, s.plotpunkte))),
        h("h3", null, "Zustand"),
        h("p", null, "Panzerung ", renderMonitor(z.panzerung.max, z.panzerung.schaden, "panzer")),
        h("p", null, "Körperlich ", renderMonitor(z.monitore.K.max, z.monitore.K.schaden)),
        h("p", null, "Geistig ", renderMonitor(z.monitore.G.max, z.monitore.G.schaden)),
        z.cyberdeck ? h("p", null, `Cyberdeck (Stufe ${z.cyberdeck.stufe}, Firewall ${z.cyberdeck.firewall}) `, renderMonitor(z.cyberdeck.max, z.cyberdeck.schaden)) : null,
        h("h3", null, "Fertigkeiten"),
        h("div", { class: "tabelle" }, h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Fertigkeit"), h("th", null, "Wert"), h("th", null, "Spezialisierung"), h("th", null, "Pool"))),
          h("tbody", null, Object.entries(b.fertigkeiten || {}).map(([f, w]) => {
            const attr = { Astralkampf: "WIL", Beschwören: "WIL", Hexerei: "WIL", Survival: "WIL", Biotech: "LOG", Elektronik: "LOG", Hacking: "LOG", Mechanik: "LOG", Spurenlesen: "LOG", Tasken: "LOG", Wissensfertigkeiten: "LOG", Einschüchtern: "CHA", Überreden: "CHA", Verhandlung: "CHA", Verkleiden: "CHA" }[f] || "GES";
            return h("tr", null, h("td", null, f), h("td", null, w.wert), h("td", null, (w.spezialisierungen || []).map((x) => `${x.name} +${x.bonus || 2}`).join(", ")), h("td", null, `${w.wert + b.attribute[attr]} (${attr})`));
          })))),
        (b.waffen && b.waffen.length) ? [h("h3", null, "Waffen"), h("div", { class: "tabelle" }, h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Waffe"), h("th", null, "Schaden"), h("th", null, "Nah"), h("th", null, "Mittel"), h("th", null, "Weit"))),
          h("tbody", null, b.waffen.map((w) => {
            const r = w.reichweiten || {};
            const f = (x) => x === null || x === undefined || x === "-" ? "–" : (x === "OK" ? "OK" : String(x));
            return h("tr", null, h("td", null, w.name), h("td", null, `${w.schaden}${w.art}`), h("td", null, f(r.nah)), h("td", null, f(r.mittel)), h("td", null, f(r.weit)));
          }))))] : null,
        ...liste("Schattenbooster", b.booster),
        ...liste("Vorteile", b.vorteile),
        ...liste("Nachteile", b.nachteile),
        ...liste("Ausrüstung", b.ausruestung),
        ...liste("Connections", b.connections),
        ...liste("Stichworte", b.stichworte),
        ...liste("Zitate", b.zitate),
        h("p", { class: "leise klein" }, `Karma: ${z.karma || 0} (gesamt ${z.gesamtKarma || 0})`)));
  }

  // ---------- Lobby

  function renderLobby() {
    const sz = S.zustand.sitzung;
    const alle = S.zustand.spieler;
    if (!S.reihenfolgeEntwurf) {
      const bekannt = sz.reihenfolge.filter((id) => spieler(id));
      S.reihenfolgeEntwurf = [...bekannt, ...alle.map((s) => s.id).filter((id) => !bekannt.includes(id))];
    }
    const entwurf = S.reihenfolgeEntwurf.filter((id) => spieler(id));
    const verschiebe = (i, d) => { const j = i + d; if (j < 0 || j >= entwurf.length) return; [entwurf[i], entwurf[j]] = [entwurf[j], entwurf[i]]; S.reihenfolgeEntwurf = entwurf; render(); };

    const liste = h("ol", { class: "spielerliste" }, entwurf.map((id, i) => {
      const s = spieler(id);
      return h("li", null,
        h("i", { class: "verbindung" + (s.online ? " an" : ""), title: s.online ? "online" : "offline" }),
        h("span", { class: "name" }, s.charakter ? `${s.charakter.bogen.name} (${s.name})` : `${s.name} – kein Charakter`),
        h("span", { class: "leise klein" }, s.charakter ? `${s.plotpunkte} PP` : ""),
        h("button", { class: "zweit", "aria-label": "nach oben", disabled: i === 0, onclick: () => verschiebe(i, -1) }, "↑"),
        h("button", { class: "zweit", "aria-label": "nach unten", disabled: i === entwurf.length - 1, onclick: () => verschiebe(i, 1) }, "↓"));
    }));

    return h("section", null,
      h("div", { class: "karte" },
        h("h2", null, sz.aktiv ? `Sitzung ${sz.nr} läuft` : "Lobby"),
        h("p", { class: "leise" }, "Sitzreihenfolge für die Erzählungen (S. 45). Wer beim Start offline ist oder keinen Charakter hat, fällt heraus und bleibt passiv im Hintergrund."),
        liste,
        h("div", { class: "zeile", style: "margin-top:.75rem" },
          h("button", { class: "zweit", onclick: () => { sende({ typ: "reihenfolge", reihenfolge: entwurf }); } }, "Reihenfolge übernehmen"),
          sz.aktiv
            ? h("button", { class: "gefahr", onclick: () => { if (confirm("Sitzung für alle beenden?")) sende({ typ: "sitzung_beenden" }); } }, "Sitzung beenden")
            : h("button", { onclick: () => { sende({ typ: "reihenfolge", reihenfolge: entwurf }); setTimeout(() => sende({ typ: "sitzung_starten" }), 200); } }, "Sitzung starten"))),
      sz.aktiv ? h("div", { class: "karte" },
        h("h2", null, "Freie Rede"),
        h("p", { class: "leise" }, "Für Gespräche: Die Rundenfolge ruht, alle dürfen erzählen, bis eine Probe nötig wird (S. 45)."),
        h("button", { class: "zweit", onclick: () => sende({ typ: "freie_rede", an: !sz.freieRede }) }, sz.freieRede ? "Freie Rede beenden" : "Freie Rede beginnen")) : null,
      h("div", { class: "karte" },
        h("p", { class: "leise" }, `Plotpunkte der Spielleitung: ${S.zustand.slPlotpunkte}`),
        h("button", { class: "zweit", onclick: () => { if (confirm("Auf diesem Gerät abmelden?")) abmelden(); } }, "Abmelden")));
  }

  // ------------------------------------------------------------ Start

  render();
  if (S.token) verbinde();
})();
