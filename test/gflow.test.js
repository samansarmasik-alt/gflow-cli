import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'gflow.js');

let tmpHome;

function runGflow(args, { expectFail = false } = {}) {
  const env = { ...process.env, GFLOW_HOME: tmpHome, NO_COLOR: '1' };
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    if (!expectFail) {
      throw new Error(
        `gflow ${args.join(' ')} failed (code ${err.status}):\nSTDOUT: ${err.stdout}\nSTDERR: ${err.stderr}`
      );
    }
    return {
      code: err.status,
      stdout: err.stdout || '',
      stderr: err.stderr || ''
    };
  }
}

describe('gflow CLI end-to-end', () => {
  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gflow-test-'));
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('lists models in JSON format including free image and credit video models', () => {
    const res = runGflow(['models', '--json']);
    const data = JSON.parse(res.stdout);
    assert.equal(data.ok, true);
    const imgModel = data.models.find((m) => m.id === 'nano-banana');
    const vidModel = data.models.find((m) => m.id === 'veo-3.1-lite');
    assert.ok(imgModel);
    assert.equal(imgModel.baseCredits, 0);
    assert.ok(vidModel);
    assert.ok(vidModel.baseCredits > 0);
  });

  it('runs doctor and detects Node + SQLite catalog', () => {
    const res = runGflow(['doctor', '--json']);
    const data = JSON.parse(res.stdout);
    assert.equal(data.report.catalogOk, true);
    assert.ok(data.report.nodeVersion.startsWith('v'));
  });

  it('generates 2 free 4:3 images with unique sequential IDs and saves metadata', () => {
    const res = runGflow([
      'image',
      '-p', 'Cyberpunk Istanbul tram in rain, neon reflections',
      '-a', '4:3',
      '-n', '2',
      '--project', 'istanbul',
      '--tag', 'neon,rain',
      '--mock',
      '--json'
    ]);
    const data = JSON.parse(res.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.creditsSpent, 0);
    assert.equal(data.assets.length, 2);
    assert.equal(data.assets[0].id, 'img_0001');
    assert.equal(data.assets[1].id, 'img_0002');
    assert.equal(data.assets[0].aspectRatio, '4:3');
    assert.equal(data.assets[0].project, 'istanbul');
    assert.ok(fs.existsSync(data.assets[0].filePath));
    assert.ok(data.assets[0].sha256);
  });

  it('blocks paid image quality (4k) without --confirm-credits', () => {
    const res = runGflow(
      ['image', '-p', 'Ultra crisp product photo', '-q', '4k', '--mock', '--json'],
      { expectFail: true }
    );
    assert.equal(res.code, 2);
    const data = JSON.parse(res.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.code, 'CONFIRMATION_REQUIRED');
    assert.ok(data.plan.estimatedCredits > 0);
  });

  it('strictly blocks video generation without --confirm-credits and reports exact credit estimate', () => {
    const res = runGflow(
      ['video', '-p', 'Slow drone shot over Cappadocia balloons', '-m', 'veo-3.1-lite', '--mock', '--json'],
      { expectFail: true }
    );
    assert.equal(res.code, 2);
    const data = JSON.parse(res.stdout);
    assert.equal(data.ok, false);
    assert.equal(data.code, 'CONFIRMATION_REQUIRED');
    assert.equal(data.plan.estimatedCredits, 10);
    assert.equal(data.plan.currentBalance, 1000);
  });

  it('allows video generation when --confirm-credits is explicitly provided', () => {
    const res = runGflow([
      'video',
      '-p', 'Slow drone shot over Cappadocia balloons',
      '-m', 'veo-3.1-lite',
      '-a', '16:9',
      '--project', 'travel',
      '--confirm-credits',
      '--mock',
      '--json'
    ]);
    const data = JSON.parse(res.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.creditsSpent, 10);
    assert.equal(data.assets[0].id, 'vid_0001');
    assert.ok(fs.existsSync(data.assets[0].filePath));
  });

  it('remixes an existing image ID and tracks parent-child lineage', () => {
    const res = runGflow([
      'remix', 'img_0001',
      '--append-prompt', 'golden hour sunset',
      '-a', '16:9',
      '--use-as-ref',
      '--mock',
      '--json'
    ]);
    const data = JSON.parse(res.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.assets[0].id, 'img_0003');
    assert.equal(data.assets[0].parentId, 'img_0001');
    assert.match(data.assets[0].prompt, /golden hour sunset/);

    const show = JSON.parse(runGflow(['show', 'img_0001', '--json']).stdout);
    assert.equal(show.children.length, 1);
    assert.equal(show.children[0].id, 'img_0003');
  });

  it('animates an image ID into video with credit guard enforced', () => {
    const blocked = runGflow(
      ['animate', 'img_0001', '-p', 'Gentle rain falling, tram moving forward', '--mock', '--json'],
      { expectFail: true }
    );
    assert.equal(blocked.code, 2);

    const ok = runGflow([
      'animate', 'img_0001',
      '-p', 'Gentle rain falling, tram moving forward',
      '--confirm-credits',
      '--mock',
      '--json'
    ]);
    const data = JSON.parse(ok.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.assets[0].id, 'vid_0002');
    assert.equal(data.assets[0].parentId, 'img_0001');
  });

  it('searches, tags, lists, exports, computes stats, and deletes assets cleanly', () => {
    const search = JSON.parse(runGflow(['search', 'Cappadocia', '--json']).stdout);
    assert.equal(search.count, 1);
    assert.equal(search.assets[0].id, 'vid_0001');

    const tagged = JSON.parse(
      runGflow(['tag', 'img_0001', '--add', 'hero,v2', '--note', 'Kapak seçimi', '--favorite', '--json']).stdout
    );
    assert.equal(tagged.asset.favorite, true);
    assert.ok(tagged.asset.tags.includes('hero'));
    assert.equal(tagged.asset.notes, 'Kapak seçimi');

    const exportDir = path.join(tmpHome, 'exported');
    const exp = JSON.parse(runGflow(['export', '-o', exportDir, '--favorites', '--json']).stdout);
    assert.equal(exp.count, 1);
    assert.ok(fs.existsSync(exp.manifestPath));

    const stats = JSON.parse(runGflow(['stats', '--json']).stdout);
    assert.equal(stats.stats.totalImages, 3);
    assert.equal(stats.stats.totalVideos, 2);
    assert.equal(stats.stats.totalCreditsSpent, 20);

    const del = JSON.parse(runGflow(['delete', 'img_0002', '--delete-file', '--json']).stdout);
    assert.equal(del.deleted, true);
    assert.equal(del.fileDeleted, true);
  });

  it('updates and reads config values', () => {
    const set = JSON.parse(runGflow(['config', 'set', 'defaultImageAspect', '4:3', '--json']).stdout);
    assert.equal(set.value, '4:3');
    const show = JSON.parse(runGflow(['config', 'show', '--json']).stdout);
    assert.equal(show.config.defaultImageAspect, '4:3');
    assert.equal(show.config.headless, true);
    assert.equal(show.config.defaultAgentMode, false);
    assert.equal(show.config.autoPruneEnabled, false);
  });

  it('enforces default headless + agentMode=false, overrides with flags, and prunes only unmoved expired files', () => {
    // 1) Varsayılan: headless=true, agentMode=false
    const defPlan = JSON.parse(
      runGflow(['image', '-p', 'Test defaults', '--dry-run', '--mock', '--json']).stdout
    );
    assert.equal(defPlan.plan.headless, true);
    assert.equal(defPlan.plan.agentMode, false);

    // 2) Override: --headed --agent-mode
    const overPlan = JSON.parse(
      runGflow(['image', '-p', 'Test overrides', '--headed', '--agent-mode', '--dry-run', '--mock', '--json']).stdout
    );
    assert.equal(overPlan.plan.headless, false);
    assert.equal(overPlan.plan.agentMode, true);

    // 3) TTL + prune: iki dosya üret (1sn TTL), birini başka yere taşı, prune sadece taşınmayanı silmeli
    const gen = JSON.parse(
      runGflow(['image', '-p', 'Expiring temp image', '-n', '2', '--ttl', '0s', '--mock', '--json']).stdout
    );
    const movedAsset = gen.assets[0];
    const stayedAsset = gen.assets[1];

    const movedDest = path.join(tmpHome, 'moved-away.png');
    fs.renameSync(movedAsset.filePath, movedDest);

    const pruned = JSON.parse(runGflow(['prune', '--json']).stdout);
    assert.equal(pruned.deletedCount, 1);
    assert.equal(pruned.deleted[0].id, stayedAsset.id);
    assert.equal(pruned.skippedMovedCount, 1);
    assert.equal(fs.existsSync(stayedAsset.filePath), false);
    assert.equal(fs.existsSync(movedDest), true);
  });

  it('exposes machine-readable agent schema and supports local file + catalog ID reference uploads', () => {
    const schema = JSON.parse(runGflow(['schema']).stdout);
    assert.equal(schema.ok, true);
    assert.equal(schema.tool, 'gflow');
    assert.equal(schema.exitCodes.CONFIRMATION_REQUIRED, 2);
    assert.ok(schema.commands.length >= 5);
    assert.ok(schema.referenceUploads.supportedFlags.includes('--ref <pathOrId...>'));

    const md = runGflow(['schema', '--markdown']).stdout;
    assert.match(md, /# gflow Agent Quick Reference/);

    // Yerel dosya + mevcut img_0001 ID birlikte referans olarak verilebilmeli
    const localRef = path.join(tmpHome, 'local-ref.png');
    fs.writeFileSync(localRef, Buffer.from('89504e470d0a1a0a', 'hex'));

    const gen = JSON.parse(
      runGflow([
        'image',
        '-p', 'Combine style from both references',
        '--ref', `${localRef},img_0001`,
        '--mock',
        '--json'
      ]).stdout
    );
    assert.equal(gen.ok, true);
    assert.ok(gen.assets[0].refIds.includes('img_0001'));
  });

  it('supports builtin & custom presets, --prompt-file, --dedupe cache, --write-meta, and copy', () => {
    const presets = JSON.parse(runGflow(['preset', 'list', '--json']).stdout);
    assert.ok(presets.presets.some((p) => p.name === 'character-sheet'));

    const saved = JSON.parse(
      runGflow([
        'preset', 'save', 'brand-test',
        '-m', 'nano-banana-pro',
        '-a', '1:1',
        '-q', 'high',
        '--suffix', 'obsidian minimalism',
        '--json'
      ]).stdout
    );
    assert.equal(saved.preset.name, 'brand-test');

    const promptFile = path.join(tmpHome, 'long-prompt.txt');
    fs.writeFileSync(promptFile, 'Sleek titanium smartwatch on dark stone', 'utf8');

    const first = JSON.parse(
      runGflow([
        'image',
        '--prompt-file', promptFile,
        '--preset', 'brand-test',
        '--write-meta',
        '--mock',
        '--json'
      ]).stdout
    );
    assert.equal(first.ok, true);
    assert.match(first.assets[0].prompt, /obsidian minimalism/);
    assert.ok(fs.existsSync(`${first.assets[0].filePath}.meta.json`));

    // Aynı prompt+preset ile --dedupe cache hit dönmeli (0 yeni dosya)
    const cached = JSON.parse(
      runGflow([
        'image',
        '--prompt-file', promptFile,
        '--preset', 'brand-test',
        '--dedupe',
        '--mock',
        '--json'
      ]).stdout
    );
    assert.equal(cached.ok, true);
    assert.equal(cached.cacheHit, true);
    assert.equal(cached.assets[0].id, first.assets[0].id);

    // copy komutu
    const copyDest = path.join(tmpHome, 'copied-watch.png');
    const copied = JSON.parse(runGflow(['copy', first.assets[0].id, copyDest, '--json']).stdout);
    assert.equal(copied.ok, true);
    assert.ok(fs.existsSync(copyDest));

    const delPreset = JSON.parse(runGflow(['preset', 'delete', 'brand-test', '--json']).stdout);
    assert.equal(delPreset.ok, true);
  });

  it('runs batch manifest with dry-run, credit guard, and --resume lock file', () => {
    const manifestPath = path.join(tmpHome, 'campaign.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        defaults: { project: 'q4', model: 'nano-banana', aspect: '16:9' },
        jobs: [
          { key: 'banner-1', prompt: 'Minimalist SaaS hero banner, blue glow' },
          { key: 'banner-2', prompt: 'Clean dark dashboard preview', preset: 'ui-icon' }
        ]
      }),
      'utf8'
    );

    const dry = JSON.parse(runGflow(['batch', manifestPath, '--dry-run', '--mock', '--json']).stdout);
    assert.equal(dry.ok, true);
    assert.equal(dry.totalJobs, 2);
    assert.equal(dry.totalEstimatedCredits, 0);

    const run1 = JSON.parse(runGflow(['batch', manifestPath, '--mock', '--json']).stdout);
    assert.equal(run1.ok, true);
    assert.equal(run1.completed, 2);
    assert.ok(fs.existsSync(`${manifestPath}.lock.json`));

    // --resume tüm tamamlananları atlamalı
    const run2 = JSON.parse(runGflow(['batch', manifestPath, '--resume', '--mock', '--json']).stdout);
    assert.equal(run2.ok, true);
    assert.equal(run2.completed, 0);
    assert.equal(run2.skipped, 2);
  });
});
