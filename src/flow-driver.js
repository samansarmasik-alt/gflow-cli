import fs from 'node:fs';
import path from 'node:path';
import { connectToFlowPage, launchManagedChrome } from './browser.js';
import { ensureDirs, loadConfig } from './config.js';
import { createHumanizer } from './humanizer.js';
import { resolveModel } from './models.js';

// Geçerli minimal 1x1 PNG (mock/test modu için)
const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Minimal geçerli ftyp MP4 header (mock/test modu için)
const MINIMAL_MP4_BYTES = Buffer.from(
  '00000018667479706d703432000000006d70343269736f6d',
  'hex'
);

export function isMockMode(opts = {}) {
  return Boolean(opts.mock || process.env.GFLOW_MOCK === '1' || process.env.GFLOW_MOCK === 'true');
}

function loadCustomSelectors() {
  const { selectorsFile } = ensureDirs();
  if (!fs.existsSync(selectorsFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(selectorsFile, 'utf8'));
  } catch {
    return {};
  }
}

export async function loginFlow({ timeoutMs = 180_000 } = {}) {
  const cfg = loadConfig();
  if (isMockMode()) {
    return {
      authenticated: true,
      email: 'mock-user@example.com',
      credits: 1000,
      url: cfg.flowUrl,
      mock: true
    };
  }

  // Login her zaman görünür pencerede açılır (headless: false)
  await launchManagedChrome({ url: cfg.flowUrl, port: cfg.cdpPort, headless: false });
  const conn = await connectToFlowPage({ autoLaunch: false, targetUrl: cfg.flowUrl });

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await dismissModals(conn.page);
      const status = await inspectSessionOnPage(conn.page);
      if (status.authenticated) {
        return status;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return await inspectSessionOnPage(conn.page);
  } finally {
    await conn.disconnect();
  }
}

export async function getSessionStatus({ mock = false, headless = null } = {}) {
  const cfg = loadConfig();
  if (isMockMode({ mock })) {
    return {
      authenticated: true,
      email: 'mock-user@example.com',
      credits: 1000,
      url: cfg.flowUrl,
      inWorkspace: true,
      mock: true
    };
  }

  const conn = await connectToFlowPage({ autoLaunch: false, targetUrl: cfg.flowUrl, headless });
  try {
    if (cfg.autoDismissModals) await dismissModals(conn.page);
    return await inspectSessionOnPage(conn.page);
  } finally {
    await conn.disconnect();
  }
}

/**
 * Google Flow'da zaman zaman açılan "Yenilikler / What's New / Güncelleme / Duyuru"
 * dialog ve overlay ekranlarını otomatik algılayıp kapatır.
 */
export async function dismissModals(page) {
  let dismissed = 0;
  for (let round = 0; round < 3; round++) {
    const clicked = await page
      .evaluate(() => {
        const dialogs = [
          ...document.querySelectorAll(
            '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .mdc-dialog--open'
          )
        ].filter((d) => {
          const rect = d.getBoundingClientRect();
          return rect.width > 120 && rect.height > 80;
        });

        if (dialogs.length === 0) return false;

        const dismissPattern =
          /^(kapat|anladım|tamam|geç|atla|devam|devam et|şimdi değil|bitti|close|got it|dismiss|skip|continue|not now|done|ok|okay|no thanks|hayır,?\s*teşekkürler)$/i;

        for (const dlg of dialogs) {
          // Ayarlar / model seçici popover'ını yanlışlıkla kapatma
          const txt = (dlg.innerText || '').toLowerCase();
          if (txt.includes('nano banana') && txt.includes('16:9')) continue;

          const btns = [...dlg.querySelectorAll('button, [role="button"]')];
          for (const b of btns) {
            const label = (b.innerText || b.getAttribute('aria-label') || '').trim();
            if (dismissPattern.test(label) || /^close$/i.test(b.innerText?.trim() || '')) {
              b.click();
              return true;
            }
          }
        }
        return false;
      })
      .catch(() => false);

    if (!clicked) break;
    dismissed++;
    await new Promise((r) => setTimeout(r, 350));
  }
  return dismissed;
}

