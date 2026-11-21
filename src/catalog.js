import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDirs } from './config.js';

let _db = null;
let _dbPath = null;

export function getDb() {
  const { dbFile } = ensureDirs();
  if (_db && _dbPath === dbFile) return _db;
  if (_db) {
    try {
      _db.close();
    } catch {
      // ignore
    }
  }
  _db = new DatabaseSync(dbFile);
  _dbPath = dbFile;
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA foreign_keys = ON;');
  migrate(_db);
  return _db;
}

export function closeDb() {
  if (_db) {
    try {
      _db.close();
    } catch {
      // ignore
    }
    _db = null;
    _dbPath = null;
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sequences (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      negative_prompt TEXT,
      model TEXT NOT NULL,
      aspect_ratio TEXT NOT NULL,
      quality TEXT NOT NULL,
      count INTEGER NOT NULL,
      duration INTEGER,
      audio INTEGER DEFAULT 1,
      credits_spent REAL NOT NULL DEFAULT 0,
      account_email TEXT,
      project TEXT,
      parent_id TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      negative_prompt TEXT,
      model TEXT NOT NULL,
      aspect_ratio TEXT NOT NULL,
      quality TEXT NOT NULL,
      duration INTEGER,
      seed TEXT,
      audio INTEGER DEFAULT 1,
      credits_spent REAL NOT NULL DEFAULT 0,
      account_email TEXT,
      file_path TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      mime_type TEXT,
      sha256 TEXT,
      parent_id TEXT,
      ref_ids TEXT,
      project TEXT,
      tags TEXT DEFAULT '[]',
      favorite INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      source_url TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
    CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project);
    CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_parent ON assets(parent_id);
  `);

  // Non-destructive column migrations
  const cols = new Set(db.prepare('PRAGMA table_info(assets)').all().map((c) => c.name));
  if (!cols.has('expires_at')) {
    db.exec('ALTER TABLE assets ADD COLUMN expires_at TEXT;');
  }
  if (!cols.has('original_dir')) {
    db.exec('ALTER TABLE assets ADD COLUMN original_dir TEXT;');
  }
}

export function nextId(prefix) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM sequences WHERE name = ?').get(prefix);
  const next = (row ? row.value : 0) + 1;
  db.prepare(
    'INSERT INTO sequences (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value'
  ).run(prefix, next);
  return `${prefix}_${String(next).padStart(4, '0')}`;
}

export function computeSha256(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function createJob(job) {
  const db = getDb();
  const id = job.id || nextId('job');
  const createdAt = job.createdAt || new Date().toISOString();

  db.prepare(`
    INSERT INTO jobs (
      id, type, prompt, negative_prompt, model, aspect_ratio, quality,
      count, duration, audio, credits_spent, account_email, project,
      parent_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    job.type,
    job.prompt,
    job.negativePrompt || null,
    job.model,
    job.aspectRatio,
    job.quality,
    job.count || 1,
    job.duration ?? null,
    job.audio === false ? 0 : 1,
    job.creditsSpent ?? 0,
    job.accountEmail || null,
    job.project || null,
    job.parentId || null,
    job.status || 'completed',
    createdAt
  );

  return { id, createdAt };
}

export function recordAsset(asset) {
  const db = getDb();
  const prefix = asset.type === 'video' ? 'vid' : 'img';
  const id = asset.id || nextId(prefix);
  const createdAt = asset.createdAt || new Date().toISOString();

  let fileSize = asset.fileSize ?? 0;
  let sha256 = asset.sha256 || null;
  if (asset.filePath && fs.existsSync(asset.filePath)) {
    const stat = fs.statSync(asset.filePath);
    fileSize = stat.size;
    if (!sha256) sha256 = computeSha256(asset.filePath);
  }

  const tags = normalizeTags(asset.tags);
  const refIds = Array.isArray(asset.refIds) ? asset.refIds : [];
  const originalDir = asset.filePath ? path.dirname(path.resolve(asset.filePath)) : null;

  db.prepare(`
    INSERT INTO assets (
      id, job_id, type, prompt, negative_prompt, model, aspect_ratio, quality,
      duration, seed, audio, credits_spent, account_email, file_path, file_size,
      mime_type, sha256, parent_id, ref_ids, project, tags, favorite, notes,
      source_url, expires_at, original_dir, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    asset.jobId,
    asset.type,
    asset.prompt,
    asset.negativePrompt || null,
    asset.model,
    asset.aspectRatio,
    asset.quality,
    asset.duration ?? null,
    asset.seed != null ? String(asset.seed) : null,
    asset.audio === false ? 0 : 1,
    asset.creditsSpent ?? 0,
    asset.accountEmail || null,
    asset.filePath,
    fileSize,
    asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/png'),
    sha256,
    asset.parentId || null,
    JSON.stringify(refIds),
    asset.project || null,
    JSON.stringify(tags),
    asset.favorite ? 1 : 0,
    asset.notes || null,
    asset.sourceUrl || null,
    asset.expiresAt || null,
    originalDir,
    createdAt
  );

  return getAsset(id);
}

function hydrateAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.type,
    prompt: row.prompt,
    negativePrompt: row.negative_prompt,
    model: row.model,
    aspectRatio: row.aspect_ratio,
    quality: row.quality,
    duration: row.duration,
    seed: row.seed,
    audio: Boolean(row.audio),
    creditsSpent: row.credits_spent,
    accountEmail: row.account_email,
    filePath: row.file_path,
    fileExists: row.file_path ? fs.existsSync(row.file_path) : false,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    sha256: row.sha256,
    parentId: row.parent_id,
    refIds: safeJsonParse(row.ref_ids, []),
    project: row.project,
    tags: safeJsonParse(row.tags, []),
    favorite: Boolean(row.favorite),
    notes: row.notes,
    sourceUrl: row.source_url,
    expiresAt: row.expires_at || null,
    originalDir: row.original_dir || null,
    createdAt: row.created_at
  };
}

export function getAsset(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  return hydrateAsset(row);
}

export function getAssetLineage(id) {
  const db = getDb();
  const asset = getAsset(id);
  if (!asset) return null;

  const ancestors = [];
  let cur = asset.parentId;
  const seen = new Set([id]);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const parent = getAsset(cur);
    if (!parent) break;
    ancestors.push({ id: parent.id, type: parent.type, model: parent.model, prompt: parent.prompt });
    cur = parent.parentId;
  }

  const childrenRows = db
    .prepare('SELECT id, type, model, prompt, created_at FROM assets WHERE parent_id = ? ORDER BY created_at ASC')
    .all(id);

  return {
    asset,
    ancestors,
    children: childrenRows.map((r) => ({
      id: r.id,
      type: r.type,
      model: r.model,
      prompt: r.prompt,
      createdAt: r.created_at
    }))
  };
}

export function listAssets({
  type = null,
  project = null,
  model = null,
  tag = null,
  favorite = false,
  jobId = null,
  limit = 20,
  offset = 0
} = {}) {
  const db = getDb();
  const where = [];
  const params = [];

  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (project) {
    where.push('project = ?');
    params.push(project);
  }
  if (model) {
    where.push('model = ?');
    params.push(model);
  }
  if (jobId) {
    where.push('job_id = ?');
    params.push(jobId);
  }
  if (favorite) {
    where.push('favorite = 1');
  }
  if (tag) {
    where.push('tags LIKE ?');
    params.push(`%"${String(tag).toLowerCase()}"%`);
  }

  const sql = `
    SELECT * FROM assets
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit) || 20, Number(offset) || 0);
  return db.prepare(sql).all(...params).map(hydrateAsset);
}

