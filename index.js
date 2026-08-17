const express = require('express');
const cors    = require('cors');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const app = express();
app.use(cors());
app.use(express.json());
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
app.post('/api/run-advisor', async (req, res) => {
  const { lead_id, triggered_by = null, inputs } = req.body;
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
  let record_id = null;
  // ── Supabase Helpers ───────────────────────────────────────────────────────
  async function dbInsert(fields) {
    const { data, error } = await supabase
      .from('lead_hpa_results').insert(fields).select('id').single();
    if (error) throw new Error(`DB Insert Fehler: ${error.message}`);
    return data.id;
  }
  async function dbUpdate(id, fields) {
    const { error } = await supabase
      .from('lead_hpa_results').update(fields).eq('id', id);
    if (error) console.error(`DB Update Fehler: ${error.message}`);
  }
  async function findProductId(csModel) {
    const { data } = await supabase
      .from('products').select('id, name')
      .ilike('model_number', `%${csModel}%`).limit(1).single();
    if (!data) { console.warn(`⚠️ Kein Produkt für: ${csModel}`); return null; }
    console.log(`✅ Produkt: ${data.name}`);
    return data.id;
  }
  // ── Startseite laden ───────────────────────────────────────────────────────
  // Die Bosch-Seite (Azure) hängt zeitweise komplett — Requests laufen ohne ein
  // einziges Byte in den Timeout. Ein einzelner Aussetzer darf den Lauf nicht
  // killen, also mehrere Versuche mit wachsender Pause.
  async function ladeStartseite(page) {
    const VERSUCHE = 4;
    for (let v = 1; v <= VERSUCHE; v++) {
      try {
        await page.goto('https://bosch-de-heatpump.thernovo.com/home',
          { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (v > 1) console.log(`🌐 Startseite geladen (Versuch ${v}/${VERSUCHE})`);
        return;
      } catch (e) {
        const grund = e.message.split('\n')[0];
        console.warn(`⚠️ Startseite Versuch ${v}/${VERSUCHE} fehlgeschlagen: ${grund}`);
        if (v === VERSUCHE) {
          throw new Error(`Bosch-Seite nach ${VERSUCHE} Versuchen nicht erreichbar (${grund}) — Bosch-Dienst gestört, Lauf bitte später wiederholen.`);
        }
        await page.waitForTimeout(5000 * v);
      }
    }
  }
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
  // ── Concurrency Check — nur ein Run pro Lead gleichzeitig ───────────────
  const { data: laufend } = await supabase
    .from('lead_hpa_results')
    .select('id')
    .eq('lead_id', lead_id)
    .in('status', ['pending', 'running'])
    .limit(1);
  if (laufend && laufend.length > 0) {
    return res.status(409).json({
      success: false,
      error: 'Ein HPA-Lauf für diesen Lead läuft bereits.',
      record_id: laufend[0].id,
    });
  }
  // ── DB: pending (vor der Antwort) ───────────────────────────────────────
  console.log(`\n🚀 Lead: ${lead_id}`);
  try {
    record_id = await dbInsert({
      lead_id, triggered_by, status: 'pending',
      advisor_inputs: { plz, energieverbrauch, wohnflaeche, raumheizung,
        haushaltsgroesse, deckenhoehe_hwr, evu_sperre,
        gebaude_erweiterung_geplant, noise_level_filter, value_class_filter },
      evu_sperre, gebaude_erweiterung_geplant, noise_level_filter, value_class_filter,
    });
    console.log(`🗄️  Record: ${record_id}`);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
  // ── Sofort antworten — Bot läuft im Hintergrund weiter ──────────────────
  res.status(202).json({ success: true, record_id, message: 'HPA läuft, Status via Supabase polling' });
  // ── Ab hier async im Hintergrund ────────────────────────────────────────

  const warmwasserAktiv = !trinkwasser.startsWith('Nein');

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await dbUpdate(record_id, { status: 'running' });
    // ── SCHRITT 1: Seite laden ───────────────────────────────────────────────
    await ladeStartseite(page);
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
    // Baureihe: immer 5800i — auch bei reinen Heizkörper-Objekten (vorher: HK → 6800i).
    // Vorgabe des Bosch-Außendienstes: 5800i ist die anzubietende Serie, die höhere
    // Vorlauftemperatur der 6800i wird für unsere Objekte nicht benötigt.
    // Die Suffix-Logik unten (Heizkörper → MB) bleibt davon unberührt.
    const serie = '5800i';

    // ── SCHRITT 13a: Außeneinheit waehlen (1. Stufe der neuen Produktauswahl) ──
    console.log(`🌳 [13a] Außeneinheit-Stufe: Serie ${serie}`);
    await dismissCookieBanner(page);
    // Kältemittel R290 ist Standard, defensiv sicherstellen:
    await page.getByText('Natürliches Kältemittel (R290)')
      .click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    // ── NEU: Bosch hat die Produktauswahl umgebaut. Karten liegen jetzt in
    // App__IOUBundleCombinationsContainer und tragen data-Attribute. Der alte
    // Textselektor (Compress <serie> AW) griff nicht mehr, weil der sichtbare
    // Titel jetzt "Compress 5800i AW AW 10 OR-T" o.ä. lautet (Text zerstückelt).
    // Auswahl daher über data-product-name (enthält Serie) + R290-Filter
    // (data-refrigerant-type="Natural"). 3800i/8800i werden so ausgeschlossen.
    // "Egal welche Stufe" → erste passende Karte reicht (Leistungsstufe fällt
    // später auf der Ergebnisseite).
    await page.waitForSelector('.App__IOUnit__kf7TA', { timeout: 20000 });
    const awKarte = page.locator(
      `.App__IOUnit__kf7TA[data-product-name*="${serie}"][data-refrigerant-type="Natural"]`
    ).first();

    // Existenz prüfen; bei 0 Treffern HTML des Containers ins Log dumpen.
    if (await awKarte.count() === 0) {
      const dump = await page.evaluate(() => {
        const c = document.querySelector('.App__IOUBundleCombinationsContainer__KpgdE')
          || document.querySelector('[class*="IOUBundleCombinationsContainer"]');
        return c ? c.outerHTML.slice(0, 8000) : '(Container nicht gefunden)';
      });
      console.log('🐛 DEBUG Außeneinheit-Karten (erste 8000 Zeichen) ─────────────');
      console.log(dump);
      console.log('🐛 DEBUG Ende ──────────────────────────────────────────────────');
      throw new Error(
        `Keine Außeneinheit-Karte für Serie ${serie} mit R290 gefunden. ` +
        `Bosch-Produktauswahl evtl. geändert — siehe DEBUG oben.`
      );
    }

    const awKarteName = await awKarte.getAttribute('data-market-generic-description').catch(() => null);
    console.log(`🌳 [13a] Karte gewählt: ${serie} / ${awKarteName ?? 'Bezeichnung unbekannt'}`);

    // Klick: Karte selbst ist klickbar (kein Button/Radio innen). Mehrere
    // Strategien nacheinander, falls ein innenliegendes Element den Klick abfängt.
    await awKarte.scrollIntoViewIfNeeded().catch(() => {});
    let awGeklickt = false;
    for (const strat of ['self', 'title', 'parent']) {
      try {
        if (strat === 'self')  await awKarte.click({ force: true, timeout: 5000 });
        if (strat === 'title') await awKarte.locator('[class*="IOUnitTitle"]').first().click({ force: true, timeout: 5000 });
        if (strat === 'parent')await awKarte.locator('xpath=..').click({ force: true, timeout: 5000 });
        awGeklickt = true;
        console.log(`🌳 [13a] Klick-Strategie erfolgreich: ${strat}`);
        break;
      } catch (e) { /* nächste Strategie */ }
    }
    if (!awGeklickt) throw new Error('Außeneinheit-Karte gefunden, aber Klick auf keine Weise möglich.');
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
    // ══════════════════════════════════════════════════════════════════════════
    // ENTSCHEIDUNG: Wärmepumpenabdeckung (%), Ziel möglichst nah an 100 %.
    // Bosch-Ergebnisseite umgebaut: Tabelle #performance-data-table ist vertikal,
    // drei feste Spalten über CSS-Klassen: smallerBundle / defaultBundle / biggerBundle.
    // Die ausgewählte Spalte trägt zusätzlich App__SelectedBundleBKG.
    // Kopfzeile (Label "Wärmepumpe") enthält pro Spalte "AW <n> OR-x + CS...".
    // Abdeckungs-Zeile (Label "Wärmepumpenabdeckung") enthält pro Spalte den %-Wert;
    // eine unterdimensionierte Spalte trägt in der Zelle ein BoschAlertWarningIcon.
    // ══════════════════════════════════════════════════════════════════════════
    const tabellenDaten = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const POS = [
        { key: 'smaller', cls: 'smallerBundlePerformanceData' },
        { key: 'default', cls: 'defaultBundlePerformanceData' },
        { key: 'bigger',  cls: 'biggerBundlePerformanceData'  },
      ];

      const table = document.querySelector('#performance-data-table');
      if (!table) return { fehlt: 'tabelle', debugHtml: (document.body?.outerHTML || '').slice(0, 8000) };

      const rows = Array.from(table.querySelectorAll('tr'));
      // Zeile finden, deren erste Zelle (Label) einen bestimmten Text enthält.
      const findRow = (label) => rows.find((r) => {
        const firstTd = r.querySelector('td');
        return firstTd && norm(firstTd.textContent).startsWith(label);
      });

      const kopfRow      = findRow('Wärmepumpe');            // Produktnamen / AW-Bezeichnung
      const abdeckungRow = findRow('Wärmepumpenabdeckung');  // %-Werte + evtl. Warn-Icon

      const zelleFuer = (row, cls) =>
        row ? row.querySelector(`td[class*="${cls}"]`) : null;

      const spalten = POS.map(({ key, cls }) => {
        const kopfTd = zelleFuer(kopfRow, cls);
        const abTd   = zelleFuer(abdeckungRow, cls);
        return {
          position:      key,
          vorhanden:     !!(kopfTd || abTd),
          bezeichnung:   kopfTd ? norm(kopfTd.textContent) : null,
          abdeckungText: abTd ? norm(abTd.textContent) : null,
          hatWarnung:    !!(abTd && abTd.querySelector('[class*="BoschAlertWarningIcon"]')),
          istAusgewaehlt:!!(kopfTd && /SelectedBundleBKG/.test(kopfTd.className))
                        || !!(abTd && /SelectedBundleBKG/.test(abTd.className)),
        };
      }).filter(s => s.vorhanden);

      let debugHtml = null;
      if (!kopfRow || !abdeckungRow || spalten.length === 0) {
        debugHtml = table.outerHTML.slice(0, 8000);
      }
      return { spalten, debugHtml };
    });

    if (tabellenDaten.debugHtml) {
      console.log('🐛 DEBUG #performance-data-table (erste 8000 Zeichen) ──────────');
      console.log(tabellenDaten.debugHtml);
      console.log('🐛 DEBUG Ende ──────────────────────────────────────────────────');
    }

    const parsePct = (text) => {
      if (!text) return null;
      const m = text.match(/(\d+)\s*%/);
      return m ? parseInt(m[1]) : null;
    };
    // AW-Leistungszahl aus "AW 10 OR-T + CS5800iAW 12 E" → 10 (erste AW-Zahl = Außeneinheit).
    const parseAwNummer = (text) => {
      const m = text ? text.match(/AW\s*(\d+)\s*OR-[ST]/i) : null;
      return m ? parseInt(m[1]) : null;
    };
    // AW-Bezeichnung "AW 10 OR-T" aus dem Zelltext extrahieren.
    const extractAW = (text) => {
      const m = text ? text.match(/AW\s*(\d+)\s*(OR-[ST])/i) : null;
      return m ? `AW ${m[1]} ${m[2]}` : null;
    };

    const varianten = (tabellenDaten.spalten || []).map((s) => ({
      position:       s.position,          // smaller | default | bigger
      aw:             extractAW(s.bezeichnung),
      awNummer:       parseAwNummer(s.bezeichnung),
      pct:            parsePct(s.abdeckungText),   // pct = Wärmepumpenabdeckung
      hatWarnung:     s.hatWarnung,
      istAusgewaehlt: s.istAusgewaehlt,
    })).filter(v => v.pct !== null);
    console.log('🔍 Varianten:', varianten);

    // ── Crash-Absicherung (früher: reduce auf leerem Array) ─────────────────
    if (varianten.length === 0) {
      throw new Error(
        'Keine Varianten aus #performance-data-table lesbar (Wärmepumpenabdeckung nicht gefunden). ' +
        'Bosch-HTML evtl. geändert — siehe DEBUG-Ausgabe im Log oben.'
      );
    }

    // ── Auswahl: Abdeckung nächst-100 %; bei Gleichstand kleinere AW-Zahl ───
    const ZIEL_ABDECKUNG = 100;
    const beste = varianten.reduce((a, b) => {
      const da = Math.abs(a.pct - ZIEL_ABDECKUNG);
      const db = Math.abs(b.pct - ZIEL_ABDECKUNG);
      if (da !== db) return da < db ? a : b;                 // näher an 100 % gewinnt
      const na = a.awNummer ?? Number.POSITIVE_INFINITY;      // Gleichstand:
      const nb = b.awNummer ?? Number.POSITIVE_INFINITY;      // kleinere AW-Zahl gewinnt
      return na <= nb ? a : b;
    }, varianten[0]);

    const aktuelleAuswahl = varianten.find(v => v.istAusgewaehlt) ?? null;
    console.log(`🎯 Beste Variante: ${beste.aw} (Abdeckung ${beste.pct}%, Spalte ${beste.position}) | Aktuell ausgewählt: ${aktuelleAuswahl ? `${aktuelleAuswahl.aw} (${aktuelleAuswahl.position})` : 'unbekannt'}`);

    // Abdeckung kleinste/größte Spalte (nach AW-Zahl sortiert) für DB-Felder.
    const nachAw = [...varianten].sort((x, y) => (x.awNummer ?? 0) - (y.awNummer ?? 0));
    // Hinweis: Felder heißen weiterhin spitzenleistung_*, enthalten jetzt Abdeckung (%).
    const spitzenleistung_klein_pct = nachAw[0]?.pct ?? null;
    const spitzenleistung_gross_pct = nachAw[nachAw.length - 1]?.pct ?? null;
    let finalesAW = beste.aw;

    // ── Umschalten: nur wenn Zielspalte ≠ aktuell ausgewählte Spalte ────────
    // Klick gezielt auf die Zelle der Zielspalte (Bundle-Klasse), statt Button-Index.
    if (!beste.istAusgewaehlt) {
      console.log(`🔄 Wechsle inline zu Spalte "${beste.position}" (${beste.aw})`);
      const clsMap = {
        smaller: 'smallerBundlePerformanceData',
        default: 'defaultBundlePerformanceData',
        bigger:  'biggerBundlePerformanceData',
      };
      const zielCls = clsMap[beste.position];
      const zielZelle = page.locator(`#performance-data-table td[class*="${zielCls}"]`).first();
      await zielZelle.click({ force: true }).catch(async () => {
        console.warn('⚠️ Direkter Zell-Klick fehlgeschlagen — versuche Button-Fallback');
        const btns = page.getByRole('button', { name: /^(Ausgewählt|Produkt ändern)$/ });
        const idx = { smaller: 0, default: 1, bigger: 2 }[beste.position] ?? 0;
        await btns.nth(idx).click().catch(() => {});
      });
      await page.waitForTimeout(1500);
      console.log('✅ Variante inline gewechselt');
    } else {
      console.log('✅ Beste Variante ist bereits ausgewählt — kein Umschalten nötig');
    }

    // ── Decision: Bosch-Warn-Icon der gewählten Spalte übernehmen ───────────
    const decision = beste.hatWarnung ? 'warnung' : 'ok';
    const warning_message = beste.hatWarnung
      ? `Wärmepumpenabdeckung ${beste.pct}% – Bosch markiert diese Variante mit Warnhinweis, manuelle Prüfung empfohlen`
      : null;
    console.log(`🎯 Decision: ${decision} (Abdeckung ${beste.pct}%) ${warning_message ?? ''}`);

    empfohlenes_produkt = beste.aw
      ? `Compress ${serie} ${beste.aw} + ${csModel}`
      : `Compress ${serie} ${finalesAW} + ${csModel}`;
    // ── PDF Download ─────────────────────────────────────────────────────────
    // Bosch erzeugt das PDF serverseitig: "PDF Download" öffnet nur das Export-
    // Modal, der Bestätigen-Button darin (id="exportRecommendation") schickt
    // POST .../api/vpw/recommendation/pdf/export an heatpump-api.thernovo.com
    // und klickt anschließend einen Blob-<a download>. Schlägt dieser Request
    // fehl oder hängt er, verschluckt die Bosch-App den Fehler komplett (kein
    // catch) — sichtbar war bisher nur der nackte "waiting for event download".
    // Deshalb: Antwort des Endpunkts mitschneiden (echte Ursache im Log),
    // den Request notfalls selbst wiederholen und insgesamt mehrfach versuchen.
    console.log('📥 PDF Download...');
    const path = require('path');
    const fs   = require('fs');

    let exportAntwort = null;  // letzte Antwort des Bosch-PDF-Endpunkts
    let exportRequest = null;  // URL + Payload, um den Request notfalls selbst zu wiederholen
    page.on('request', (r) => {
      if (r.method() === 'POST' && /recommendation\/pdf\/export/i.test(r.url())) {
        exportRequest = { url: r.url(), data: r.postData() };
      }
    });
    page.on('response', async (r) => {
      if (!/recommendation\/pdf\/export/i.test(r.url())) return;
      exportAntwort = { status: r.status(), body: null };
      console.log(`📡 Bosch-PDF-Endpunkt: HTTP ${r.status()}`);
      if (!r.ok()) exportAntwort.body = await r.text().catch(() => null);
    });

    // Fallback: Der Browser-Body ist über Playwright nicht auslesbar, also
    // schicken wir denselben POST bei Bedarf direkt aus Node noch einmal.
    // Greift, wenn Bosch das PDF zwar liefert, der Blob-Klick aber verpufft.
    async function pdfDirektHolen() {
      if (!exportRequest?.data) return null;
      const antwort = await context.request.post(exportRequest.url, {
        data: exportRequest.data,
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }).catch(() => null);
      if (!antwort || !antwort.ok()) return null;
      const bytes = await antwort.body().catch(() => null);
      return bytes && bytes.length > 0 ? bytes : null;
    }

    // Ein Versuch = Modal sicherstellen, bestätigen, auf Download ODER
    // PDF-Response warten. Der Download landet je nach Bosch-Variante auf der
    // Seite selbst oder in einem Popup — beides abdecken.
    async function pdfVersuch(force) {
      const bestaetigen = page.locator('#exportRecommendation');
      if (!(await bestaetigen.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'PDF Download' }).first().click({ force });
        await bestaetigen.waitFor({ state: 'visible', timeout: 20000 });
      }
      exportAntwort = null;
      exportRequest = null;
      const wartetAufDownload = Promise.race([
        page.waitForEvent('download', { timeout: 75000 }),
        context.waitForEvent('page', { timeout: 75000 })
          .then(p => p.waitForEvent('download', { timeout: 75000 })),
      ]);
      await bestaetigen.click({ force });
      return wartetAufDownload;
    }

    let pdfBuffer = null;
    for (let v = 1; v <= 3; v++) {
      try {
        const download = await pdfVersuch(v > 1);
        console.log(`📄 PDF heruntergeladen: ${download.suggestedFilename()}`);
        const tmpPath = path.join('/tmp', `bosch-hpa-${record_id}.pdf`);
        await download.saveAs(tmpPath);
        pdfBuffer = fs.readFileSync(tmpPath);
        fs.unlinkSync(tmpPath);
        break;
      } catch (e) {
        // Kein Download-Event — aber vielleicht liefert der Endpunkt das PDF
        // trotzdem. Dann holen wir es direkt, statt den Lauf wegzuwerfen.
        const direkt = await pdfDirektHolen();
        if (direkt) {
          console.log(`📄 PDF direkt vom Bosch-Endpunkt geholt (${direkt.length} Bytes)`);
          pdfBuffer = direkt;
          break;
        }
        const ursache = exportAntwort
          ? `Bosch-PDF-Dienst antwortete HTTP ${exportAntwort.status}` +
            (exportAntwort.body ? ` – ${exportAntwort.body.slice(0, 150)}` : '')
          : 'Bosch-PDF-Dienst hat nicht geantwortet (kein Download ausgelöst)';
        console.warn(`⚠️ PDF-Versuch ${v}/3: ${ursache}`);
        if (v === 3) throw new Error(`PDF-Download fehlgeschlagen: ${ursache}`);
        await page.waitForTimeout(5000 * v);
      }
    }
    // ── Supabase Storage Upload ───────────────────────────────────────────────
    const timestamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const storagePath = `hpa/${lead_id}/bosch-advisor-${timestamp}.pdf`;
    console.log(`☁️  Upload: lead-documents/${storagePath}`);
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('lead-documents')
      .upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });
    if (uploadError) {
      console.error('⚠️  Storage Upload Fehler:', uploadError.message);
    } else {
      console.log('☁️  Upload OK:', uploadData.path);
    }
    const { data: urlData } = await supabase.storage
      .from('lead-documents')
      .createSignedUrl(storagePath, 60 * 60 * 24 * 365);
    const pdf_url = urlData?.signedUrl ?? null;
    console.log('🔗 PDF URL:', pdf_url ? 'OK' : 'nicht verfügbar');
    const matched_product_id_innen = await findProductId(dbModel);
    let matched_product_id_aussen = null;
    if (finalesAW) {
      const { data: aussen } = await supabase
        .from('products').select('id, name')
        .ilike('name', `%${serie} ${finalesAW}%`)
        .limit(1).single();
      if (aussen) {
        matched_product_id_aussen = aussen.id;
        console.log(`✅ Außeneinheit: ${aussen.name}`);
      } else {
        console.warn(`⚠️ Außeneinheit nicht gefunden: ${serie} ${finalesAW}`);
      }
    }
    await dbUpdate(record_id, {
      status: 'completed',
      empfohlenes_produkt,
      matched_product_id_innen,
      matched_product_id_aussen,
      spitzenleistung_klein_pct,
      spitzenleistung_gross_pct,
      decision,
      warning_message,
      pdf_url,
    });
    console.log('🗄️  Supabase: completed ✅');
    await browser.close();
    console.log(`🏁 Fertig! ${empfohlenes_produkt} → ${decision} (${beste.pct}%)`);
  } catch (error) {
    console.error('💥 FEHLER:', error.message);
    if (browser) await browser.close();
    if (record_id) await dbUpdate(record_id, { status: 'error', error_message: error.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Bosch HPA Bot läuft auf Port ${PORT}`));