/**
 * Flow Ajanı (Agent Mode) durumunu ayarlar.
 * Varsayılan: enabled = false (Ajan modu KAPALI, doğrudan üretim).
 * --agent-mode verilirse enabled = true (Ajan modu AÇIK).
 */
export async function setAgentMode(page, enabled = false, human = null) {
  const click = async (loc) => (human ? human.clickLocator(page, loc) : loc.click());

  // 1) Ajan modu kapalı isteniyorsa ve sağda ajan paneli açıksa kapat
  if (!enabled) {
    const closeRight = page.locator('button:has-text("right_panel_close")').first();
    if (await closeRight.isVisible().catch(() => false)) {
      await click(closeRight).catch(() => {});
      if (human) await human.pause(240, 480);
      else await new Promise((r) => setTimeout(r, 450));
    }
  }

  // 2) Alt çubuktaki "Flow ajanı" / "Flow agent" toggle butonunu bul
  const agentBtn = page
    .locator(
      'button[aria-label*="Flow ajanı" i], button[aria-label*="Flow agent" i], button[aria-pressed]:has-text("spark")'
    )
    .first();

  if (await agentBtn.isVisible().catch(() => false)) {
    const pressed = (await agentBtn.getAttribute('aria-pressed')) === 'true';
    if (pressed !== Boolean(enabled)) {
      await click(agentBtn).catch(() => {});
      if (human) await human.pause(260, 520);
      else await new Promise((r) => setTimeout(r, 500));
    }
    return {
      found: true,
      agentMode: (await agentBtn.getAttribute('aria-pressed')) === 'true'
    };
  }

  return { found: false, agentMode: Boolean(enabled) };
}

async function inspectSessionOnPage(page) {
  const url = page.url();
  const isGoogleAuthPage = /accounts\.google\.com/i.test(url);
  if (isGoogleAuthPage) {
    return { authenticated: false, email: null, credits: null, url, inWorkspace: false };
  }

  const info = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';

    const signInButtons = [...document.querySelectorAll('a, button')].filter((el) =>
      /^(sign in|giriş yap|oturum aç|get started|create with flow)$/i.test(
        (el.innerText || el.getAttribute('aria-label') || '').trim()
      )
    );

    let email = null;
    const accountEls = document.querySelectorAll('[aria-label*="@"], [title*="@"], img[alt*="@"]');
    for (const el of accountEls) {
      const raw =
        el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
      const m = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (m) {
        email = m[0];
        break;
      }
    }

    let credits = null;
    const creditMatch =
      bodyText.match(/([\d,]+)\s*(?:AI\s*)?credits?/i) ||
      bodyText.match(/(?:credits?|kredi)\s*[:\-]?\s*([\d,]+)/i);
    if (creditMatch) {
      const parsed = Number(creditMatch[1].replace(/,/g, ''));
      if (Number.isFinite(parsed)) credits = parsed;
    }

    const hasPromptBox = Boolean(
      document.querySelector('[role="textbox"], textarea, [contenteditable="true"]')
    );

    const hasNewProject = [...document.querySelectorAll('button, a')].some((el) =>
      /new project|yeni proje|create/i.test((el.innerText || '').trim())
    );

    return {
      email,
      credits,
      hasPromptBox,
      hasNewProject,
      hasSignInButton: signInButtons.length > 0 && !email && !hasPromptBox && !hasNewProject
    };
  });

  const authenticated =
    !isGoogleAuthPage &&
    !info.hasSignInButton &&
    (Boolean(info.email) || info.hasPromptBox || info.hasNewProject || info.credits !== null);

  return {
    authenticated,
    email: info.email,
    credits: info.credits,
    url,
    inWorkspace: info.hasPromptBox
  };
}

