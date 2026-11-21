import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  flowUrl: 'https://flow.google.com',
  fallbackUrls: ['https://labs.google/fx/tools/flow'],
  cdpPort: 9222,
  chromePath: null, // auto-detected if null
  headless: true, // varsayılan arka planda görünmez; --headed ile görünür açılır
  defaultAgentMode: false, // varsayılan KAPALI; --agent-mode ile açılır
  autoDismissModals: true, // güncelleme / yenilikler ekranlarını otomatik kapat
  autoPruneEnabled: false, // varsayılan KAPALI; açılırsa taşınmayan eski dosyaları siler
  autoPruneAfterHours: 168, // 7 gün (sadece autoPruneEnabled=true ise uygulanır)
  defaultImageModel: 'nano-banana',
  defaultVideoModel: 'veo-3.1-lite',
  defaultImageAspect: '16:9',
  defaultVideoAspect: '16:9',
  defaultImageQuality: 'standard',
  defaultVideoQuality: '720p',
  defaultImageCount: 1,
  defaultVideoDuration: 5,
  generationTimeoutMs: 180_000,
  videoTimeoutMs: 360_000,
  autoDownload: true,
  outputDir: null // defaults to <home>/outputs
};

export function getHomeDir() {
  return process.env.GFLOW_HOME
    ? path.resolve(process.env.GFLOW_HOME)
    : path.join(os.homedir(), '.gflow');
}

export function getPaths() {
  const home = getHomeDir();
  const cfg = readRawConfig(home);
  const outputRoot = cfg.outputDir
    ? path.resolve(cfg.outputDir)
    : path.join(home, 'outputs');

  return {
    home,
    configFile: path.join(home, 'config.json'),
    dbFile: path.join(home, 'catalog.sqlite'),
    profileDir: path.join(home, 'chrome-profile'),
    selectorsFile: path.join(home, 'selectors.json'),
    outputRoot,
    imagesDir: path.join(outputRoot, 'images'),
    videosDir: path.join(outputRoot, 'videos'),
    logsDir: path.join(home, 'logs')
  };
}

export function ensureDirs() {
  const p = getPaths();
  for (const dir of [p.home, p.profileDir, p.outputRoot, p.imagesDir, p.videosDir, p.logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

function readRawConfig(home) {
  const file = path.join(home, 'config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function loadConfig() {
  const p = ensureDirs();
  const saved = readRawConfig(p.home);
  return { ...DEFAULT_CONFIG, ...saved };
}

export function saveConfig(patch) {
  const p = ensureDirs();
  const current = loadConfig();
  const next = { ...current, ...patch };
  const tmp = `${p.configFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p.configFile);
  return next;
}

export function setConfigKey(key, rawValue) {
  if (!(key in DEFAULT_CONFIG)) {
    throw new Error(
      `Bilinmeyen ayar anahtarı: "${key}". Geçerli anahtarlar: ${Object.keys(DEFAULT_CONFIG).join(', ')}`
    );
  }
  let value = rawValue;
  const def = DEFAULT_CONFIG[key];
  if (typeof def === 'number') {
    value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`"${key}" sayı olmalıdır.`);
  } else if (typeof def === 'boolean') {
    value = rawValue === true || rawValue === 'true' || rawValue === '1';
  } else if (rawValue === 'null' || rawValue === '') {
    value = null;
  }
  return saveConfig({ [key]: value });
}

/**
 * "30m", "24h", "7d", "2w" gibi süre ifadelerini milisaniyeye çevirir.
 */
export function parseDurationMs(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day|w|week)?$/);
  if (!m) {
    throw new Error(`Geçersiz süre formatı: "${input}". Örnek: 30m, 24h, 7d`);
  }
  const val = Number(m[1]);
  const unit = m[2] || 'h';
  const mult = {
    s: 1000,
    sec: 1000,
    m: 60_000,
    min: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    w: 604_800_000,
    week: 604_800_000
  }[unit];
  return Math.round(val * mult);
}