export function searchAssets(query, { type = null, limit = 25 } = {}) {
  const db = getDb();
  const q = `%${String(query).trim()}%`;
  const where = [
    '(id LIKE ? OR prompt LIKE ? OR negative_prompt LIKE ? OR notes LIKE ? OR tags LIKE ? OR project LIKE ? OR model LIKE ?)'
  ];
  const params = [q, q, q, q, q, q, q];

  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  params.push(Number(limit) || 25);

  const sql = `
    SELECT * FROM assets
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params).map(hydrateAsset);
}

export function updateAssetMeta(id, { addTags = [], removeTags = [], note = undefined, favorite = undefined, project = undefined } = {}) {
  const db = getDb();
  const existing = getAsset(id);
  if (!existing) return null;

  const tagSet = new Set(existing.tags);
  for (const t of normalizeTags(addTags)) tagSet.add(t);
  for (const t of normalizeTags(removeTags)) tagSet.delete(t);

  const nextNote = note !== undefined ? note : existing.notes;
  const nextFav = favorite !== undefined ? (favorite ? 1 : 0) : existing.favorite ? 1 : 0;
  const nextProject = project !== undefined ? project : existing.project;

  db.prepare(
    'UPDATE assets SET tags = ?, notes = ?, favorite = ?, project = ? WHERE id = ?'
  ).run(JSON.stringify([...tagSet]), nextNote, nextFav, nextProject, id);

  return getAsset(id);
}

export function deleteAsset(id, { deleteFile = false } = {}) {
  const db = getDb();
  const existing = getAsset(id);
  if (!existing) return null;

  let fileDeleted = false;
  if (deleteFile && existing.filePath && fs.existsSync(existing.filePath)) {
    fs.unlinkSync(existing.filePath);
    fileDeleted = true;
  }

  db.prepare('DELETE FROM assets WHERE id = ?').run(id);
  return { deleted: true, id, fileDeleted, filePath: existing.filePath };
}

export function resolveFileOrAssetId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (/^(img|vid)_\d+$/i.test(trimmed)) {
    const asset = getAsset(trimmed.toLowerCase());
    if (!asset) {
      throw new Error(`Katalogda "${trimmed}" ID'li kayıt bulunamadı.`);
    }
    if (!asset.fileExists) {
      throw new Error(`"${trimmed}" kaydının dosyası diskte yok: ${asset.filePath}`);
    }
    return { filePath: asset.filePath, assetId: asset.id, asset };
  }
  const abs = path.resolve(trimmed);
  if (!fs.existsSync(abs)) {
    throw new Error(`Referans dosya bulunamadı: ${abs}`);
  }
  return { filePath: abs, assetId: null, asset: null };
}