async function waitForSessionSettled(page, maxWaitMs = 12_000, autoDismiss = true) {
  const start = Date.now();
  let last = await inspectSessionOnPage(page);
  while (Date.now() - start < maxWaitMs) {
    if (autoDismiss) await dismissModals(page);
    last = await inspectSessionOnPage(page);
    if (last.authenticated) return last;
    if (/accounts\.google\.com/i.test(last.url)) return last;
    await new Promise((r) => setTimeout(r, 600));
  }
  return last;
}

export async function calibrateFlowUi({ headless = null } = {}) {
  const conn = await connectToFlowPage({ autoLaunch: true, headless });
  try {
    await pageWaitIdle(conn.page);
    await dismissModals(conn.page);
    const snapshot = await conn.page.evaluate(() => {
      const pick = (selector) =>
        [...document.querySelectorAll(selector)]
          .slice(0, 60)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            placeholder: el.getAttribute('placeholder'),
            text: (el.innerText || '').trim().slice(0, 80),
            id: el.id || null,
            dataTestId: el.getAttribute('data-testid') || null
          }))
          .filter((x) => x.text || x.ariaLabel || x.placeholder || x.dataTestId);

      return {
        url: location.href,
        title: document.title,
        textboxes: pick('textarea, input[type="text"], [role="textbox"], [contenteditable="true"]'),
        buttons: pick('button, [role="button"]'),
        comboboxes: pick('select, [role="combobox"], [role="listbox"], [aria-haspopup]')
      };
    });

    const { selectorsFile } = ensureDirs();
    const calibration = {
      calibratedAt: new Date().toISOString(),
      ...snapshot
    };
    fs.writeFileSync(selectorsFile, JSON.stringify(calibration, null, 2) + '\n', 'utf8');
    return { selectorsFile, ...calibration };
  } finally {
    await conn.disconnect();
  }
}

export async function scrapeLiveModels({ headless = null } = {}) {
  const conn = await connectToFlowPage({ autoLaunch: false, headless });
  try {
    await ensureWorkspaceOpen(conn.page);
    const detected = await conn.page.evaluate(() => {
      const text = document.body?.innerText || '';
      const knownPatterns = [
        /Nano Banana(?:\s+Pro|\s+2(?:\.\d)?)?/gi,
        /Imagen\s*\d(?:\.\d)?/gi,
        /Veo\s*\d(?:\.\d)?(?:\s*[-–]?\s*(?:Lite|Fast|Quality))?/gi,
        /Omni\s*Flash(?:\s*\d(?:\.\d)?)?/gi
      ];
      const found = new Set();
      for (const re of knownPatterns) {
        const matches = text.match(re) || [];
        for (const m of matches) found.add(m.trim());
      }
      return [...found];
    });
    const session = await inspectSessionOnPage(conn.page);
    return { models: detected, credits: session.credits, url: session.url };
  } finally {
    await conn.disconnect();
  }
}

