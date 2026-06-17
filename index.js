const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { chromium } = require('playwright');
require('dotenv').config();
const app = express();
app.use(cors());
app.use(express.json());

// ── Hardened bot instance (Option B, staging/rebuild) ─────────────────────────
// This bot holds NO Supabase service-role key and performs ZERO direct DB/Storage
// calls. It authenticates inbound requests with a shared Bearer secret, runs the
// Bosch advisor, and POSTs the result back to the auraos server-mediated callback
// (which owns the service-role write). See cluster spec §0/§0.1/§3.2/§3.2b/§6.

// ── Config / env (no secrets logged, ever) ────────────────────────────────────
const WEBHOOK_SECRET = process.env.BOSCH_BOT_WEBHOOK_SECRET || '';
const CALLBACK_URL   = process.env.AURAOS_CALLBACK_URL || '';
// AURAOS_PDF_URL is optional: if unset, derive it from the callback origin.
const PDF_URL = process.env.AURAOS_PDF_URL || derivePdfUrl(CALLBACK_URL);
const CALLBACK_TIMEOUT_MS = 15000;

/** Derive the PDF endpoint from the callback origin when AURAOS_PDF_URL is unset. */
function derivePdfUrl(callbackUrl) {
  if (!callbackUrl) return '';
  try {
    return new URL('/api/internal/bosch-planer-pdf', callbackUrl).toString();
  } catch (e) {
    return '';
  }
}

// ── Inbound auth: constant-time Bearer compare, fail-closed ───────────────────
/**
 * Constant-time compare of the inbound Bearer token against the configured secret.
 * Fail-closed: if the env secret is unset/empty -> false (every request rejected).
 * Both sides are sha256-normalized to a fixed 32-byte length so timingSafeEqual
 * never throws on a length mismatch and never leaks length via timing.
 * The secret is never logged.
 */
function isAuthorized(req) {
  if (!WEBHOOK_SECRET) return false; // fail closed — no secret configured
  const header = req.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!presented) return false;
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(WEBHOOK_SECRET, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// ── Outbound result callback (auraos owns the DB write) ───────────────────────
/**
 * POST a result payload to the auraos callback with the shared Bearer secret.
 * Best-effort: failures are logged (status only, never the secret) and never crash
 * the run. Uses a 15s AbortSignal timeout so a hung callback cannot stall the bot.
 */
async function sendCallback(payload) {
  if (!CALLBACK_URL) {
    console.warn('⚠️  AURAOS_CALLBACK_URL unset — skipping callback');
    return;
  }
  try {
    const res = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBHOOK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`⚠️  Callback non-2xx: ${res.status} (status=${payload.status})`);
    } else {
      console.log(`📡 Callback OK: ${res.status} (status=${payload.status})`);
    }
  } catch (e) {
    // Never log the secret; status/message only.
    console.error(`⚠️  Callback failed (status=${payload.status}):`, e.message);
  }
}

/**
 * Upload the recommendation PDF bytes to the auraos PDF endpoint (Ruling b). The bot
 * no longer holds Storage access; auraos uploads + signs + stamps pdf_url server-side.
 * Best-effort: a failure is logged and never crashes the run. result_id/lead_id go as
 * query params; the body is the raw PDF (application/pdf).
 */
