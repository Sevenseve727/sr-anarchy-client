// Verwaltungsseite. Das Secret bleibt im Browser (Sitzung oder, wenn gewünscht, dauerhaft).
(function () {
  "use strict";

  const SERVER = (window.SR_KONFIG && window.SR_KONFIG.server || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  let secret = lies();
  let aktuellerSpieler = null;

  const VORLAGE = {
    name: "Name des Charakters",
    metatyp: "Mensch",
    konzept: "z. B. Straßensamurai",
    attribute: { STR: 3, GES: 4, WIL: 3, LOG: 3, CHA: 2 },
    edge: 2,
    panzerung: 6,
    fertigkeiten: {
      Feuerwaffen: { wert: 4, spezialisierungen: [{ name: "Pistolen", bonus: 2 }] },
      Heimlichkeit: { wert: 2 },
    },
    booster: [{ name: "Name des Boosters", beschreibung: "Wirkung in eigenen Worten" }],
    waffen: [{ name: "Schwere Pistole", schaden: 5, art: "K", reichweiten: { nah: "OK", mittel: -1, weit: null } }],
    ausruestung: ["Kommlink", "Dietrich-Set"],
    connections: [{ name: "Name", beschreibung: "Rolle, Loyalität" }],
    vorteile: ["Vorteil 1", "Vorteil 2"],
    nachteile: ["Nachteil"],
    stichworte: ["Stichwort"],
    zitate: ["Ein typischer Satz des Charakters."],
    karma: 0,
  };

  function lies() {
    try { return sessionStorage.getItem("sr-admin") || localStorage.getItem("sr-admin"); } catch (_) { return null; }
  }
  function merke(wert, dauerhaft) {
    try {
      sessionStorage.setItem("sr-admin", wert);
      if (dauerhaft) localStorage.setItem("sr-admin", wert);
    } catch (_) {}
  }
  function vergiss() {
    try { sessionStorage.removeItem("sr-admin"); localStorage.removeItem("sr-admin"); } catch (_) {}
  }

  let timer = null;
  function meldung(text, gut) {
    const m = $("meldung");
    m.textContent = text;
    m.style.background = gut ? "var(--info)" : "var(--schaden)";
    m.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => (m.hidden = true), 4000);
  }

  async function api(methode, pfad, body) {
    const r = await fetch(SERVER + pfad, {
      method: methode,
      headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { vergiss(); secret = null; zeige(); throw new Error("Secret falsch"); }
    return { ok: r.ok, status: r.status, daten: d };
  }

  function el(tag, attrs, ...kinder) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else e.setAttribute(k, v);
    }
    for (const k of kinder) if (k != null) e.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
    return e;
  }

  async function lade() {
    const { daten } = await api("GET", "/admin/uebersicht");
    const liste = $("spieler");
    liste.textContent = "";
    if (!daten.spieler.length) liste.appendChild(el("li", null, el("span", { class: "leise" }, "Noch keine Spieler.")));
    for (const s of daten.spieler) {
      liste.appendChild(el("li", null,
        el("i", { class: "verbindung" + (s.online ? " an" : ""), title: s.online ? "online" : "offline" }),
        el("span", { class: "name" }, `${s.name}${s.charakter ? " – " + s.charakter : " – kein Charakter"}${s.hatCode ? "" : " – kein Code"}`),
        el("button", { class: "zweit", onclick: () => code(s) }, s.hatCode ? "Neuer Code" : "Code erzeugen"),
        el("button", { class: "zweit", onclick: () => bogen(s) }, "Bogen"),
        el("button", { class: "gefahr", onclick: () => loeschen(s) }, "Entfernen")));
    }
    $("ki-status").textContent = daten.ki ? "Aktiv: Die KI-Spielleitung antwortet (Claude Haiku 4.5)." : "Nicht aktiv: Kein ANTHROPIC_API_KEY im Worker, es antwortet die Platzhalter-SL.";
    const kst = daten.kosten;
    $("kosten").textContent = `Kosten heute: ${kst.heute.usd.toFixed(2)} USD in ${kst.heute.aufrufe} Aufrufen · diesen Monat: ${kst.monat.usd.toFixed(2)} USD · Tageslimit ${kst.tageslimit} USD`;
    const ov = $("override");
    if (document.activeElement !== ov) {
      ov.textContent = "";
      ov.appendChild(el("option", { value: "" }, "niemand"));
      for (const sp of daten.spieler) ov.appendChild(el("option", { value: sp.id }, sp.name));
      ov.value = daten.einstellungen.overrideSpieler || "";
    }
    $("playtest").checked = daten.einstellungen.playtestHinweise !== false;
    $("hinweis-zahl").textContent = daten.offeneHinweise ? `(${daten.offeneHinweise} offen)` : "";
    ladeHinweise();
    $("tisch-status").textContent = daten.tisch.hatCode ? (daten.tisch.online ? "Tischgerät ist verbunden." : "Tisch-Code vorhanden, Gerät nicht verbunden.") : "Noch kein Tisch-Code.";
    $("tisch-code").textContent = daten.tisch.hatCode ? "Neuen Tisch-Code erzeugen" : "Tisch-Code erzeugen";
    for (const k of ["ort", "zeit", "run", "szene"]) if (document.activeElement !== $("sz-" + k)) $("sz-" + k).value = daten.szene[k] || "";
    $("sitzung").textContent = daten.sitzung.aktiv ? `Sitzung ${daten.sitzung.nr} läuft.` : `Keine laufende Sitzung (bisher ${daten.sitzung.nr}).`;
    $("pp-reset").checked = !!daten.einstellungen.plotpunkteJeSitzungZuruecksetzen;
  }

  async function ladeHinweise() {
    const { daten } = await api("GET", "/admin/hinweise");
    const liste = $("hinweise");
    liste.textContent = "";
    if (!daten.hinweise.length) { liste.appendChild(el("li", null, el("span", { class: "leise" }, "Keine Rückmeldungen."))); return; }
    for (const x of daten.hinweise) {
      const zeit = new Date(x.zeit).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
      const box = el("input", { type: "checkbox", "aria-label": "erledigt" });
      box.checked = !!x.erledigt;
      box.addEventListener("change", async () => { await api("PUT", `/admin/hinweise/${x.id}`, { erledigt: box.checked }); });
      liste.appendChild(el("li", { style: x.erledigt ? "opacity:.5" : "" }, box,
        el("span", { class: "name" }, `${x.text}`),
        el("span", { class: "leise klein" }, `${x.quelle === "ki" ? "SL" : "System"} · Sitzung ${x.sitzung}, Runde ${x.runde} · ${zeit}`)));
    }
  }

  async function code(s) {
    if (s.hatCode && !confirm(`Neuen Code für ${s.name} erzeugen? Der alte wird ungültig und ${s.name} wird abgemeldet.`)) return;
    const { ok, daten } = await api("POST", `/admin/spieler/${s.id}/code`);
    if (!ok) return meldung("Code konnte nicht erzeugt werden");
    $("code-fuer").textContent = `Für ${s.name}:`;
    $("code").textContent = daten.code;
    $("code-box").hidden = false;
    $("code-box").scrollIntoView({ behavior: "smooth" });
    lade();
  }

  async function bogen(s) {
    aktuellerSpieler = s;
    $("bogen-titel").textContent = `Charakterbogen für ${s.name}`;
    $("bogen-json").value = "";
    $("bogen-ergebnis").textContent = "";
    $("bogen-box").hidden = false;
    $("bogen-box").scrollIntoView({ behavior: "smooth" });
  }

  async function bogenSpeichern() {
    let bogen;
    try { bogen = JSON.parse($("bogen-json").value); } catch (e) {
      return zeigeErgebnis(["JSON nicht lesbar: " + e.message], []);
    }
    const { ok, daten } = await api("PUT", `/admin/spieler/${aktuellerSpieler.id}/charakter`, bogen);
    if (!ok) return zeigeErgebnis(daten.fehler || ["Unbekannter Fehler"], daten.hinweise || []);
    zeigeErgebnis([], daten.hinweise || [], `Gespeichert. Monitore: K ${daten.monitore.K}, G ${daten.monitore.G} Kreise (S. 76).`);
    lade();
  }

  function zeigeErgebnis(fehler, hinweise, erfolg) {
    const box = $("bogen-ergebnis");
    box.textContent = "";
    if (erfolg) box.appendChild(el("p", { class: "ergebnis ja" }, erfolg));
    if (fehler.length) box.appendChild(el("p", { class: "ergebnis nein" }, "Nicht gespeichert:"));
    for (const f of fehler) box.appendChild(el("p", { class: "ergebnis nein klein" }, "• " + f));
    if (hinweise.length) box.appendChild(el("p", { class: "leise" }, "Hinweise (gespeichert, aber bitte prüfen):"));
    for (const x of hinweise) box.appendChild(el("p", { class: "leise klein" }, "• " + x));
  }

  async function loeschen(s) {
    if (!confirm(`${s.name} mitsamt Charakter entfernen? Das lässt sich nicht rückgängig machen.`)) return;
    await api("DELETE", `/admin/spieler/${s.id}`);
    lade();
  }

  function zeige() {
    $("anmeldung").hidden = !!secret;
    $("inhalt").hidden = !secret;
    if (secret) lade().catch((e) => meldung(e.message));
  }

  $("anmeldung").addEventListener("submit", async (e) => {
    e.preventDefault();
    secret = $("secret").value;
    try {
      await api("GET", "/admin/uebersicht");
      merke(secret, $("merken").checked);
      $("secret").value = "";
      zeige();
    } catch (err) { meldung(err.message); }
  });

  $("neu").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("neu-name").value.trim();
    if (!name) return;
    await api("POST", "/admin/spieler", { name });
    $("neu-name").value = "";
    lade();
  });

  $("tisch-code").addEventListener("click", async () => {
    if (!confirm("Neuen Tisch-Code erzeugen? Ein bereits angemeldetes Tischgerät wird abgemeldet.")) return;
    const { ok, daten } = await api("POST", "/admin/tisch/code");
    if (!ok) return meldung("Tisch-Code konnte nicht erzeugt werden");
    $("code-fuer").textContent = "Für das Tischgerät:";
    $("code").textContent = daten.code;
    $("code-box").hidden = false;
    $("code-box").scrollIntoView({ behavior: "smooth" });
    lade();
  });
  $("playtest").addEventListener("change", async (e) => {
    await api("PUT", "/admin/einstellungen", { playtestHinweise: e.target.checked });
    meldung("Gespeichert", true);
  });
  $("hinweise-laden").addEventListener("click", () => lade());
  $("hinweise-loeschen").addEventListener("click", async () => {
    if (!confirm("Alle als erledigt markierten Rückmeldungen löschen?")) return;
    await api("DELETE", "/admin/hinweise/erledigte");
    lade();
  });
  $("override").addEventListener("change", async (e) => {
    await api("PUT", "/admin/einstellungen", { overrideSpieler: e.target.value || null });
    meldung("Override gespeichert", true);
  });
  $("testrun").addEventListener("click", async () => {
    if (!confirm("Test-Run zurücksetzen? NSC, Kanon und Szenenkopf beginnen von vorn.")) return;
    const { ok } = await api("POST", "/admin/testrun");
    meldung(ok ? "Test-Run zurückgesetzt" : "Fehlgeschlagen", ok);
  });
  $("sz-speichern").addEventListener("click", async () => {
    const body = {};
    for (const k of ["ort", "zeit", "run", "szene"]) body[k] = $("sz-" + k).value;
    const { ok } = await api("PUT", "/admin/szene", body);
    meldung(ok ? "Szenenkopf gespeichert" : "Speichern fehlgeschlagen", ok);
  });
  $("code-kopieren").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("code").textContent); meldung("Kopiert", true); } catch (_) { meldung("Kopieren nicht möglich, bitte abschreiben"); }
  });
  $("code-schliessen").addEventListener("click", () => { $("code-box").hidden = true; $("code").textContent = ""; });
  $("bogen-vorlage").addEventListener("click", () => { $("bogen-json").value = JSON.stringify(VORLAGE, null, 2); });
  $("bogen-speichern").addEventListener("click", () => bogenSpeichern().catch((e) => meldung(e.message)));
  $("bogen-schliessen").addEventListener("click", () => { $("bogen-box").hidden = true; });
  $("sitzung-beenden").addEventListener("click", async () => {
    if (!confirm("Laufende Sitzung für alle beenden?")) return;
    await api("POST", "/admin/sitzung/beenden");
    lade();
  });
  $("protokoll-leeren").addEventListener("click", async () => {
    if (!confirm("Den gesamten Verlauf aller Sitzungen löschen? Das lässt sich nicht rückgängig machen.")) return;
    await api("DELETE", "/admin/protokoll");
    meldung("Protokoll gelöscht", true);
  });
  $("pp-reset").addEventListener("change", async (e) => {
    await api("PUT", "/admin/einstellungen", { plotpunkteJeSitzungZuruecksetzen: e.target.checked });
    meldung("Gespeichert", true);
  });
  $("abmelden").addEventListener("click", () => { vergiss(); secret = null; zeige(); });

  if (!SERVER || SERVER.includes("DEIN-NAME")) {
    document.querySelector("main").appendChild(el("p", { class: "ergebnis nein" }, "In config.js fehlt noch die Adresse des Servers."));
  }
  zeige();
})();