export async function runGeneration(spec) {
  const {
    type,
    prompt,
    negativePrompt,
    modelId,
    aspectRatio,
    quality,
    count = 1,
    duration = 5,
    audio = true,
    agentMode = false,
    headless = null,
    humanize = true,
    humanSeed = null,
    refFiles = [],
    firstFrameFile = null,
    lastFrameFile = null,
    outputDir,
    assetIds = [],
    mock = false,
    onProgress = () => {}
  } = spec;

  fs.mkdirSync(outputDir, { recursive: true });

  const human = createHumanizer({ seed: humanSeed, enabled: Boolean(humanize) });

  if (isMockMode({ mock })) {
    const mockRes = runMockGeneration({
      type,
      modelId,
      aspectRatio,
      count,
      outputDir,
      assetIds,
      estimatedCredits: spec.estimatedCredits ?? 0
    });
    return { ...mockRes, humanize: human.enabled, humanSeed: human.seed };
  }

  const cfg = loadConfig();
  const model = resolveModel(modelId, type);
  const customSelectors = loadCustomSelectors();
  const conn = await connectToFlowPage({ autoLaunch: true, targetUrl: cfg.flowUrl, headless });

  try {
    const session = await waitForSessionSettled(conn.page, 12_000, cfg.autoDismissModals);
    if (!session.authenticated) {
      const err = new Error(
        'Google hesabıyla oturum açılmamış. Önce `gflow auth login` çalıştırın.'
      );
      err.code = 'AUTH_REQUIRED';
      throw err;
    }

    onProgress(
      `Workspace hazırlanıyor...${human.enabled ? ` (humanizer seed: ${human.seed})` : ''}`
    );
    await ensureWorkspaceOpen(conn.page, human);
    if (cfg.autoDismissModals) await dismissModals(conn.page);
    await human.idleWander(conn.page);

    // Agent Mode varsayılan KAPALI; sadece --agent-mode ile açılır
    onProgress(`Ajan modu ${agentMode ? 'açılıyor' : 'kapatılıyor'}...`);
    await setAgentMode(conn.page, Boolean(agentMode), human);

    onProgress(`Ayarlar uygulanıyor (${type} / ${model?.displayName || modelId} / ${aspectRatio} / x${count})...`);
    await applySettingsOnPage(
      conn.page,
      {
        type,
        model,
        aspectRatio,
        quality,
        count,
        duration,
        audio
      },
      human
    );

    const uploads = [firstFrameFile, lastFrameFile, ...refFiles].filter(Boolean);
    if (uploads.length > 0) {
      onProgress(`${uploads.length} referans/kare dosyası yükleniyor...`);
      await uploadReferenceFiles(conn.page, uploads, human);
    }

    const fullPrompt = negativePrompt
      ? `${prompt}\n\nAvoid: ${negativePrompt}`
      : prompt;
    await fillPromptBox(conn.page, fullPrompt, customSelectors, human);

    const liveCost = await readLiveCreditCost(conn.page);
    if (liveCost !== null && liveCost > 0 && !spec.confirmCredits) {
      const err = new Error(
        `Google Flow bu işlem için canlı olarak ${liveCost} kredi istiyor. Onaylamak için --confirm-credits ile tekrar çalıştırın.`
      );
      err.code = 'CONFIRMATION_REQUIRED';
      err.liveCredits = liveCost;
      throw err;
    }

    // Üretim öncesi mevcut medya URL'lerini (tüm boyut varyantlarıyla) snapshot al
    await new Promise((r) => setTimeout(r, uploads.length > 0 ? 5500 : 800));
    const existingMedia = await collectMediaUrls(conn.page, type, { includeAll: true });
    const capturedBuffers = [];
    let clickedAt = 0;
    const minGenElapsedMs = uploads.length > 0 ? 7500 : 3500;

    const responseHandler = async (res) => {
      try {
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        const isTargetMedia =
          (type === 'image' && /^image\/(png|jpeg|jpg|webp)/.test(ct)) ||
          (type === 'video' && /^video\/(mp4|webm)/.test(ct));
        if (!isTargetMedia) return;
        const url = res.url();
        const key = normalizeMediaKey(url);
        if (existingMedia.has(key)) return;
        if (isUiAssetUrl(url)) return;
        // Tıklamadan önceki veya ilk saniyelerdeki lazy-load/referans görsellerini yoksay
        if (!clickedAt || Date.now() - clickedAt < minGenElapsedMs) {
          existingMedia.add(key);
          return;
        }
        const cl = Number(res.headers()['content-length'] || 0);
        if (cl > 0 && cl < 40_000) return;
        const body = await res.body();
        if (body.length >= 40_000) {
          capturedBuffers.push({ url, key, contentType: ct, buffer: body });
        }
      } catch {
        // ignore
      }
    };

    conn.page.on('response', responseHandler);

    onProgress('Üretim başlatılıyor...');
    clickedAt = Date.now();
    await clickGenerateButton(conn.page, customSelectors, human);

    const timeoutMs = type === 'video' ? cfg.videoTimeoutMs : cfg.generationTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const downloaded = [];
    const seenKeys = new Set(existingMedia);

    onProgress(`Çıktılar bekleniyor (hedef: ${count} adet)...`);
    while (Date.now() < deadline && downloaded.length < count) {
      while (capturedBuffers.length > 0 && downloaded.length < count) {
        const item = capturedBuffers.shift();
        if (seenKeys.has(item.key)) continue;
        seenKeys.add(item.key);
        const idx = downloaded.length;
        const ext = guessExtension(item.contentType, type);
        const assetId = assetIds[idx] || `${type === 'video' ? 'vid' : 'img'}_${Date.now()}_${idx}`;
        const safeAspect = aspectRatio.replace(':', 'x');
        const fileName = `${assetId}_${safeAspect}_${modelId}.${ext}`;
        const filePath = path.join(outputDir, fileName);
        fs.writeFileSync(filePath, item.buffer);
        downloaded.push({
          assetId,
          filePath,
          mimeType: item.contentType,
          sourceUrl: item.url
        });
      }

      if (downloaded.length >= count) break;

      // İlk saniyeler dolduktan sonra DOM'a düşen yeni img/video elementlerini kontrol et
      if (Date.now() - clickedAt >= minGenElapsedMs) {
        const currentMedia = await collectMediaUrls(conn.page, type, { includeAll: false, returnRaw: true });
        for (const url of currentMedia) {
          const key = normalizeMediaKey(url);
          if (seenKeys.has(key)) continue;
          const data = await fetchMediaViaPage(conn.page, url);
          if (data && data.buffer.length >= 35_000) {
            seenKeys.add(key);
            const idx = downloaded.length;
            const ext = guessExtension(data.contentType, type);
            const assetId = assetIds[idx] || `${type === 'video' ? 'vid' : 'img'}_${Date.now()}_${idx}`;
            const safeAspect = aspectRatio.replace(':', 'x');
            const fileName = `${assetId}_${safeAspect}_${modelId}.${ext}`;
            const filePath = path.join(outputDir, fileName);
            fs.writeFileSync(filePath, data.buffer);
            downloaded.push({
              assetId,
              filePath,
              mimeType: data.contentType,
              sourceUrl: url
            });
            if (downloaded.length >= count) break;
          }
        }
      }

      await new Promise((r) => setTimeout(r, 1500));
    }

    conn.page.off('response', responseHandler);

    if (downloaded.length === 0) {
      throw new Error(
        `Zaman aşımı (${Math.round(timeoutMs / 1000)}sn): Google Flow'dan çıktı yakalanamadı. ` +
          `UI değişmiş olabilir; \`gflow calibrate\` çalıştırın veya \`--headed\` ile izleyin.`
      );
    }

    const updatedSession = await inspectSessionOnPage(conn.page);
    const spent =
      liveCost !== null
        ? liveCost
        : session.credits !== null && updatedSession.credits !== null
          ? Math.max(0, session.credits - updatedSession.credits)
          : spec.estimatedCredits ?? 0;

    return {
      files: downloaded,
      creditsSpent: spent,
      remainingCredits: updatedSession.credits,
      accountEmail: updatedSession.email || session.email,
      humanize: human.enabled,
      humanSeed: human.seed
    };
  } finally {
    await conn.disconnect();
  }
}

