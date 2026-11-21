import {
  deleteAsset,
  exportAssets,
  getAssetLineage,
  getStats,
  listAssets,
  pruneExpiredAssets,
  searchAssets,
  updateAssetMeta
} from '../catalog.js';
import { loadConfig, parseDurationMs, setConfigKey } from '../config.js';
import {
  c,
  EXIT_CODES,
  formatBytes,
  printError,
  printJson,
  printTable,
  truncate
} from '../output.js';

export function registerCatalogCommands(program) {
  program
    .command('list')
    .alias('ls')
    .description('Üretilen fotoğraf ve videoları ID ve promptlarıyla listeler')
    .option('-t, --type <type>', 'Tür filtresi (image | video)')
    .option('--project <name>', 'Proje filtresi')
    .option('-m, --model <model>', 'Model filtresi')
    .option('--tag <tag>', 'Etiket filtresi')
    .option('--job <jobId>', 'Batch iş ID filtresi')
    .option('--favorites', 'Sadece favorileri göster')
    .option('-l, --limit <n>', 'Maksimum kayıt sayısı', '20')
    .option('--json', 'JSON çıktı ver')
    .action((opts) => {
      const items = listAssets({
        type: opts.type || null,
        project: opts.project || null,
        model: opts.model || null,
        tag: opts.tag || null,
        jobId: opts.job || null,
        favorite: Boolean(opts.favorites),
        limit: Number(opts.limit) || 20
      });

      if (opts.json) {
        return printJson({ ok: true, count: items.length, assets: items });
      }

      printTable(
        ['ID', 'Tür', 'Model', 'Oran', 'Kredi', 'Proje', 'Prompt'],
        items.map((a) => [
          (a.favorite ? c('yellow', '★ ') : '') + c('cyan', a.id),
          a.type,
          a.model,
          a.aspectRatio,
          a.creditsSpent,
          a.project || '-',
          truncate(a.prompt, 46)
        ])
      );
    });

  program
    .command('show <id>')
    .description('Bir fotoğraf veya videonun tüm prompt, model, dosya ve soy ağacı (lineage) bilgisini gösterir')
    .option('--json', 'JSON çıktı ver')
    .action((id, opts) => {
      const info = getAssetLineage(id);
      if (!info) {
        return printError(`"${id}" ID'li kayıt bulunamadı.`, {
          json: opts.json,
          exitCode: EXIT_CODES.NOT_FOUND
        });
      }

      if (opts.json) {
        return printJson({ ok: true, ...info });
      }

      const a = info.asset;
      process.stdout.write(`${c('bold', a.id)} ${a.favorite ? c('yellow', '★') : ''}\n`);
      process.stdout.write(`  Tür         : ${a.type}\n`);
      process.stdout.write(`  Job ID      : ${a.jobId}\n`);
      process.stdout.write(`  Tarih       : ${a.createdAt}\n`);
      process.stdout.write(`  Model       : ${a.model}\n`);
      process.stdout.write(`  Oran/Kalite : ${a.aspectRatio} / ${a.quality}${a.duration ? ` / ${a.duration}sn` : ''}\n`);
      process.stdout.write(`  Kredi       : ${a.creditsSpent}\n`);
      process.stdout.write(`  Prompt      : ${a.prompt}\n`);
      if (a.negativePrompt) process.stdout.write(`  Negative    : ${a.negativePrompt}\n`);
      if (a.project) process.stdout.write(`  Proje       : ${a.project}\n`);
      if (a.tags.length) process.stdout.write(`  Etiketler   : ${a.tags.join(', ')}\n`);
      if (a.notes) process.stdout.write(`  Not         : ${a.notes}\n`);
      process.stdout.write(`  Dosya       : ${a.filePath} (${formatBytes(a.fileSize)}) ${a.fileExists ? c('green', '[mevcut]') : c('red', '[yok]')}\n`);
      if (a.sha256) process.stdout.write(`  SHA-256     : ${a.sha256.slice(0, 16)}…\n`);
      if (a.parentId) process.stdout.write(`  Üst ID      : ${a.parentId}\n`);
      if (info.children.length) {
        process.stdout.write(
          `  Türevler    : ${info.children.map((ch) => `${ch.id} (${ch.type})`).join(', ')}\n`
        );
      }
    });

  program
    .command('search <query>')
    .description('Prompt, not, etiket, proje ve model içinde arama yapar')
    .option('-t, --type <type>', 'Tür filtresi (image | video)')
    .option('-l, --limit <n>', 'Maksimum sonuç', '25')
    .option('--json', 'JSON çıktı ver')
    .action((query, opts) => {
      const items = searchAssets(query, {
        type: opts.type || null,
        limit: Number(opts.limit) || 25
      });

      if (opts.json) {
        return printJson({ ok: true, query, count: items.length, assets: items });
      }

      printTable(
        ['ID', 'Tür', 'Model', 'Oran', 'Etiketler', 'Prompt'],
        items.map((a) => [
          c('cyan', a.id),
          a.type,
          a.model,
          a.aspectRatio,
          a.tags.join(',') || '-',
          truncate(a.prompt, 46)
        ])
      );
    });

  program
    .command('tag <id>')
    .description('Bir kayda etiket, not, proje veya favori işareti ekler/günceller')
    .option('--add <tags>', 'Eklenecek etiketler (virgülle)')
    .option('--remove <tags>', 'Kaldırılacak etiketler (virgülle)')
    .option('--note <text>', 'Not ekle/güncelle')
    .option('--project <name>', 'Proje adını güncelle')
    .option('--favorite', 'Favorilere ekle')
    .option('--unfavorite', 'Favorilerden çıkar')
    .option('--json', 'JSON çıktı ver')
    .action((id, opts) => {
      const updated = updateAssetMeta(id, {
        addTags: opts.add ? opts.add.split(',') : [],
        removeTags: opts.remove ? opts.remove.split(',') : [],
        note: opts.note,
        project: opts.project,
        favorite: opts.favorite ? true : opts.unfavorite ? false : undefined
      });

      if (!updated) {
        return printError(`"${id}" ID'li kayıt bulunamadı.`, {
          json: opts.json,
          exitCode: EXIT_CODES.NOT_FOUND
        });
      }

      if (opts.json) {
        return printJson({ ok: true, asset: updated });
      }
      process.stdout.write(
        `${c('green', '✓')} ${updated.id} güncellendi | Etiketler: [${updated.tags.join(', ')}]` +
          (updated.favorite ? ' ★' : '') +
          '\n'
      );
    });

  program
    .command('delete <id>')
    .alias('rm')
    .description('Bir kaydı katalogdan siler (isteğe bağlı disk dosyasını da siler)')
    .option('--delete-file', 'Diskteki medya dosyasını da sil')
    .option('--json', 'JSON çıktı ver')
    .action((id, opts) => {
      const res = deleteAsset(id, { deleteFile: Boolean(opts.deleteFile) });
      if (!res) {
        return printError(`"${id}" ID'li kayıt bulunamadı.`, {
          json: opts.json,
          exitCode: EXIT_CODES.NOT_FOUND
        });
      }
      if (opts.json) {
        return printJson({ ok: true, ...res });
      }
      process.stdout.write(
        `${c('green', '✓')} ${id} katalogdan silindi` +
          (res.fileDeleted ? ' (disk dosyası da silindi)' : '') +
          '\n'
      );
    });

  program
    .command('export')
    .description('Filtrelenen fotoğraf/videoları manifest.json ile birlikte hedef klasöre kopyalar')
    .requiredOption('-o, --out <dir>', 'Hedef klasör')
    .option('--project <name>', 'Proje filtresi')
    .option('-t, --type <type>', 'Tür filtresi (image | video)')
    .option('--tag <tag>', 'Etiket filtresi')
    .option('--favorites', 'Sadece favoriler')
    .option('--json', 'JSON çıktı ver')
    .action((opts) => {
      const res = exportAssets({
        outDir: opts.out,
        project: opts.project || null,
        type: opts.type || null,
        tag: opts.tag || null,
        favorite: Boolean(opts.favorites)
      });
      if (opts.json) {
        return printJson({ ok: true, ...res });
      }
      process.stdout.write(
        `${c('green', '✓')} ${res.count} dosya dışa aktarıldı → ${res.outDir}\n` +
          `  Manifest: ${res.manifestPath}\n`
      );
    });

  program
    .command('stats')
    .description('Toplam üretim, harcanan kredi ve disk kullanım istatistiklerini gösterir')
    .option('--json', 'JSON çıktı ver')
    .action((opts) => {
      const stats = getStats();
      if (opts.json) {
        return printJson({ ok: true, stats });
      }
      process.stdout.write(`${c('bold', 'gflow İstatistikleri')}\n`);
      process.stdout.write(
        `  Toplam Kayıt : ${stats.totalAssets} (${stats.totalImages} fotoğraf, ${stats.totalVideos} video, ${stats.totalFavorites} favori)\n`
      );
      process.stdout.write(`  Harcanan Kredi: ${c('yellow', stats.totalCreditsSpent)}\n`);
      process.stdout.write(`  Disk Kullanımı: ${formatBytes(stats.totalBytes)}\n`);
      if (stats.byModel.length) {
        process.stdout.write('\n');
        printTable(
          ['Model', 'Tür', 'Adet', 'Toplam Kredi'],
          stats.byModel.map((m) => [m.model, m.type, m.count, m.credits])
        );
      }
    });

  program
    .command('prune')
    .description(
      'Süresi dolmuş ve başka yere taşınmamış (orijinal klasörde kalan) dosyaları temizler (varsayılan otomatik silme kapalıdır)'
    )
    .option('--older-than <duration>', 'Belirtilen süreden eski dosyaları sil (örn: 24h, 7d, 30m)')
    .option('--include-favorites', 'Favori işaretli dosyaları da dahil et')
    .option('--enable-auto <hours>', 'Otomatik silmeyi aç ve varsayılan süreyi (saat) ayarla')
    .option('--disable-auto', 'Otomatik silmeyi kapat')
    .option('--dry-run', 'Silmeden önce hangi dosyaların etkileneceğini göster')
    .option('--json', 'JSON çıktı ver')
    .action((opts) => {
      try {
        if (opts.enableAuto !== undefined) {
          const hrs = Number(opts.enableAuto);
          if (!Number.isFinite(hrs) || hrs <= 0) {
            return printError('--enable-auto pozitif bir saat değeri olmalıdır (örn: 168).', { json: opts.json });
          }
          setConfigKey('autoPruneEnabled', true);
          setConfigKey('autoPruneAfterHours', hrs);
        }
        if (opts.disableAuto) {
          setConfigKey('autoPruneEnabled', false);
        }

        const cfg = loadConfig();
        const olderThanMs = opts.olderThan
          ? parseDurationMs(opts.olderThan)
          : cfg.autoPruneEnabled && cfg.autoPruneAfterHours > 0
            ? cfg.autoPruneAfterHours * 3_600_000
            : null;

        const res = pruneExpiredAssets({
          olderThanMs,
          includeFavorites: Boolean(opts.includeFavorites),
          dryRun: Boolean(opts.dryRun)
        });

        if (opts.json) {
          return printJson({
            ok: true,
            autoPruneEnabled: cfg.autoPruneEnabled,
            autoPruneAfterHours: cfg.autoPruneAfterHours,
            ...res
          });
        }

        process.stdout.write(
          `${c('bold', opts.dryRun ? 'Prune (Dry-Run)' : 'Prune Tamamlandı')}\n` +
            `  Otomatik Silme : ${cfg.autoPruneEnabled ? c('green', `Açık (${cfg.autoPruneAfterHours} saat)`) : c('gray', 'Kapalı (varsayılan)')}\n` +
            `  Eşleşen        : ${res.matchedCount}\n` +
            `  Silinen        : ${res.deletedCount}\n` +
            `  Taşınmış/Atlanan: ${res.skippedMovedCount}\n`
        );
      } catch (err) {
        printError(err.message, { json: opts.json });
      }
    });
}
