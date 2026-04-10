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
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await dbUpdate(record_id, { status: 'running' });
    // ── SCHRITT 1: Seite laden ───────────────────────────────────────────────
    await page.goto('https://bosch-de-heatpump.thernovo.com/home', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    // Cookie Banner — klicken + aus DOM entfernen damit es nichts blockiert
    try {
      await page.getByRole('button', { name: 'Alles akzeptieren' }).click({ timeout: 5000, force: true });
      await page.waitForTimeout(500);
    } catch (e) {}
    // dock-privacy-settings komplett aus DOM entfernen (blockiert sonst alle Klicks)
    await page.evaluate(() => {
      const el = document.querySelector('dock-privacy-settings');
      if (el) el.remove();
    });
    await page.waitForTimeout(500);
    // Formular aktivieren + PLZ
    await page.getByText('Straße Hausnummer').click({ force: true });
    await page.waitForTimeout(300);
    await page.locator('.col-md-12').click({ force: true });
    await page.waitForTimeout(300);
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
    // ── SCHRITT 5: Wärmebedarf → kWh/a + ggf. inkl. Warmwasser + Wert ───────
    console.log('⚡ [5] Wärmebedarf: ' + energieverbrauch + ' kWh/a | Trinkwasser: ' + trinkwasser);
    await page.waitForSelector('text=Wie hoch ist der Wärmebedarf', { timeout: 20000 });
    await page.getByRole('tab', { name: 'in kWh/a (Verbrauch/Jahr) ' }).click();
    await page.waitForTimeout(400);
    if (!trinkwasser.startsWith('Nein')) {
      await page.getByLabel('in kWh/a (Verbrauch/Jahr)').getByText('Heizlast ist inkl. Warmwasser').click();
      await page.waitForTimeout(300);
    }
    await page.getByRole('textbox', { name: 'Energiebedarf' }).click({ clickCount: 3 });
    await page.getByRole('textbox', { name: 'Energiebedarf' }).type(String(energieverbrauch), { delay: 50 });
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 6: Verteilsystem → Auswahl aus CRM ──────────────────────────
    console.log('🔥 [6] Verteilsystem: ' + raumheizung);
    await page.waitForSelector('text=Welches Verteilsystem', { timeout: 20000 });
    await page.getByText(raumheizung, { exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 7: Warmwasser Personen → aus CRM oder Default 4 ─────────────
    console.log('👥 [7] Warmwasser Personen: ' + haushaltsgroesse);
    await page.waitForSelector('text=Wie viele Personen', { timeout: 20000 });
    if (haushaltsgroesse !== 4) {
      const input = page.locator('input[type="number"], input[name*="person"], input[name*="Person"]').first();
      await input.click({ clickCount: 3 });
      await input.type(String(haushaltsgroesse), { delay: 50 });
      await page.waitForTimeout(300);
    }
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 8: Warmwassersystem → Default Speichersystem → Weiter ───────
    console.log('💧 [8] Warmwassersystem...');
    await page.waitForSelector('text=Welches Warmwassersystem', { timeout: 20000 });
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 9: Warmwassermenge → Default → Weiter ───────────────────────
    console.log('🚿 [9] Warmwassermenge...');
    await page.waitForSelector('text=Warmwassermenge', { timeout: 20000 });
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 10: Technologie Art → Default Luft/Wasser Monoblock → Weiter─
    console.log('🌬️  [10] Technologie Art...');
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 10b: Kompressor-Technologie (nur bei >= 30.300 kWh) ──────────
    if (energieverbrauch >= 39150) {
      console.log('⚡ [10b] Kompressor-Technologie: Inverter (kWh >= 30.300)');
      await page.waitForSelector('text=Inverter', { timeout: 10000 });
      await page.getByText('Inverter', { exact: true }).click();
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: 'Weiter' }).click();
      await page.waitForTimeout(700);
    }
    // ── SCHRITT 11: Technologie Aufstellung → Default Außenaufstellung ───────
    console.log('🏠 [11] Technologie Aufstellung...');
    await page.waitForSelector('text=Welche Technologie', { timeout: 20000 });
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(700);
    // ── SCHRITT 12: Distanz Schall → Default 5m → Weiter ────────────────────
    console.log('📏 [12] Distanz Schall...');
    await page.waitForSelector('text=Abstand', { timeout: 20000 });
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(2000);
    // ── SCHRITT 13: Produktauswahl ───────────────────────────────────────────
    const serie         = raumheizung.includes('Heizkörper') ? '6800i' : '5800i';
    const spezVerbrauch = energieverbrauch / wohnflaeche;
    const platzmangel   = (deckenhoehe_hwr < 235) || (spezVerbrauch > 150);
    let suffix;
    if (platzmangel)                             suffix = 'E';
    else if (raumheizung.includes('Heizkörper')) suffix = 'MB';
    else                                         suffix = 'M';
    const csModel = suffix === 'E'
      ? `CS${serie}AW 12 E`
      : `CS${serie} AW 12 ${suffix}`;
    const dbModel = `CS${serie}AW 12 ${suffix}`;
    let empfohlenes_produkt = `Compress ${serie} AW + ${csModel}`;
    console.log(`🧠 [13] Produkt: ${empfohlenes_produkt}`);
    await page.waitForSelector(`text=${csModel}`, { timeout: 35000 });
    await page.waitForTimeout(500);
    const karte = page.locator('a, div, label').filter({ hasText: csModel }).first();
    const kartenText = await karte.textContent().catch(() => '');
    const awMatch = kartenText.match(/AW\s+(\d+)\s+(OR-[ST])/);
    const aussenBezeichnung = awMatch ? `${serie} AW ${awMatch[1]} ${awMatch[2]}` : null;
    console.log(`🔍 Außeneinheit erkannt: ${aussenBezeichnung ?? 'nicht gefunden'}`);
    await page.getByText(csModel).first().click();
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
      console.log(`🔄 Wechsle zu: ${beste.aw}`);
      const produktAendernBtns = page.getByRole('button', { name: 'Produkt ändern' });
      if (beste.index < ausgewaehltIndex) {
        await produktAendernBtns.first().click();
      } else {
        await produktAendernBtns.last().click();
      }
      await page.waitForTimeout(1000);
      console.log('⏳ Warte auf Produktauswahlseite...');
      await page.waitForSelector(`text=${csModel}`, { timeout: 35000 });
      await page.waitForTimeout(500);
      console.log(`🔍 Klicke Karte: ${beste.aw} + ${csModel}`);
      await page.getByText(`Compress ${serie} AW${beste.aw} + ${csModel}`).first().click();
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: 'Weiter' }).click();
      await page.waitForTimeout(2000);
      await page.waitForTimeout(2000);
      console.log('📊 Warte auf neue Ergebnisseite...');
      await page.waitForSelector('button:has-text("PDF Download")', { timeout: 20000 });
      console.log('✅ Neue Ergebnisseite geladen!');
    }
    const decision = beste.pct >= 80 && beste.pct <= 110 ? 'ok' : beste.pct > 110 ? 'ueberdimensioniert' : 'warnung';
    const warning_message = beste.pct > 110
      ? `Spitzenleistung ${beste.pct}% – Überdimensionierung prüfen`
      : beste.pct < 80
      ? `Spitzenleistung ${beste.pct}% – unter 80%, manuelle Prüfung empfohlen`
      : null;
    console.log(`🎯 Decision: ${decision} (${beste.pct}%) ${warning_message ?? ''}`);
    const ausgewaehlteSpalte = tabellenDaten.spaltenKoepfe.find((_, i) => i === ausgewaehltIndex)
      ?? tabellenDaten.spaltenKoepfe[0];
    empfohlenes_produkt = ausgewaehlteSpalte
      ? `Compress ${serie} ${ausgewaehlteSpalte}`
      : `Compress ${serie} ${finalesAW} + ${csModel}`;
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
    const tmpPath = path.join('/tmp', `bosch-hpa-${record_id}.pdf`);
    await download.saveAs(tmpPath);
    const pdfBuffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
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
      // FIX: serie in die Suche einbeziehen damit 5800i und 6800i nicht verwechselt werden
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
