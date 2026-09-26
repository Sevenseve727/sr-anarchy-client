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
    $("sitzung").textContent = daten.sitzung.aktiv ? `Sitzung ${daten.sitzung.nr} läuft.` : `Keine laufende Sitzung (bisher ${daten.sitzung.nr}).`;
    $("pp-reset").checked = !!daten.einstellungen.plotpunkteJeSitzungZuruecksetzen;
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