function runMockGeneration({ type, modelId, aspectRatio, count, outputDir, assetIds, estimatedCredits }) {
  const files = [];
  const ext = type === 'video' ? 'mp4' : 'png';
  const mimeType = type === 'video' ? 'video/mp4' : 'image/png';
  const safeAspect = aspectRatio.replace(':', 'x');

  for (let i = 0; i < count; i++) {
    const assetId = assetIds[i] || `${type === 'video' ? 'vid' : 'img'}_mock_${i + 1}`;
    const fileName = `${assetId}_${safeAspect}_${modelId}.${ext}`;
    const filePath = path.join(outputDir, fileName);
    const payload =
      type === 'video'
        ? MINIMAL_MP4_BYTES
        : Buffer.from(MINIMAL_PNG_BASE64, 'base64');
    fs.writeFileSync(filePath, payload);
    files.push({
      assetId,
      filePath,
      mimeType,
      sourceUrl: `mock://flow.google/${assetId}.${ext}`
    });
  }

  return {
    files,
    creditsSpent: estimatedCredits,
    remainingCredits: Math.max(0, 1000 - estimatedCredits),
    accountEmail: 'mock-user@example.com',
    mock: true
  };
}

async function pageWaitIdle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
}

async function ensureWorkspaceOpen(page, human = null) {
  await pageWaitIdle(page);
  const hasPrompt = await page
    .locator('[role="textbox"]')
    .first()
    .isVisible()
    .catch(() => false);

  if (hasPrompt) return;

  const newProj = page
    .getByRole('button', { name: /new project|yeni proje|create project/i })
    .first();
  if (await newProj.isVisible().catch(() => false)) {
    if (human) await human.clickLocator(page, newProj);
    else await newProj.click();
    await page
      .locator('[role="textbox"]')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {});
  }
}