export function getStats() {
  const db = getDb();
  const totals = db
    .prepare(`
      SELECT
        COUNT(*) as totalAssets,
        SUM(CASE WHEN type = 'image' THEN 1 ELSE 0 END) as totalImages,
        SUM(CASE WHEN type = 'video' THEN 1 ELSE 0 END) as totalVideos,
        COALESCE(SUM(credits_spent), 0) as totalCreditsSpent,
        COALESCE(SUM(file_size), 0) as totalBytes,
        SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END) as totalFavorites
      FROM assets
    `)
    .get();

  const byModel = db
    .prepare(`
      SELECT model, type, COUNT(*) as count, COALESCE(SUM(credits_spent), 0) as credits
      FROM assets
      GROUP BY model, type
      ORDER BY count DESC
    `)
    .all();

  const byProject = db
    .prepare(`
      SELECT COALESCE(project, '(genel)') as project, COUNT(*) as count
      FROM assets
      GROUP BY project
      ORDER BY count DESC
    `)
    .all();

  return {
    totalAssets: totals.totalAssets || 0,
    totalImages: totals.totalImages || 0,
    totalVideos: totals.totalVideos || 0,
    totalCreditsSpent: totals.totalCreditsSpent || 0,
    totalBytes: totals.totalBytes || 0,
    totalFavorites: totals.totalFavorites || 0,
    byModel,
    byProject
  };
}

export function exportAssets({ outDir, project = null, type = null, tag = null, favorite = false } = {}) {
  const assets = listAssets({ project, type, tag, favorite, limit: 10000 });
  const targetDir = path.resolve(outDir);
  fs.mkdirSync(targetDir, { recursive: true });

  const exported = [];
  for (const a of assets) {
    if (!a.fileExists) continue;
    const destName = path.basename(a.filePath);
    const destPath = path.join(targetDir, destName);
    fs.copyFileSync(a.filePath, destPath);
    exported.push({ ...a, exportedPath: destPath });
  }

  const manifestPath = path.join(targetDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        count: exported.length,
        filters: { project, type, tag, favorite },
        assets: exported
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  return { outDir: targetDir, manifestPath, count: exported.length };
}

/**
 * Süresi dolmuş ve hâlâ orijinal üretim yolunda duran (taşınmamış) dosyaları
 * güvenli şekilde temizler. Dosya başka yere taşındıysa (orijinal yolda yoksa)
 * veya favoriyse (includeFavorites=false iken) dokunmaz.
 */
export function pruneExpiredAssets({
  olderThanMs = null,
  includeFavorites = false,
  dryRun = false,
  nowMs = Date.now()
} = {}) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM assets ORDER BY created_at ASC').all().map(hydrateAsset);
  const candidates = [];
  const skippedMoved = [];

  for (const a of rows) {
    if (a.favorite && !includeFavorites) continue;

    let expired = false;
    if (a.expiresAt) {
      const exp = Date.parse(a.expiresAt);
      if (Number.isFinite(exp) && exp <= nowMs) expired = true;
    }
    if (!expired && olderThanMs !== null) {
      const created = Date.parse(a.createdAt);
      if (Number.isFinite(created) && nowMs - created >= olderThanMs) expired = true;
    }
    if (!expired) continue;

    // Dosya orijinal yerinde hâlâ duruyor mu? Taşındıysa silme!
    const stillAtOriginalPath = Boolean(a.filePath && fs.existsSync(a.filePath));
    if (!stillAtOriginalPath) {
      skippedMoved.push({ id: a.id, filePath: a.filePath, reason: 'moved_or_missing' });
      continue;
    }

    candidates.push(a);
  }

  const deleted = [];
  if (!dryRun) {
    for (const a of candidates) {
      try {
        fs.unlinkSync(a.filePath);
        db.prepare('DELETE FROM assets WHERE id = ?').run(a.id);
        deleted.push({ id: a.id, filePath: a.filePath, fileSize: a.fileSize });
      } catch {
        // Dosya kilitliyse atla
      }
    }
  }

  return {
    dryRun,
    matchedCount: candidates.length,
    deletedCount: dryRun ? 0 : deleted.length,
    skippedMovedCount: skippedMoved.length,
    candidates: candidates.map((a) => ({ id: a.id, filePath: a.filePath, createdAt: a.createdAt, expiresAt: a.expiresAt })),
    deleted,
    skippedMoved
  };
}

function normalizeTags(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(',');
  return [...new Set(arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
}

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
