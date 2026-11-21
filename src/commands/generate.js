import fs from 'node:fs';
import path from 'node:path';
import {
  createJob,
  findDuplicateAsset,
  getAsset,
  nextId,
  pruneExpiredAssets,
  recordAsset,
  resolveFileOrAssetId
} from '../catalog.js';
import { ensureDirs, loadConfig, parseDurationMs } from '../config.js';
import { getSessionStatus, isMockMode, runGeneration } from '../flow-driver.js';
import {
  estimateCredits,
  normalizeAspectRatio,
  normalizeQuality,
  resolveModel
} from '../models.js';
import { c, EXIT_CODES, formatBytes, printError, printJson } from '../output.js';
import { applyPresetToOptions, getPreset } from '../presets.js';

export async function executeGeneration(type, rawOpts, { silent = false } = {}) {
  const cfg = loadConfig();
  const paths = ensureDirs();

  let opts = { ...rawOpts };

  // Prompt dosyasından okuma (--prompt-file)
  if (opts.promptFile) {
    const pFile = path.resolve(opts.promptFile);
    if (!fs.existsSync(pFile)) {
      const msg = `Prompt dosyası bulunamadı: ${pFile}`;
      if (!silent) printError(msg, { json: opts.json, exitCode: EXIT_CODES.NOT_FOUND });
      return { ok: false, code: 'NOT_FOUND', error: msg };
    }
    const filePrompt = fs.readFileSync(pFile, 'utf8').trim();
    opts.prompt = opts.prompt ? `${filePrompt}\n${opts.prompt}` : filePrompt;
  }

  // Preset uygulama (--preset)
  if (opts.preset) {
    const preset = getPreset(opts.preset);
    if (!preset) {
      const msg = `Bilinmeyen preset: "${opts.preset}". Listelemek için: gflow preset list`;
      if (!silent) printError(msg, { json: opts.json, exitCode: EXIT_CODES.NOT_FOUND });
      return { ok: false, code: 'NOT_FOUND', error: msg };
    }
    opts = applyPresetToOptions(opts, preset);
  }

  if (!opts.prompt || !String(opts.prompt).trim()) {
    const msg = 'Prompt boş olamaz. `-p "..."` veya `--prompt-file <dosya>` verin.';
    if (!silent) printError(msg, { json: opts.json });
    return { ok: false, code: 'ERROR', error: msg };
  }

  const rawModel = opts.model || (type === 'video' ? cfg.defaultVideoModel : cfg.defaultImageModel);
  const model = resolveModel(rawModel, type);
  if (!model) {
    return printError(
      `Geçersiz ${type} modeli: "${rawModel}". Mevcut modeller için \`gflow models\` çalıştırın.`,
      { json: opts.json }
    );
  }

  let aspectRatio;
  let quality;
  try {
    aspectRatio = normalizeAspectRatio(
      opts.aspect || (type === 'video' ? cfg.defaultVideoAspect : cfg.defaultImageAspect),
      type
    );
    quality = normalizeQuality(
      opts.quality || (type === 'video' ? cfg.defaultVideoQuality : cfg.defaultImageQuality),
      type
    );
  } catch (err) {
    return printError(err.message, { json: opts.json });
  }

  const count = Number(opts.count ?? (type === 'video' ? 1 : cfg.defaultImageCount));
  if (!Number.isInteger(count) || count < 1 || count > (model.maxCount || 4)) {
    return printError(`Adet (--count) 1 ile ${model.maxCount || 4} arasında tam sayı olmalıdır.`, {
      json: opts.json
    });
  }

  const duration = type === 'video' ? Number(opts.duration ?? cfg.defaultVideoDuration) : null;
  if (type === 'video' && (!Number.isFinite(duration) || duration < 1 || duration > 15)) {
    return printError('Video süresi (--duration) 1 ile 15 saniye arasında olmalıdır.', {
      json: opts.json
    });
  }

  // Referans / frame çözümleme (dosya yolu veya img_XXXX ID'si)
  let refResolved = [];
  let firstFrameResolved = null;
  let lastFrameResolved = null;
  try {
    const rawRefs = (Array.isArray(opts.ref) ? opts.ref : opts.ref ? [opts.ref] : [])
      .flatMap((r) => String(r).split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    refResolved = rawRefs.map((r) => resolveFileOrAssetId(r));
    if (opts.firstFrame) firstFrameResolved = resolveFileOrAssetId(opts.firstFrame);
    if (opts.lastFrame) lastFrameResolved = resolveFileOrAssetId(opts.lastFrame);
  } catch (err) {
    return printError(err.message, { json: opts.json, exitCode: EXIT_CODES.NOT_FOUND });
  }

  const estimate = estimateCredits({
    type,
    modelId: model.id,
    quality,
    count,
    duration
  });

  // Mevcut bakiye (mümkünse)
  let currentBalance = null;
  try {
    if (isMockMode({ mock: opts.mock }) || opts.dryRun || estimate.requiresConfirmation) {
      const st = await getSessionStatus({ mock: opts.mock }).catch(() => null);
      if (st?.credits !== undefined) currentBalance = st.credits;
    }
  } catch {
    // ignore
  }

  const agentMode = opts.agentMode !== undefined ? Boolean(opts.agentMode) : Boolean(cfg.defaultAgentMode);
  const headless = opts.headed || opts.visible ? false : Boolean(cfg.headless);

  let expiresAt = null;
  if (opts.ttl) {
    try {
      const ttlMs = parseDurationMs(opts.ttl);
      expiresAt = new Date(Date.now() + ttlMs).toISOString();
    } catch (err) {
      return printError(err.message, { json: opts.json });
    }
  } else if (cfg.autoPruneEnabled && cfg.autoPruneAfterHours > 0) {
    expiresAt = new Date(Date.now() + cfg.autoPruneAfterHours * 3_600_000).toISOString();
  }

  const plan = {
    type,
    prompt: opts.prompt.trim(),
    negativePrompt: opts.negative || null,
    model: model.id,
    modelDisplayName: model.displayName,
    aspectRatio,
    quality,
    count,
    duration,
    audio: type === 'video' ? opts.audio !== false : null,
    agentMode,
    headless,
    expiresAt,
    estimatedCredits: estimate.estimatedTotalCredits,
    creditsPerItem: estimate.creditsPerItem,
    creditFormula: estimate.formula,
    currentBalance,
    requiresConfirmation: estimate.requiresConfirmation,
    parentId: opts.parentId || firstFrameResolved?.assetId || null,
    refIds: [
      ...refResolved.map((r) => r.assetId),
      firstFrameResolved?.assetId,
      lastFrameResolved?.assetId
    ].filter(Boolean),
    project: opts.project || null,
    tags: opts.tag ? String(opts.tag).split(',').map((t) => t.trim()).filter(Boolean) : []
  };

  // Dry-run: hiçbir şey üretmeden maliyeti ve planı döndür
  if (opts.dryRun) {
    if (!silent) {
      if (opts.json) {
        printJson({ ok: true, dryRun: true, plan });
      } else {
        printPlanSummary(plan, true);
      }
    }
    return { ok: true, dryRun: true, plan };
  }

  // Idempotency / Dedupe cache (--dedupe)
  if (opts.dedupe) {
    const cached = findDuplicateAsset({
      type,
      prompt: plan.prompt,
      model: model.id,
      aspectRatio,
      quality
    });
    if (cached) {
      const payload = {
        ok: true,
        cacheHit: true,
        jobId: cached.jobId,
        creditsSpent: 0,
        assets: [cached]
      };
      if (!silent) {
        if (opts.json) {
          printJson(payload);
        } else {
          process.stdout.write(
            `${c('cyan', '↺ Cache hit:')} ${c('bold', cached.id)} (${cached.filePath}) — yeniden üretim atlandı (0 kredi)\n`
          );
        }
      }
      return payload;
    }
  }

  // KREDİ GÜVENLİK KİLİDİ: Video üretimi VEYA >0 kredi harcayan herhangi bir işlem
  // kullanıcı onayı (--confirm-credits) olmadan ASLA çalışmaz!
  if (estimate.requiresConfirmation && !opts.confirmCredits) {
    const errPayload = {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      error:
        type === 'video'
          ? `Video üretimi kredi harcar (${estimate.estimatedTotalCredits} kredi). Kullanıcının açık onayını aldıktan sonra --confirm-credits ile çalıştırın.`
          : `Bu ayar ${estimate.estimatedTotalCredits} kredi harcar. Onaylamak için --confirm-credits ekleyin.`,
      plan
    };
    if (!silent) {
      if (opts.json) {
        printJson(errPayload);
      } else {
        printPlanSummary(plan, false);
        process.stderr.write(
          `\n${c('yellow', '⚠ Kredi Onayı Gerekli:')} Bu işlem tahmini ${c('bold', `${estimate.estimatedTotalCredits} kredi`)} harcayacak` +
            (currentBalance !== null ? ` (mevcut bakiye: ${c('cyan', currentBalance)})` : '') +
            `.\n  Devam etmek için komutu ${c('cyan', '--confirm-credits')} bayrağıyla çalıştırın.\n`
        );
      }
      process.exitCode = EXIT_CODES.CONFIRMATION_REQUIRED;
    }
    return errPayload;
  }

  const targetOutDir = opts.out
    ? path.resolve(opts.out)
    : type === 'video'
      ? paths.videosDir
      : paths.imagesDir;

  // ID'leri önceden ayır ki dosya adları ve katalog ID'leri birebir eşleşsin
  const idPrefix = type === 'video' ? 'vid' : 'img';
  const preAllocatedIds = Array.from({ length: count }, () => nextId(idPrefix));

  const maxRetries = Math.max(0, Number(opts.retries ?? 1) || 0);
  let lastErr = null;
  let result = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      result = await runGeneration({
        type,
        prompt: plan.prompt,
        negativePrompt: plan.negativePrompt,
        modelId: model.id,
        aspectRatio,
        quality,
        count,
        duration,
        audio: plan.audio,
        agentMode,
        headless,
        refFiles: refResolved.map((r) => r.filePath),
        firstFrameFile: firstFrameResolved?.filePath || null,
        lastFrameFile: lastFrameResolved?.filePath || null,
        outputDir: targetOutDir,
        assetIds: preAllocatedIds,
        estimatedCredits: estimate.estimatedTotalCredits,
        confirmCredits: Boolean(opts.confirmCredits),
        mock: Boolean(opts.mock),
        onProgress: (msg) => {
          if (!silent && !opts.json) process.stderr.write(`${c('gray', '…')} ${msg}\n`);
        }
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (err.code === 'AUTH_REQUIRED' || err.code === 'CONFIRMATION_REQUIRED') break;
      if (attempt < maxRetries) {
        if (!silent && !opts.json) {
          process.stderr.write(`${c('yellow', '↻')} Geçici hata, yeniden deneniyor (${attempt + 1}/${maxRetries})...\n`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  if (lastErr || !result) {
    const err = lastErr || new Error('Üretim başarısız oldu.');
    const exitCode =
      err.code === 'AUTH_REQUIRED'
        ? EXIT_CODES.AUTH_REQUIRED
        : err.code === 'CONFIRMATION_REQUIRED'
          ? EXIT_CODES.CONFIRMATION_REQUIRED
          : EXIT_CODES.ERROR;
    if (!silent) {
      printError(err.message, {
        json: opts.json,
        code: err.code || 'GENERATION_FAILED',
        exitCode,
        details: err.liveCredits !== undefined ? { liveCredits: err.liveCredits } : null
      });
    }
    return { ok: false, code: err.code || 'GENERATION_FAILED', error: err.message };
  }

  try {
    const job = createJob({
      type,
      prompt: plan.prompt,
      negativePrompt: plan.negativePrompt,
      model: model.id,
      aspectRatio,
      quality,
      count: result.files.length,
      duration,
      audio: plan.audio,
      creditsSpent: result.creditsSpent,
      accountEmail: result.accountEmail,
      project: plan.project,
      parentId: plan.parentId
    });

    const perAssetCredits =
      result.files.length > 0 ? result.creditsSpent / result.files.length : 0;

    const savedAssets = result.files.map((f) => {
      const saved = recordAsset({
        id: f.assetId,
        jobId: job.id,
        type,
        prompt: plan.prompt,
        negativePrompt: plan.negativePrompt,
        model: model.id,
        aspectRatio,
        quality,
        duration,
        seed: opts.seed || null,
        audio: plan.audio,
        creditsSpent: perAssetCredits,
        accountEmail: result.accountEmail,
        filePath: f.filePath,
        mimeType: f.mimeType,
        parentId: plan.parentId,
        refIds: plan.refIds,
        project: plan.project,
        tags: plan.tags,
        notes: opts.note || null,
        sourceUrl: f.sourceUrl,
        expiresAt
      });

      if (opts.writeMeta && saved?.filePath) {
        try {
          fs.writeFileSync(`${saved.filePath}.meta.json`, JSON.stringify(saved, null, 2) + '\n', 'utf8');
        } catch {
          // ignore sidecar write error
        }
      }
      return saved;
    });

    // Otomatik silme sadece kullanıcı açıkça açtıysa (autoPruneEnabled=true) çalışır
    let pruned = null;
    if (cfg.autoPruneEnabled) {
      pruned = pruneExpiredAssets({
        olderThanMs: cfg.autoPruneAfterHours > 0 ? cfg.autoPruneAfterHours * 3_600_000 : null,
        dryRun: false
      });
    }

    const outPayload = {
      ok: true,
      jobId: job.id,
      mock: Boolean(result.mock),
      agentMode,
      headless,
      creditsSpent: result.creditsSpent,
      remainingCredits: result.remainingCredits,
      accountEmail: result.accountEmail,
      ...(pruned && pruned.deletedCount > 0 ? { autoPruned: pruned.deletedCount } : {}),
      assets: savedAssets
    };

    if (!silent) {
      if (opts.json) {
        printJson(outPayload);
      } else {
        process.stdout.write(
          `${c('green', '✓')} ${savedAssets.length} ${type === 'video' ? 'video' : 'fotoğraf'} üretildi ` +
            `(${c('cyan', job.id)} | Harcanan: ${c('yellow', `${result.creditsSpent} kredi`)}` +
            (result.remainingCredits !== null && result.remainingCredits !== undefined
              ? ` | Kalan: ${c('cyan', result.remainingCredits)}`
              : '') +
            `)\n`
        );
        for (const a of savedAssets) {
          process.stdout.write(
            `  ${c('bold', a.id)}  ${a.aspectRatio}  ${a.model}  ${formatBytes(a.fileSize)}  ${a.filePath}\n`
          );
        }
      }
    }
    return outPayload;
  } catch (err) {
    if (!silent) {
      printError(err.message, { json: opts.json, code: 'CATALOG_ERROR' });
    }
    return { ok: false, code: 'CATALOG_ERROR', error: err.message };
  }
}

function printPlanSummary(plan, isDryRun) {
  const title = isDryRun ? 'Dry-Run Üretim Planı' : 'Üretim Özeti (Onay Bekliyor)';
  process.stdout.write(`${c('bold', title)}\n`);
  process.stdout.write(`  Tür         : ${plan.type}\n`);
  process.stdout.write(`  Model       : ${plan.modelDisplayName} (${plan.model})\n`);
  process.stdout.write(`  Oran        : ${plan.aspectRatio}\n`);
  process.stdout.write(`  Kalite      : ${plan.quality}\n`);
  process.stdout.write(`  Adet        : ${plan.count}\n`);
  if (plan.duration) process.stdout.write(`  Süre        : ${plan.duration}sn\n`);
  process.stdout.write(
    `  Kredi       : ${c('yellow', `${plan.estimatedCredits} kredi`)} (${plan.creditFormula})\n`
  );
  if (plan.currentBalance !== null) {
    process.stdout.write(`  Bakiye      : ${c('cyan', plan.currentBalance)}\n`);
  }
  process.stdout.write(`  Prompt      : ${plan.prompt}\n`);
}

export function registerGenerateCommands(program) {
  program
    .command('image')
    .alias('img')
    .description('Google Flow ile fotoğraf üretir (varsayılan 0 kredi / ücretsiz)')
    .option('-p, --prompt <text>', 'Fotoğraf açıklaması (prompt)')
    .option('--prompt-file <path>', 'Promptu metin/markdown dosyasından oku')
    .option('--preset <name>', 'Hazır veya özel stil preseti uygula (gflow preset list)')
    .option('--negative <text>', 'İstenmeyen öğeler (negative prompt)')
    .option('-m, --model <model>', 'Model (nano-banana, nano-banana-pro, imagen-4)')
    .option('-a, --aspect <ratio>', 'En-boy oranı (1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3)')
    .option('-q, --quality <quality>', 'Kalite (low, standard, medium, high, 1k, 2k, 4k)')
    .option('-n, --count <number>', 'Üretilecek fotoğraf sayısı (1-4)')
    .option('--ref <pathOrId...>', 'Referans görsel dosya yolu veya img_XXXX ID')
    .option('--seed <seed>', 'Seed değeri')
    .option('--project <name>', 'Proje/klasör etiketi')
    .option('--tag <tags>', 'Virgülle ayrılmış etiketler (örn: hero,kapak)')
    .option('--note <text>', 'Katalog notu')
    .option('-o, --out <dir>', 'Özel çıktı klasörü')
    .option('--ttl <duration>', 'Taşınmadığı sürece otomatik silinme süresi (örn: 24h, 7d)')
    .option('--dedupe', 'Aynı prompt+ayar zaten üretildiyse yeniden üretmeden cache dön')
    .option('--retries <n>', 'Geçici hatalarda yeniden deneme sayısı', '1')
    .option('--write-meta', 'Dosyanın yanına .meta.json metadata dosyası yaz')
    .option('--agent-mode', 'Google Flow Ajan Modunu aç (varsayılan kapalı)')
    .option('--headed', 'Tarayıcıyı görünür pencerede aç (varsayılan headless)')
    .option('--visible', '--headed ile aynı')
    .option('--dry-run', 'Üretim yapmadan maliyet ve planı göster')
    .option('--confirm-credits', '0 üstü kredi harcayan ayarlar için açık onay')
    .option('--mock', 'Offline test/mock modunda çalıştır')
    .option('--json', 'JSON çıktı ver')
    .action(async (opts) => {
      await executeGeneration('image', opts);
    });

  program
    .command('video')
    .alias('vid')
    .description('Google Flow ile video üretir (kredi onayı zorunludur)')
    .option('-p, --prompt <text>', 'Video açıklaması (prompt)')
    .option('--prompt-file <path>', 'Promptu metin/markdown dosyasından oku')
    .option('--preset <name>', 'Hazır veya özel preset uygula')
    .option('--negative <text>', 'İstenmeyen öğeler')
    .option('-m, --model <model>', 'Model (veo-3.1-lite, veo-3.1-fast, veo-3.1-quality, omni-flash-1.2)')
    .option('-a, --aspect <ratio>', 'En-boy oranı (16:9, 9:16, 1:1)')
    .option('-q, --quality <quality>', 'Çözünürlük (360p, 720p, 1080p, 4k)')
    .option('-d, --duration <seconds>', 'Video süresi (saniye)')
    .option('-n, --count <number>', 'Üretilecek klip sayısı (1-4)', '1')
    .option('--first-frame <pathOrId>', 'Başlangıç karesi (dosya yolu veya img_XXXX ID)')
    .option('--last-frame <pathOrId>', 'Bitiş karesi (dosya yolu veya img_XXXX ID)')
    .option('--ref <pathOrId...>', 'Referans görseller (dosya yolu veya img_XXXX ID)')
    .option('--no-audio', 'Ses üretimini kapat')
    .option('--project <name>', 'Proje etiketi')
    .option('--tag <tags>', 'Virgülle ayrılmış etiketler')
    .option('--note <text>', 'Katalog notu')
    .option('-o, --out <dir>', 'Özel çıktı klasörü')
    .option('--ttl <duration>', 'Taşınmadığı sürece otomatik silinme süresi (örn: 24h, 7d)')
    .option('--dedupe', 'Aynı prompt+ayar zaten üretildiyse cache dön')
    .option('--retries <n>', 'Geçici hatalarda yeniden deneme sayısı', '1')
    .option('--write-meta', 'Dosyanın yanına .meta.json metadata dosyası yaz')
    .option('--agent-mode', 'Google Flow Ajan Modunu aç (varsayılan kapalı)')
    .option('--headed', 'Tarayıcıyı görünür pencerede aç (varsayılan headless)')
    .option('--visible', '--headed ile aynı')
    .option('--dry-run', 'Üretim yapmadan kredi maliyetini ve planı göster')
    .option('--confirm-credits', 'Kredi harcamasını onayla (video için zorunlu)')
    .option('--mock', 'Offline test/mock modunda çalıştır')
    .option('--json', 'JSON çıktı ver')
    .action(async (opts) => {
      await executeGeneration('video', opts);
    });

  program
    .command('remix <id>')
    .description('Mevcut bir ID (img_XXXX / vid_XXXX) ayarlarını miras alıp yeni varyasyon üretir')
    .option('-p, --prompt <text>', 'Yeni prompt (boş bırakılırsa orijinal prompt kullanılır)')
    .option('--append-prompt <text>', 'Orijinal promptun sonuna eklenecek metin')
    .option('--negative <text>', 'Yeni negative prompt')
    .option('-m, --model <model>', 'Modeli değiştir')
    .option('-a, --aspect <ratio>', 'En-boy oranını değiştir')
    .option('-q, --quality <quality>', 'Kaliteyi değiştir')
    .option('-n, --count <number>', 'Üretilecek adet')
    .option('--use-as-ref', 'Orijinal dosyayı referans görsel olarak ekle')
    .option('--project <name>', 'Proje etiketi')
    .option('--tag <tags>', 'Ek etiketler')
    .option('--ttl <duration>', 'Taşınmadığı sürece otomatik silinme süresi')
    .option('--agent-mode', 'Google Flow Ajan Modunu aç (varsayılan kapalı)')
    .option('--headed', 'Tarayıcıyı görünür pencerede aç')
    .option('--visible', '--headed ile aynı')
    .option('--dry-run', 'Kredi ve planı göster')
    .option('--confirm-credits', 'Kredi harcamasını onayla')
    .option('--mock', 'Mock modunda çalıştır')
    .option('--json', 'JSON çıktı ver')
    .action(async (id, opts) => {
      const parent = getAsset(id);
      if (!parent) {
        return printError(`Katalogda "${id}" ID'li kayıt bulunamadı.`, {
          json: opts.json,
          exitCode: EXIT_CODES.NOT_FOUND
        });
      }

      const nextPrompt = opts.prompt
        ? opts.prompt
        : opts.appendPrompt
          ? `${parent.prompt}, ${opts.appendPrompt}`
          : parent.prompt;

      const mergedTags = [
        ...parent.tags,
        ...(opts.tag ? String(opts.tag).split(',').map((t) => t.trim()) : [])
      ].join(',');

      await executeGeneration(parent.type, {
        prompt: nextPrompt,
        negative: opts.negative ?? parent.negativePrompt,
        model: opts.model || parent.model,
        aspect: opts.aspect || parent.aspectRatio,
        quality: opts.quality || parent.quality,
        count: opts.count ?? 1,
        duration: parent.duration,
        ref: opts.useAsRef ? [parent.id] : [],
        parentId: parent.id,
        project: opts.project ?? parent.project,
        tag: mergedTags,
        ttl: opts.ttl,
        agentMode: opts.agentMode,
        headed: opts.headed,
        visible: opts.visible,
        dryRun: opts.dryRun,
        confirmCredits: opts.confirmCredits,
        mock: opts.mock,
        json: opts.json
      });
    });

  program
    .command('animate <imgId>')
    .description('Üretilmiş bir fotoğrafı (img_XXXX) başlangıç karesi yaparak videoya dönüştürür')
    .requiredOption('-p, --prompt <text>', 'Hareket / kamera / sahne açıklaması')
    .option('-m, --model <model>', 'Video modeli (varsayılan: veo-3.1-lite)')
    .option('-a, --aspect <ratio>', 'En-boy oranı (boş bırakılırsa fotoğrafın oranını miras alır)')
    .option('-q, --quality <quality>', 'Çözünürlük (360p, 720p, 1080p, 4k)')
    .option('-d, --duration <seconds>', 'Video süresi (saniye)')
    .option('--last-frame <pathOrId>', 'İsteğe bağlı bitiş karesi')
    .option('--no-audio', 'Ses üretimini kapat')
    .option('--project <name>', 'Proje etiketi')
    .option('--tag <tags>', 'Etiketler')
    .option('--ttl <duration>', 'Taşınmadığı sürece otomatik silinme süresi')
    .option('--agent-mode', 'Google Flow Ajan Modunu aç (varsayılan kapalı)')
    .option('--headed', 'Tarayıcıyı görünür pencerede aç')
    .option('--visible', '--headed ile aynı')
    .option('--dry-run', 'Kredi maliyetini ve planı göster')
    .option('--confirm-credits', 'Kredi harcamasını onayla (zorunlu)')
    .option('--mock', 'Mock modunda çalıştır')
    .option('--json', 'JSON çıktı ver')
    .action(async (imgId, opts) => {
      const src = getAsset(imgId);
      if (!src) {
        return printError(`Katalogda "${imgId}" ID'li fotoğraf bulunamadı.`, {
          json: opts.json,
          exitCode: EXIT_CODES.NOT_FOUND
        });
      }
      if (src.type !== 'image') {
        return printError(`"${imgId}" bir fotoğraf değil (${src.type}).`, { json: opts.json });
      }
      const inheritedAspect = ['16:9', '9:16', '1:1'].includes(src.aspectRatio)
        ? src.aspectRatio
        : '16:9';

      await executeGeneration('video', {
        prompt: opts.prompt,
        model: opts.model,
        aspect: opts.aspect || inheritedAspect,
        quality: opts.quality,
        duration: opts.duration,
        count: 1,
        firstFrame: src.id,
        lastFrame: opts.lastFrame,
        audio: opts.audio,
        parentId: src.id,
        project: opts.project ?? src.project,
        tag: opts.tag,
        ttl: opts.ttl,
        agentMode: opts.agentMode,
        headed: opts.headed,
        visible: opts.visible,
        dryRun: opts.dryRun,
        confirmCredits: opts.confirmCredits,
        mock: opts.mock,
        json: opts.json
      });
    });
}