async function uploadPdf(pdfBuffer, { result_id, lead_id }) {
  if (!PDF_URL) {
    console.warn('⚠️  AURAOS_PDF_URL unset and not derivable — skipping PDF upload');
    return;
  }
  try {
    const url = new URL(PDF_URL);
    if (result_id) url.searchParams.set('result_id', result_id);
    if (lead_id) url.searchParams.set('lead_id', lead_id);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBHOOK_SECRET}`,
        'Content-Type': 'application/pdf',
      },
      body: pdfBuffer,
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`⚠️  PDF upload non-2xx: ${res.status}`);
    } else {
      console.log(`📄 PDF upload OK: ${res.status}`);
    }
  } catch (e) {
    // Never log the secret; status/message only.
    console.error('⚠️  PDF upload failed:', e.message);
  }
}

app.post('/api/run-advisor', async (req, res) => {
  // ── Inbound auth FIRST — before reading the body or launching anything ───────
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { lead_id, triggered_by = null, inputs = {}, result_id = null } = req.body || {};
  const {
    plz                         = '10405',
    energieverbrauch            = 23000,
    wohnflaeche                 = 160,
    raumheizung                 = 'Heizkörper',
    haushaltsgroesse            = 4,
    deckenhoehe_hwr             = 240,
    trinkwasser                 = 'Ja',
    evu_sperre                  = false,
    gebaude_erweiterung_geplant = false,
    noise_level_filter          = false,
    value_class_filter          = '5000',
  } = inputs;
  let browser;
  let done = false; // guards against a contradictory error callback after success

  const advisor_inputs = {
    plz, energieverbrauch, wohnflaeche, raumheizung, haushaltsgroesse,
    deckenhoehe_hwr, evu_sperre, gebaude_erweiterung_geplant,
    noise_level_filter, value_class_filter,
  };

  // ── Cookie-Banner Helper ───────────────────────────────────────────────────
  async function dismissCookieBanner(page) {
    try {
      await page.getByRole('button', { name: 'Alles akzeptieren' }).click({ timeout: 3000, force: true });
      await page.waitForTimeout(400);
    } catch (e) {}
    await page.evaluate(() => {
      const el = document.querySelector('dock-privacy-settings');
      if (el) el.remove();
    });
    await page.waitForTimeout(300);
  }

  // ── Respond immediately — the advisor runs in the background ────────────────
  // result_id is echoed back (passthrough §0.1 Q2 / contract item 5). The trigger
  // already created the pending row; the bot no longer touches the DB.
  console.log(`\n🚀 Lead: ${lead_id} | result_id: ${result_id ?? '(none)'}`);
  res.status(202).json({
    success: true,
    result_id,
    message: 'HPA läuft, Status via auraos-Callback',
  });
  // ── From here on: async in the background ────────────────────────────────────

  const warmwasserAktiv = !String(trinkwasser).startsWith('Nein');

  // Optional interim "running" callback (the terminal one is mandatory).
  await sendCallback({ result_id, lead_id, triggered_by, status: 'running' });

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    // ── SCHRITT 1: Seite laden ───────────────────────────────────────────────
    await page.goto('https://bosch-de-heatpump.thernovo.com/home', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissCookieBanner(page);
    await page.getByText('Straße Hausnummer').click({ force: true });
    await page.waitForTimeout(300);
    await page.locator('.col-md-12').click({ force: true });
    await page.waitForTimeout(300);
    await dismissCookieBanner(page);
    console.log('📍 PLZ: ' + plz);
    await page.getByRole('textbox', { name: 'PLZ *' }).click();
    await page.getByRole('textbox', { name: 'PLZ *' }).fill(String(plz));
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Start' }).click();
    await page.waitForTimeout(1000);
    // ── SCHRITT 2: Projektart → Default Sanierung → Weiter ──────────────────
    console.log('🏗️  [2] Projektart...');
    await page.waitForSelector('text=Welche Art von Projekt', { timeout: 20000 });
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 3: Zweiter Wärmeerzeuger → Default Nein → Weiter ────────────
    console.log('🔧 [3] Zweiter Wärmeerzeuger...');
    await page.waitForSelector('text=zweiter', { timeout: 20000 });
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 4: Temperaturen → Default ok → Weiter ───────────────────────
    console.log('🌡️  [4] Temperaturen...');
    await page.waitForSelector('text=Welche Temperaturen', { timeout: 20000 });
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 5: Wärmebedarf ───────────────────────────────────────────────
    console.log(`⚡ [5] Wärmebedarf: ${energieverbrauch} kWh/a | Warmwasser über WP: ${warmwasserAktiv ? 'Ja' : 'Nein'}`);
    await page.waitForSelector('text=Wie hoch ist der Wärmebedarf', { timeout: 20000 });
    await page.getByRole('tab', { name: 'in kWh/a (Verbrauch/Jahr) ' }).click();
    await page.waitForTimeout(400);
    if (warmwasserAktiv) {
      await page.getByLabel('in kWh/a (Verbrauch/Jahr)').getByText('Heizlast ist inkl. Warmwasser').click();
      await page.waitForTimeout(300);
    }
    await page.getByRole('textbox', { name: 'Energiebedarf' }).click({ clickCount: 3 });
    await page.getByRole('textbox', { name: 'Energiebedarf' }).type(String(energieverbrauch), { delay: 50 });
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 6: Verteilsystem ─────────────────────────────────────────────
    console.log('🔥 [6] Verteilsystem: ' + raumheizung);
    await page.waitForSelector('text=Welches Verteilsystem', { timeout: 20000 });
    await page.getByText(raumheizung, { exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 7: Warmwasser Personen ───────────────────────────────────────
    console.log(`👥 [7] Warmwasser Personen | Warmwasser über WP: ${warmwasserAktiv ? 'Ja' : 'Nein'}`);
    await page.waitForSelector('text=Wie viele Personen', { timeout: 20000 });

    if (!warmwasserAktiv) {
      // ── Kein Warmwasser über WP → Button klicken, Schritte 8+9 entfallen ──
      console.log('🚫 [7] Kein Warmwasser — klicke "Kein Warmwasser. Nur Heizung."');
      await page.getByText('Kein Warmwasser. Nur Heizung.').click();
      await page.waitForTimeout(300);
    } else {
      // ── Warmwasser aktiv → Personenanzahl setzen ──
      if (haushaltsgroesse !== 4) {
        const input = page.locator('input[type="number"], input[name*="person"], input[name*="Person"]').first();
        await input.click({ clickCount: 3 });
        await input.type(String(haushaltsgroesse), { delay: 50 });
        await page.waitForTimeout(300);
      }
    }

    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);

    // ── SCHRITT 8 + 9: Nur wenn Warmwasser über WP ──────────────────────────
    if (warmwasserAktiv) {
      // ── SCHRITT 8: Warmwassersystem ──────────────────────────────────────
      console.log('💧 [8] Warmwassersystem...');
      await page.waitForSelector('text=Welches Warmwassersystem', { timeout: 20000 });
      await page.getByRole('button', { name: 'Weiter' }).click();
      await page.waitForTimeout(700);
      // ── SCHRITT 9: Warmwassermenge ───────────────────────────────────────
      console.log('🚿 [9] Warmwassermenge...');
      await page.waitForSelector('text=Warmwassermenge', { timeout: 20000 });
      await page.getByRole('button', { name: 'Weiter' }).click();
      await page.waitForTimeout(700);
    } else {
      console.log('⏭️  [8+9] Übersprungen (kein Warmwasser)');
    }

    // ── SCHRITT 10: Technologie Art ──────────────────────────────────────────
    console.log('🌬️  [10] Technologie Art...');
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 10b: Kompressor-Technologie (nur bei >= 39.150 kWh) ──────────
    if (energieverbrauch >= 39150) {
      console.log('⚡ [10b] Kompressor-Technologie: Inverter (kWh >= 39.150)');
      await page.waitForSelector('text=Inverter', { timeout: 10000 });
      await page.getByText('Inverter', { exact: true }).click();
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: 'Weiter' }).click();
      await page.waitForTimeout(700);
    }
    // ── SCHRITT 11: Technologie Aufstellung ──────────────────────────────────
    console.log('🏠 [11] Technologie Aufstellung...');
    await page.waitForSelector('text=Welche Technologie', { timeout: 20000 });
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 12: Distanz Schall (optional) ────────────────────────────────
    console.log('📏 [12] Distanz Schall (optional)...');
    try {
      await page.waitForSelector('text=Abstand', { timeout: 8000 });
      await page.getByRole('button', { name: 'Weiter' }).click();
      console.log('📏 [12] Abstand-Schritt durchgeführt');
      await page.waitForTimeout(2000);
    } catch (e) {
      console.log('📏 [12] Abstand-Schritt nicht vorhanden — übersprungen');
    }
    // ── SCHRITT 13: Produktauswahl ───────────────────────────────────────────
    const serie = raumheizung.includes('Heizkörper') ? '6800i' : '5800i';

    // ── SCHRITT 13a: Außeneinheit waehlen (1. Stufe der neuen Produktauswahl) ──
    console.log(`🌳 [13a] Außeneinheit-Stufe: Serie ${serie}`);
    await dismissCookieBanner(page);
    // Kältemittel R290 ist Standard, defensiv sicherstellen:
    await page.getByText('Natürliches Kältemittel (R290)')
      .click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    // Passende Außeneinheit-Karte anklicken (Klick auf die Karte waehlt sie aus)
    const awKarte = page.getByText(new RegExp(`Compress\\s+${serie}\\s+AW`, 'i')).first();
    await awKarte.waitFor({ state: 'visible', timeout: 20000 });
    await awKarte.click({ force: true });
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(2000);
    console.log('🌳 [13a] Außeneinheit gewählt, weiter zur Inneneinheit');

    // Suffix-Logik:
    // - Heizkörper (auch HK+FB Kombi) → immer MB
    // - Fußbodenheizung + Deckenhöhe >= 235 → M
    // - Fußbodenheizung + Deckenhöhe < 235 → MB (M passt nicht)
    // - E wird nie gewählt
    let suffix;
    if (raumheizung.includes('Heizkörper')) {
      suffix = 'MB';
    } else {
      suffix = deckenhoehe_hwr >= 235 ? 'M' : 'MB';
    }

    const csModel = `CS${serie} AW 12 ${suffix}`;
    // dbModel is the Innen model STRING the callback resolves to products.model_number
    // (Q5=b: bot stays DB-free and ships a name/model string, not a uuid).
    const dbModel = `CS${serie}AW 12 ${suffix}`;
    let empfohlenes_produkt = `Compress ${serie} AW + ${csModel}`;
    console.log(`🧠 [13] Produkt: ${empfohlenes_produkt} (Suffix: ${suffix}, Deckenhöhe: ${deckenhoehe_hwr}cm)`);
    // FIX: Cookie-Banner entfernen + state: 'attached' statt 'visible'
    // Der Cookie-Banner (dock-privacy-settings Web Component) überlagert als
    // transparenter Layer die Seite und blockiert den visibility-Check von
    // Playwright — obwohl das Element im DOM vorhanden ist.
    await dismissCookieBanner(page);
    const csRegex = new RegExp(`CS\\s*${serie}\\s*AW\\s*12\\s*${suffix}\\b`, 'i');
    const karte = page.locator('a, div, label').filter({ hasText: csRegex }).first();
    await karte.waitFor({ state: 'attached', timeout: 35000 });
    await page.waitForTimeout(500);
    const kartenText = await karte.textContent().catch(() => '');
    const awMatch = kartenText.match(/AW\s+(\d+)\s+(OR-[ST])/);
    const aussenBezeichnung = awMatch ? `${serie} AW ${awMatch[1]} ${awMatch[2]}` : null;
    console.log(`🔍 Außeneinheit erkannt: ${aussenBezeichnung ?? 'nicht gefunden'}`);
    await page.getByText(csRegex).first().click();
    await page.waitForTimeout(800);
    const weiterProdukt = page.getByRole('button', { name: 'Weiter' });
    await weiterProdukt.waitFor({ state: 'visible', timeout: 20000 });
    await weiterProdukt.click();
    await page.waitForTimeout(2000);
    // ── Ergebnisseite ────────────────────────────────────────────────────────
    console.log('📊 Warte auf Ergebnisseite...');
    await page.waitForSelector('button:has-text("PDF Download")', { timeout: 20000 });
    console.log('✅ Ergebnisseite geladen!');
    const tabellenDaten = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr, [class*="row"], [class*="Row"]'));
      let spitzenLeistungWerte = [];
      let spaltenKoepfe = [];
      for (const row of rows) {
        const text = row.textContent || '';
        if (text.includes('OR-S') || text.includes('OR-T')) {
          const cells = Array.from(row.querySelectorAll('td, th, [class*="cell"], [class*="Cell"]'));
          spaltenKoepfe = cells.map(c => c.textContent.trim()).filter(t => t.length > 0);
        }
        if (text.includes('Spitzenleistung')) {
          const cells = Array.from(row.querySelectorAll('td, [class*="cell"], [class*="Cell"], [class*="Data"]'));
          spitzenLeistungWerte = cells
            .map(c => c.textContent.trim())
            .filter(t => t.includes('%') && !t.includes('Spitzenleistung'));
        }
      }
      return { spitzenLeistungWerte, spaltenKoepfe };
    });
    console.log('📋 Spaltenköpfe:', tabellenDaten.spaltenKoepfe);
    console.log('📊 Spitzenleistung Werte:', tabellenDaten.spitzenLeistungWerte);
    const parsePct = (text) => {
      if (!text) return null;
      const match = text.match(/(\d+)\s*%/);
      return match ? parseInt(match[1]) : null;
    };
    const extractAW = (text) => {
      const m = text ? text.match(/AW\s+(\d+)\s+(OR-[ST])/) : null;
      return m ? `AW ${m[1]} ${m[2]}` : null;
    };
    const awKoepfe = tabellenDaten.spaltenKoepfe.filter(t => t.includes('OR-'));
    const pctWerte = tabellenDaten.spitzenLeistungWerte.map(t => parsePct(t));
    const varianten = awKoepfe.map((kopf, i) => ({
      aw:    extractAW(kopf),
      pct:   pctWerte[i] ?? null,
      index: i,
    })).filter(v => v.pct !== null);
    console.log('🔍 Varianten:', varianten);
    const beste = varianten.reduce((a, b) =>
      Math.abs(a.pct - 100) <= Math.abs(b.pct - 100) ? a : b
    );
    const ausgewaehltIndex = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const ausgewaehlt = btns.find(b => b.textContent.trim() === 'Ausgewählt');
      if (!ausgewaehlt) return 0;
      const allBtns = btns.filter(b =>
        b.textContent.trim() === 'Ausgewählt' || b.textContent.trim() === 'Produkt ändern'
      );
      return allBtns.indexOf(ausgewaehlt);
    });
    console.log(`🎯 Beste Variante: ${beste.aw} (${beste.pct}%) Index: ${beste.index} | Aktuell: Index ${ausgewaehltIndex}`);
    const spitzenleistung_klein_pct = pctWerte[0] ?? null;
    const spitzenleistung_gross_pct = pctWerte[pctWerte.length - 1] ?? null;
    let finalesAW = beste.aw;
    if (beste.index !== ausgewaehltIndex) {
      // NEU: Bosch wechselt die Variante jetzt INLINE auf der Ergebnisseite.
      // Kein Zurueck zur Inneneinheit, kein Weiter, keine neue Ergebnisseite mehr.
      console.log(`🔄 Wechsle inline zu: ${beste.aw} (Spalte ${beste.index})`);
      // Gezielte Spaltenwahl: alle Varianten-Buttons in Spalten-Reihenfolge
      // (Ausgewählt + Produkt ändern), dann den an Position beste.index klicken.
      // Robust fuer beliebig viele Varianten, nicht nur zwei.
      const variantenBtns = page.getByRole('button', { name: /^(Ausgewählt|Produkt ändern)$/ });
      const btnCount = await variantenBtns.count();
      console.log(`🔢 Varianten-Buttons: ${btnCount} | Ziel-Spalte: ${beste.index}`);
      await variantenBtns.nth(beste.index).click();
      await page.waitForTimeout(1500);
      console.log('✅ Variante inline gewechselt');
    }
    const decision = beste.pct >= 80 && beste.pct <= 110 ? 'ok' : beste.pct > 110 ? 'ueberdimensioniert' : 'warnung';
    const warning_message = beste.pct > 110
      ? `Spitzenleistung ${beste.pct}% – Überdimensionierung prüfen`
      : beste.pct < 80
      ? `Spitzenleistung ${beste.pct}% – unter 80%, manuelle Prüfung empfohlen`
      : null;
    console.log(`🎯 Decision: ${decision} (${beste.pct}%) ${warning_message ?? ''}`);
    const ausgewaehlteSpalte = awKoepfe[beste.index] ?? null;
    empfohlenes_produkt = ausgewaehlteSpalte
      ? `Compress ${serie} ${ausgewaehlteSpalte}`
      : `Compress ${serie} ${finalesAW} + ${csModel}`;
    // matched_product_id_aussen carries the aussen MODEL string (Q5=b); the callback
    // resolves it to products.id via name ILIKE. (alt: `Compress ${serie} ${finalesAW}`)
    const aussenModelString = finalesAW ? `Compress ${serie} ${finalesAW}` : null;
    // ── PDF Download ─────────────────────────────────────────────────────────
    console.log('📥 PDF Download...');
    await page.getByRole('button', { name: 'PDF Download' }).first().click();
    await page.waitForTimeout(1000);
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
    await page.getByRole('button', { name: 'Diese Empfehlung herunterladen' }).click();
    const download = await downloadPromise;
    console.log(`📄 PDF heruntergeladen: ${download.suggestedFilename()}`);
    const path = require('path');
    const fs   = require('fs');
    const tmpPath = path.join('/tmp', `bosch-hpa-${result_id ?? lead_id ?? 'run'}.pdf`);
    await download.saveAs(tmpPath);
    const pdfBuffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    // ── PDF Upload (Ruling b): POST bytes to auraos, which uploads + signs ─────
    // Best-effort — a PDF failure must not block the completed result.
    await uploadPdf(pdfBuffer, { result_id, lead_id });

    // ── Close the browser BEFORE the completed callback (contract item 6) ──────
    // A post-success browser.close() failure must NOT emit a contradictory error
    // callback, so close first (swallowing any error) and set the done flag.
    await browser.close().catch(() => {});
    done = true;

    // ── Completed callback: pdf_url stays null — the PDF endpoint sets it ──────
    // server-side (decoupled, Ruling b). matched_product_id_* carry MODEL STRINGS
    // (Q5=b); the callback resolves them to products.id.
    await sendCallback({
      result_id,
      lead_id,
      triggered_by,
      status: 'completed',
      empfohlenes_produkt,
      matched_product_id_innen: dbModel,
      matched_product_id_aussen: aussenModelString,
      spitzenleistung_klein_pct,
      spitzenleistung_gross_pct,
      decision,
      warning_message,
      error_message: null,
      pdf_url: null,
      advisor_inputs,
      evu_sperre,
      gebaude_erweiterung_geplant,
      noise_level_filter,
      value_class_filter,
    });
    console.log(`🏁 Fertig! ${empfohlenes_produkt} → ${decision} (${beste.pct}%)`);
  } catch (error) {
    console.error('💥 FEHLER:', error.message);
    if (browser) await browser.close().catch(() => {});
    // Guard: if we already completed successfully, do NOT emit a contradictory
    // error callback (a late browser.close() failure must not flip the result).
    if (!done) {
      await sendCallback({
        result_id,
        lead_id,
        triggered_by,
        status: 'error',
        error_message: error.message,
        advisor_inputs,
      });
    }
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Bosch HPA Bot läuft auf Port ${PORT}`));