async function applySettingsOnPage(page, { type, model, aspectRatio, count, quality }, human = null) {
  const click = async (loc) => (human ? human.clickLocator(page, loc) : loc.click());
  const wait = async (min, max) =>
    human ? human.pause(min, max) : new Promise((r) => setTimeout(r, Math.round((min + max) / 2)));

  // "Ayarlar tetikleyicisi" / "Settings trigger" butonunu aç
  const trigger = page
    .locator(
      'button[aria-label*="Ayarlar tetikleyicisi" i], button[aria-label*="Settings trigger" i]'
    )
    .first();

  if (!(await trigger.isVisible().catch(() => false))) {
    return;
  }

  await click(trigger).catch(() => {});
  await wait(280, 520);

  // 1) Tür seçimi: Resim / Image veya Video
  const typeRx = type === 'image' ? /resim|image/i : /video/i;
  const typeRadio = page.locator('button[role="radio"]').filter({ hasText: typeRx }).first();
  if (await typeRadio.isVisible().catch(() => false)) {
    await click(typeRadio).catch(() => {});
    await wait(160, 320);
  }

  // 2) En-boy oranı (16:9, 4:3, 1:1, 3:4, 9:16)
  if (aspectRatio) {
    const ratioRadio = page
      .locator('button[role="radio"]')
      .filter({ hasText: new RegExp(`\\b${escapeRegex(aspectRatio)}\\b`) })
      .first();
    if (await ratioRadio.isVisible().catch(() => false)) {
      await click(ratioRadio).catch(() => {});
      await wait(150, 300);
    }
  }

  // 3) Kalite (Düşük / Orta / Yüksek veya Low / Medium / High)
  if (quality) {
    const qMap = {
      low: /düşük|low/i,
      standard: /orta|medium|standard/i,
      medium: /orta|medium/i,
      high: /yüksek|high/i,
      '1k': /düşük|orta|1k/i,
      '2k': /orta|yüksek|2k/i,
      '4k': /yüksek|4k/i
    };
    const qRx = qMap[quality] || new RegExp(escapeRegex(quality), 'i');
    const qRadio = page.locator('button[role="radio"]').filter({ hasText: qRx }).first();
    if (await qRadio.isVisible().catch(() => false)) {
      await click(qRadio).catch(() => {});
      await wait(150, 300);
    }
  }

  // 4) Adet (x1, x2, x3, x4)
  if (count && count >= 1 && count <= 4) {
    const countRadio = page
      .locator('button[role="radio"]')
      .filter({ hasText: new RegExp(`^x${count}$`, 'i') })
      .first();
    if (await countRadio.isVisible().catch(() => false)) {
      await click(countRadio).catch(() => {});
      await wait(150, 280);
    }
  }

  // 5) Model seçimi (gerekirse Model ailesi dropdown'ını aç)
  if (model?.uiLabels?.length) {
    const modelDropdown = page
      .locator('button[aria-label*="Model ailesi" i], button[aria-label*="Select model" i]')
      .first();
    if (await modelDropdown.isVisible().catch(() => false)) {
      const currentTxt = (await modelDropdown.innerText().catch(() => '')).toLowerCase();
      const alreadySelected = model.uiLabels.some((lbl) => currentTxt.includes(lbl.toLowerCase()));
      if (!alreadySelected) {
        await click(modelDropdown).catch(() => {});
        await wait(220, 420);
        for (const label of model.uiLabels) {
          const item = page
            .locator('[role="menuitem"], [role="option"], button')
            .filter({ hasText: new RegExp(escapeRegex(label), 'i') })
            .first();
          if (await item.isVisible().catch(() => false)) {
            await click(item).catch(() => {});
            await wait(180, 340);
            break;
          }
        }
      }
    }
  }

  // Ayar popover'ını kapat
  await page.keyboard.press('Escape').catch(() => {});
  await wait(180, 340);
}

