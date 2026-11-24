import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ensureDirs, loadConfig } from './config.js';

/**
 * Bilgisayardaki gerçek Chrome / Edge yürütülebilir dosyasını bulur.
 * Varsayılan olarak headless (--headless=new) başlatılır;
 * auth login veya --headed/--visible verildiğinde görünür pencere açılır.
 */
export function findBrowserExecutable(preferredPath = null) {
  if (preferredPath && fs.existsSync(preferredPath)) {
    return preferredPath;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge'
    );
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

export async function isCdpAlive(port = 9222) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function launchManagedChrome({ url = null, port = null, headless = null } = {}) {
  const cfg = loadConfig();
  const paths = ensureDirs();
  const cdpPort = port || cfg.cdpPort || 9222;
  const runHeadless = headless !== null ? Boolean(headless) : Boolean(cfg.headless);

  const existing = await isCdpAlive(cdpPort);
  if (existing) {
    const existingIsHeadless = /HeadlessChrome/i.test(existing['User-Agent'] || '');
    // Eğer kullanıcı --headed (görünür) istedi ama mevcut Chrome headless ise yeniden başlat
    if (!runHeadless && existingIsHeadless) {
      await closeExistingCdpBrowser(cdpPort);
    } else {
      return {
        alreadyRunning: true,
        port: cdpPort,
        version: existing,
        headless: existingIsHeadless
      };
    }
  }

  const exe = findBrowserExecutable(cfg.chromePath);
  if (!exe) {
    throw new Error(
      'Google Chrome veya Edge bulunamadı. `gflow config set chromePath "C:\\...\\chrome.exe"` ile yol tanımlayın.'
    );
  }

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${paths.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1440,960'
  ];

  if (runHeadless) {
    args.push('--headless=new');
  } else {
    args.push('--new-window', '--window-position=80,50');
  }

  if (url) args.push(url);

  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: runHeadless
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const info = await isCdpAlive(cdpPort);
    if (info) {
      return {
        alreadyRunning: false,
        port: cdpPort,
        version: info,
        pid: child.pid,
        exe,
        headless: runHeadless
      };
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  throw new Error(
    `Chrome başlatıldı ancak CDP portu (${cdpPort}) 15 saniye içinde yanıt vermedi.`
  );
}

export async function connectToFlowPage({ autoLaunch = true, targetUrl = null, headless = null } = {}) {
  const cfg = loadConfig();
  const cdpPort = cfg.cdpPort || 9222;
  const flowUrl = targetUrl || cfg.flowUrl;
  const wantVisible = headless === false || (headless === null && cfg.headless === false);

  let alive = await isCdpAlive(cdpPort);
  const aliveIsHeadless = Boolean(alive && /HeadlessChrome/i.test(alive['User-Agent'] || ''));

  if (!alive) {
    if (!autoLaunch) {
      throw new Error(
        `Chrome CDP (${cdpPort}) çalışmıyor. Önce \`gflow auth login\` komutunu çalıştırın.`
      );
    }
    await launchManagedChrome({ url: flowUrl, port: cdpPort, headless });
  } else if (wantVisible && aliveIsHeadless) {
    // Mevcut Chrome headless çalışıyorsa kapatıp görünür pencerede yeniden başlat
    await launchManagedChrome({ url: flowUrl, port: cdpPort, headless: false });
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0] || (await browser.newContext());

  let page = context
    .pages()
    .find((p) => /labs\.google\/fx\/tools\/flow|flow\.google/i.test(p.url()));

  if (!page) {
    page = context.pages()[0] || (await context.newPage());
    await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  if (wantVisible) {
    await bringPageToFront(context, page).catch(() => {});
  }

  return {
    browser,
    context,
    page,
    async disconnect() {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  };
}

async function bringPageToFront(context, page) {
  await page.bringToFront().catch(() => {});
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    if (windowId) {
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' }
      }).catch(() => {});
    }
    await cdp.detach().catch(() => {});
  } catch {
    // ignore
  }
}

async function closeExistingCdpBrowser(port) {
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(() => {});
    await browser.close().catch(() => {});
  } catch {
    // ignore
  }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (!(await isCdpAlive(port))) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Windows'ta headless Chrome CDP üzerinden kapanmadıysa sadece ilgili portun sürecini kapat
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*remote-debugging-port=${port}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
        ],
        { stdio: 'ignore', timeout: 5000 }
      );
      await new Promise((r) => setTimeout(r, 600));
    } catch {
      // ignore
    }
  }
}
