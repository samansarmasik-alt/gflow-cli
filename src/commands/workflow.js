import fs from 'node:fs';
import path from 'node:path';
import { getAsset } from '../catalog.js';
import { c, EXIT_CODES, printError, printJson, printTable, truncate } from '../output.js';
import { deletePreset, getPreset, listPresets, savePreset } from '../presets.js';
import { executeGeneration } from './generate.js';

export function registerWorkflowCommands(program) {
  // --- PRESET COMMANDS ---
  const preset = program
    .command('preset')
    .description('Hazır ve özel stil profillerini (youtube-thumb, product-studio, character-sheet vb.) yönetir');

  preset
    .command('list')
    .alias('ls')
    .description('Tüm yerleşik ve özel presetleri listeler')
    .option('--json', 'JSON çıktı ver')
    .action((opts) => {
      const items = listPresets();
      if (opts.json) return printJson({ ok: true, count: items.length, presets: items });
      printTable(
        ['Ad', 'Kaynak', 'Model', 'Oran', 'Kalite', 'Adet', 'Stil Eki'],
        items.map((p) => [
          c('cyan', p.name),
          p.builtin ? 'yerleşik' : c('green', 'özel'),
          p.model || '-',
          p.aspect || '-',
          p.quality || '-',
          p.count ?? '-',
          truncate(p.promptSuffix || p.promptPrefix || '-', 42)
        ])
      );
    });

  preset
    .command('show <name>')
    .description('Bir presetin tüm ayrıntılarını gösterir')
    .option('--json', 'JSON çıktı ver')
    .action((name, opts) => {
      const p = getPreset(name);
      if (!p) {
        return printError(`Preset bulunamadı: "${name}"`, {
          json: opts.json,
          exitCode: EXIT_CODES.NOT_FOUND
        });
      }
      if (opts.json) return printJson({ ok: true, preset: p });
      process.stdout.write(`${c('bold', p.name)} (${p.builtin ? 'yerleşik' : 'özel'})\n`);
      for (const [k, v] of Object.entries(p)) {
        if (k === 'name' || k === 'builtin' || v === null || v === undefined) continue;
        process.stdout.write(`  ${c('cyan', k.padEnd(14))}: ${Array.isArray(v) ? v.join(', ') : v}\n`);
      }
    });

  preset
    .command('save <name>')
    .description('Yeni özel preset oluşturur veya günceller')
    .option('-t, --type <type>', 'Tür (image | video)', 'image')
    .option('-m, --model <model>', 'Varsayılan model')
    .option('-a, --aspect <ratio>', 'Varsayılan en-boy oranı')
    .option('-q, --quality <quality>', 'Varsayılan kalite')
    .option('-n, --count <number>', 'Varsayılan adet')
    .option('--prefix <text>', 'Prompt başına otomatik eklenecek stil metni')
    .option('--suffix <text>', 'Prompt sonuna otomatik eklenecek stil metni')
    .option('--negative <text>', 'Varsayılan negative prompt')
    .option('--project <name>', 'Varsayılan proje')
    .option('--tag <tags>', 'Varsayılan etiketler (virgülle)')
    .option('--json', 'JSON çıktı ver')
    .action((name, opts) => {
      try {
        const saved = savePreset(name, {
          type: opts.type,
          model: opts.model,
          aspect: opts.aspect,
          quality: opts.quality,
          count: opts.count,
          promptPrefix: opts.prefix,
          promptSuffix: opts.suffix,
          negative: opts.negative,
          project: opts.project,
          tags: opts.tag
        });
        if (opts.json) return printJson({ ok: true, preset: saved });
        process.stdout.write(`${c('green', '✓')} Preset kaydedildi: ${c('bold', saved.name)}\n`);
      } catch (err) {
        printError(err.message, { json: opts.json });
      }
    });

  preset
    .command('delete <name>')
    .alias('rm')
    .description('Kullanıcı tarafından oluşturulan özel bir preseti siler')
    .option('--json', 'JSON çıktı ver')
    .action((name, opts) => {
      try {
        const ok = deletePreset(name);
        if (!ok) {
          return printError(`Preset bulunamadı: "${name}"`, {
            json: opts.json,
            exitCode: EXIT_CODES.NOT_FOUND
          });
        }
        if (opts.json) return printJson({ ok: true, deleted: name });
        process.stdout.write(`${c('green', '✓')} Preset silindi: ${name}\n`);
      } catch (err) {
        printError(err.message, { json: opts.json });
      }
    });

  // --- BATCH MANIFEST COMMAND ---
  program
    .command('batch <manifestPath>')
    .description(
      'JSON manifest dosyasından toplu fotoğraf/video üretir (resume, dry-run, dedupe ve kredi korumalı)'
    )
    .option('--dry-run', 'Üretim yapmadan tüm manifesti doğrula ve toplam kredi maliyetini hesapla')
    .option('--resume', 'Daha önce tamamlanan satırları lock dosyasından atlayıp kaldığı yerden devam et')
    .option('--delay <ms>', 'İşler arası bekleme süresi (ms)', '1500')
    .option('--retries <n>', 'Her iş için geçici hata yeniden deneme sayısı', '1')
    .option('--dedupe', 'Aynı prompt+ayar zaten katalogdaysa yeniden üretme')
    .option('--write-meta', 'Her çıktının yanına .meta.json yaz')
    .option('--headed', 'Chrome penceresini görünür aç')
    .option('--confirm-credits', 'Toplam kredi >0 veya video işi varsa onay bayrağı')
    .option('--mock', 'Offline test/mock modunda çalıştır')
    .option('--json', 'JSON çıktı ver')
    .action(async (manifestPath, opts) => {
      const absManifest = path.resolve(manifestPath);
      if (!fs.existsSync(absManifest)) {
        return printError(`Manifest dosyası bulunamadı: ${absManifest}`, {
          json: opts.json,
          exitCode: EXIT_CODES.NOT_FOUND
        });
      }

      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(absManifest, 'utf8'));
      } catch (err) {
        return printError(`Manifest JSON okunamadı: ${err.message}`, { json: opts.json });
      }

      const items = Array.isArray(raw) ? raw : Array.isArray(raw.jobs) ? raw.jobs : null;
      if (!items || items.length === 0) {
        return printError('Manifest boş veya geçersiz (dizi veya `{ "jobs": [...] }` beklenir).', {
          json: opts.json
        });
      }

      const defaults = !Array.isArray(raw) && raw.defaults ? raw.defaults : {};
      const lockPath = `${absManifest}.lock.json`;
      let lockState = {};
      if (opts.resume && fs.existsSync(lockPath)) {
        try {
          lockState = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        } catch {
          lockState = {};
        }
      }

      // 1) Ön doğrulama & toplam kredi hesabı (tüm satırlar için dry-run)
      const plans = [];
      let totalEstimatedCredits = 0;
      let anyRequiresConfirm = false;

      for (let i = 0; i < items.length; i++) {
        const entry = { ...defaults, ...items[i] };
        const key = entry.key || entry.id || `row_${i + 1}`;
        if (opts.resume && lockState[key]?.ok) {
          plans.push({ key, skipped: true, reason: 'resumed', previousAssets: lockState[key].assetIds });
          continue;
        }
        const type = entry.type === 'video' ? 'video' : 'image';
        const dryRes = await executeGeneration(
          type,
          {
            prompt: entry.prompt,
            promptFile: entry.promptFile || entry.prompt_file,
            preset: entry.preset,
            negative: entry.negative,
            model: entry.model,
            aspect: entry.aspect || entry.aspectRatio || entry.aspect_ratio,
            quality: entry.quality,
            count: entry.count,
            duration: entry.duration,
            ref: entry.ref || entry.refs,
            firstFrame: entry.firstFrame || entry.first_frame,
            lastFrame: entry.lastFrame || entry.last_frame,
            project: entry.project,
            tag: Array.isArray(entry.tags) ? entry.tags.join(',') : entry.tag,
            note: entry.note,
            out: entry.out,
            ttl: entry.ttl,
            agentMode: entry.agentMode,
            headed: opts.headed ?? entry.headed,
            dryRun: true,
            mock: opts.mock,
            json: true
          },
          { silent: true }
        );

        if (!dryRes?.ok) {
          return printError(`Manifest satır ${i + 1} (${key}) geçersiz: ${dryRes?.error || 'hata'}`, {
            json: opts.json
          });
        }

        totalEstimatedCredits += dryRes.plan.estimatedCredits || 0;
        if (dryRes.plan.requiresConfirmation) anyRequiresConfirm = true;
        plans.push({ key, skipped: false, type, entry, plan: dryRes.plan });
      }

      if (opts.dryRun) {
        const summary = {
          ok: true,
          dryRun: true,
          manifest: absManifest,
          totalJobs: items.length,
          pendingJobs: plans.filter((p) => !p.skipped).length,
          skippedJobs: plans.filter((p) => p.skipped).length,
          totalEstimatedCredits,
          requiresConfirmation: anyRequiresConfirm,
          plans
        };
        if (opts.json) return printJson(summary);
        process.stdout.write(
          `${c('bold', 'Batch Dry-Run Özeti')}\n` +
            `  Toplam İş      : ${summary.totalJobs} (Bekleyen: ${summary.pendingJobs}, Atlanan: ${summary.skippedJobs})\n` +
            `  Toplam Kredi   : ${c('yellow', `${totalEstimatedCredits} kredi`)}\n` +
            `  Onay Gerekli mi: ${anyRequiresConfirm ? c('yellow', 'Evet (--confirm-credits)') : c('green', 'Hayır (ücretsiz)')}\n`
        );
        return;
      }

      if (anyRequiresConfirm && !opts.confirmCredits) {
        const payload = {
          ok: false,
          code: 'CONFIRMATION_REQUIRED',
          error: `Bu batch toplam ${totalEstimatedCredits} kredi harcayacak (veya video işi içeriyor). Onaylamak için --confirm-credits ile çalıştırın.`,
          totalEstimatedCredits,
          pendingJobs: plans.filter((p) => !p.skipped).length
        };
        if (opts.json) {
          printJson(payload);
        } else {
          process.stderr.write(`${c('yellow', '⚠ Kredi Onayı Gerekli:')} ${payload.error}\n`);
        }
        process.exitCode = EXIT_CODES.CONFIRMATION_REQUIRED;
        return;
      }

      // 2) Sıralı yürütme + lock dosyasına anlık kayıt
      const results = [];
      let completed = 0;
      let failed = 0;
      let totalSpent = 0;
      const delayMs = Math.max(0, Number(opts.delay) || 0);

      for (let i = 0; i < plans.length; i++) {
        const item = plans[i];
        if (item.skipped) {
          results.push({ key: item.key, status: 'skipped', assetIds: item.previousAssets });
          continue;
        }
        const entry = item.entry;
        if (!opts.json) {
          process.stderr.write(
            `${c('cyan', `[${i + 1}/${plans.length}]`)} ${item.key} (${item.type} / ${item.plan.model})...\n`
          );
        }

        const res = await executeGeneration(
          item.type,
          {
            prompt: entry.prompt,
            promptFile: entry.promptFile || entry.prompt_file,
            preset: entry.preset,
            negative: entry.negative,
            model: entry.model,
            aspect: entry.aspect || entry.aspectRatio || entry.aspect_ratio,
            quality: entry.quality,
            count: entry.count,
            duration: entry.duration,
            ref: entry.ref || entry.refs,
            firstFrame: entry.firstFrame || entry.first_frame,
            lastFrame: entry.lastFrame || entry.last_frame,
            project: entry.project,
            tag: Array.isArray(entry.tags) ? entry.tags.join(',') : entry.tag,
            note: entry.note,
            out: entry.out,
            ttl: entry.ttl,
            agentMode: entry.agentMode,
            headed: opts.headed ?? entry.headed,
            dedupe: Boolean(opts.dedupe || entry.dedupe),
            retries: opts.retries,
            writeMeta: Boolean(opts.writeMeta || entry.writeMeta),
            confirmCredits: Boolean(opts.confirmCredits),
            mock: Boolean(opts.mock),
            json: true
          },
          { silent: true }
        );

        if (res?.ok) {
          completed++;
          totalSpent += res.creditsSpent || 0;
          const assetIds = (res.assets || []).map((a) => a.id);
          lockState[item.key] = {
            ok: true,
            completedAt: new Date().toISOString(),
            assetIds,
            cacheHit: Boolean(res.cacheHit)
          };
          fs.writeFileSync(lockPath, JSON.stringify(lockState, null, 2) + '\n', 'utf8');
          results.push({ key: item.key, status: res.cacheHit ? 'cached' : 'completed', assetIds });
        } else {
          failed++;
          results.push({ key: item.key, status: 'failed', error: res?.error || 'hata' });
        }

        if (delayMs > 0 && !opts.mock && i < plans.length - 1) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      const finalPayload = {
        ok: failed === 0,
        manifest: absManifest,
        lockFile: lockPath,
        completed,
        failed,
        skipped: plans.filter((p) => p.skipped).length,
        creditsSpent: totalSpent,
        results
      };

      if (opts.json) {
        printJson(finalPayload);
      } else {
        process.stdout.write(
          `${c(failed === 0 ? 'green' : 'yellow', '✓ Batch bitti:')} ${completed} tamamlandı, ${failed} hatalı, ${finalPayload.skipped} atlandı | Harcanan: ${totalSpent} kredi\n`
        );
      }
      if (failed > 0) process.exitCode = EXIT_CODES.ERROR;
    });

  // --- COPY COMMAND ---
  program
    .command('copy <id> <destPath>')
    .alias('cp')
    .description('Bir katalog ID dosyasını hedef dosya/klasöre kopyalar')
    .option('--json', 'JSON çıktı ver')
    .action((id, destPath, opts) => {
      const asset = getAsset(id);
      if (!asset) {
        return printError(`"${id}" ID'li kayıt bulunamadı.`, {
          json: opts.json,
          exitCode: EXIT_CODES.NOT_FOUND
        });
      }
      if (!asset.fileExists) {
        return printError(`"${id}" kaydının dosyası diskte yok: ${asset.filePath}`, {
          json: opts.json,
          exitCode: EXIT_CODES.NOT_FOUND
        });
      }

      const absDest = path.resolve(destPath);
      let finalDest = absDest;
      if (fs.existsSync(absDest) && fs.statSync(absDest).isDirectory()) {
        finalDest = path.join(absDest, path.basename(asset.filePath));
      } else {
        fs.mkdirSync(path.dirname(finalDest), { recursive: true });
      }
      fs.copyFileSync(asset.filePath, finalDest);

      if (opts.json) {
        return printJson({ ok: true, id, source: asset.filePath, destination: finalDest });
      }
      process.stdout.write(`${c('green', '✓')} ${id} kopyalandı → ${finalDest}\n`);
    });
}