async function uploadReferenceFiles(page, files, human = null) {
  if (!files || files.length === 0) return { uploaded: 0 };
  const click = async (loc) => (human ? human.clickLocator(page, loc) : loc.click());

  // 1) Doğrudan mevcut gizli/görünür file input varsa kullan
  const existingInput = page.locator('input[type="file"]').first();
  if ((await existingInput.count()) > 0) {
    await existingInput.setInputFiles(files);
    if (human) await human.pause(1000, 1800);
    else await new Promise((r) => setTimeout(r, 1500));
    return { uploaded: files.length, method: 'input' };
  }

  // 2) Prompt kutusundaki "+" ("İçerik öğelerini istem kutusuna ekle" / "Add") butonunu aç
  const addBtn = page
    .locator(
      'button[aria-label*="istem kutusuna ekle" i], button[aria-label*="Add content" i], button[aria-label*="Add media" i], button[aria-label*="Medya menüsü ekle" i]'
    )
    .last();

  if (await addBtn.isVisible().catch(() => false)) {
    const fcPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await click(addBtn).catch(() => {});
    if (human) await human.pause(300, 580);
    else await new Promise((r) => setTimeout(r, 450));

    // Menü açıldıysa "Yükle / Upload" seçeneğine tıkla
    const uploadItem = page
      .locator('[role="menuitem"], [role="option"], button')
      .filter({ hasText: /yükle|upload|bilgisayardan|from device|dosya/i })
      .first();

    if (await uploadItem.isVisible().catch(() => false)) {
      const fcMenuPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
      await click(uploadItem).catch(() => {});
      const fc = await fcMenuPromise;
      if (fc) {
        await fc.setFiles(files);
        if (human) await human.pause(1800, 2900);
        else await new Promise((r) => setTimeout(r, 2500));
        await closeOpenOverlays(page);
        return { uploaded: files.length, method: 'filechooser-menu' };
      }
    }

    const directFc = await fcPromise;
    if (directFc) {
      await directFc.setFiles(files);
      if (human) await human.pause(1800, 2900);
      else await new Promise((r) => setTimeout(r, 2500));
      await closeOpenOverlays(page);
      return { uploaded: files.length, method: 'filechooser-direct' };
    }

    // Menü açıldıktan sonra DOM'a file input eklendiyse onu kullan
    const lateInput = page.locator('input[type="file"]').first();
    if ((await lateInput.count()) > 0) {
      await lateInput.setInputFiles(files);
      if (human) await human.pause(1800, 2900);
      else await new Promise((r) => setTimeout(r, 2500));
      await closeOpenOverlays(page);
      return { uploaded: files.length, method: 'late-input' };
    }
  }

  throw new Error(
    'Referans görsel yükleme alanı bulunamadı. `gflow calibrate` çalıştırıp UI yapısını kontrol edin.'
  );
}

async function closeOpenOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const backdrop = page.locator('.cdk-overlay-backdrop-showing').first();
    if (!(await backdrop.isVisible().catch(() => false))) break;
    await page.keyboard.press('Escape').catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    if (await backdrop.isVisible().catch(() => false)) {
      await backdrop.click({ position: { x: 10, y: 10 }, force: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

async function fillPromptBox(page, text, customSelectors = {}, human = null) {
  const candidates = [
    customSelectors.promptSelector,
    'div[role="textbox"][aria-label*="oluşturmak" i]',
    'div[role="textbox"][aria-label*="create" i]',
    'div[role="textbox"][aria-label*="Sırada" i]',
    'div[role="textbox"]',
    '[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="prompt" i]',
    'textarea[placeholder*="describe" i]'
  ].filter(Boolean);

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      if (human) {
        await human.typeText(page, loc, text);
      } else {
        await loc.click();
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.keyboard.insertText(text);
        await new Promise((r) => setTimeout(r, 250));
      }
      return;
    }
  }
  throw new Error('Prompt giriş kutusu bulunamadı. `gflow calibrate` ile UI yapısını inceleyin.');
}

async function readLiveCreditCost(page) {
  return await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    for (const btn of buttons) {
      const txt = (btn.innerText || btn.getAttribute('aria-label') || '').trim();
      if (/oluşturmaya başla|generate|create|arrow_forward/i.test(txt)) {
        const m = txt.match(/(\d+)\s*(?:credits?|kredi)/i);
        if (m) return Number(m[1]);
      }
    }
    return null;
  });
}

async function clickGenerateButton(page, customSelectors = {}, human = null) {
  const click = async (loc) => (human ? human.clickLocator(page, loc) : loc.click());

  if (customSelectors.generateSelector) {
    const custom = page.locator(customSelectors.generateSelector).first();
    if (await custom.isVisible().catch(() => false)) {
      await click(custom);
      return;
    }
  }

  const primary = page
    .locator(
      'button[aria-label*="Oluşturmaya başla" i], button[aria-label*="Generate" i], button:has-text("arrow_forward")'
    )
    .last();

  if (await primary.isVisible().catch(() => false)) {
    await click(primary);
    return;
  }

  await page.keyboard.press('Enter');
}

function normalizeMediaKey(url) {
  if (!url) return '';
  // Google Flow /asb/...=s400-rw vs =s1600-rw aynı görselin farklı boyut varyantlarıdır
  return String(url).replace(/=[a-zA-Z0-9_-]+$/, '');
}

async function collectMediaUrls(page, type, { includeAll = false, returnRaw = false } = {}) {
  const urls = await page.evaluate(
    ({ mediaType, all }) => {
      const isIgnored = (u) =>
        !u ||
        /gstatic\.com|lh3\.google\.com|lh3\.googleusercontent\.com\/a\/|perlin\.png|favicon/i.test(u);
      const out = new Set();
      if (mediaType === 'image') {
        for (const img of document.querySelectorAll('img')) {
          const src = img.currentSrc || img.src;
          if ((all || img.naturalWidth >= 400) && !isIgnored(src)) {
            out.add(src);
          }
        }
      } else {
        for (const vid of document.querySelectorAll('video, video source')) {
          const src = vid.currentSrc || vid.src;
          if (src && !isIgnored(src)) out.add(src);
        }
      }
      return [...out];
    },
    { mediaType: type, all: includeAll }
  );
  if (returnRaw) return new Set(urls);
  return new Set(urls.map(normalizeMediaKey));
}

function isUiAssetUrl(url) {
  return (
    !url ||
    /gstatic\.com|lh3\.google\.com|lh3\.googleusercontent\.com\/a\/|perlin\.png|favicon|\/icons\/|\/assets\//i.test(
      url
    )
  );
}

async function fetchMediaViaPage(page, url) {
  try {
    const res = await page.evaluate(async (targetUrl) => {
      const r = await fetch(targetUrl);
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      const buf = await r.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      return { contentType: ct, bytes };
    }, url);
    if (!res) return null;
    return { contentType: res.contentType, buffer: Buffer.from(res.bytes) };
  } catch {
    return null;
  }
}

function guessExtension(contentType, type) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('mp4')) return 'mp4';
  return type === 'video' ? 'mp4' : 'png';
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
