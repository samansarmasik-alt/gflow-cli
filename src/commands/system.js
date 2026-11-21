import fs from 'node:fs';
import { findBrowserExecutable, isCdpAlive } from '../browser.js';
import { getStats } from '../catalog.js';
import { getPaths, loadConfig, setConfigKey } from '../config.js';
import { calibrateFlowUi, getSessionStatus, scrapeLiveModels } from '../flow-driver.js';
import {
  estimateCredits,
  IMAGE_ASPECT_RATIOS,
  IMAGE_QUALITIES,
  listModels,
  VIDEO_ASPECT_RATIOS,
  VIDEO_QUALITIES
} from '../models.js';
import { c, EXIT_CODES, printError, printJson, printTable } from '../output.js';

export function registerSystemCommands(program) {
  program
    .command('models')
    .description('Desteklenen Google Flow fotoğraf ve video modellerini listeler')
    .option('-t, --type <type>', 'Filtrele: image | video')
    .option('--live', 'Açık Google Flow sekmesinden canlı model isimlerini de oku')
    .option('--json', 'JSON çıktı ver')
    .action(async (opts) => {
      const catalog = listModels(opts.type || null);
      let live = null;
      if (opts.live) {
        try {
          live = await scrapeLiveModels();
        } catch (err) {
          return printError(err.message, { json: opts.json, exitCode: EXIT_CODES.BROWSER_ERROR });
        }
      }

      if (opts.json) {
        return printJson({ ok: true, models: catalog, ...(live ? { live } : {}) });
      }

      printTable(
        ['Model ID', 'Ad', 'Tür', 'Taban Kredi', 'Oranlar', 'Not'],
        catalog.map((m) => [
          c('cyan', m.id),
          m.displayName,
          m.type,
          m.baseCredits === 0 ? c('green', '0 (ücretsiz)') : c('yellow', String(m.baseCredits)),
          m.aspectRatios.slice(0, 4).join(','),
          m.notes
        ])
      );

      if (live) {
        process.stdout.write(
          `\n${c('bold', 'Canlı Sayfada Algılananlar:')} ${live.models.join(', ') || '(bulunamadı)'}\n`
        );
      }
    });

  program
    .command('credits')
    .description('Kredi bakiyesini kontrol eder veya belirli bir işlemin kredi maliyetini hesaplar')
    .option('-t, --type <type>', 'Maliyet hesabı için tür (image | video)')
    .option('-m, --model <model>', 'Model ID')
    .option('-q, --quality <quality>', 'Kalite / çözünürlük')
    .option('-n, --count <number>', 'Adet', '1')
    .option('-d, --duration <seconds>', 'Video süresi (sn)', '5')
    .option('--mock', 'Mock modunda çalıştır')
    .option('--json', 'JSON çıktı ver')
    .action(async (opts) => {
      let estimate = null;
      if (opts.type || opts.model) {
        const cfg = loadConfig();
        const type = opts.type || 'video';
        const modelId =
          opts.model || (type === 'video' ? cfg.defaultVideoModel : cfg.defaultImageModel);
        const quality =
          opts.quality || (type === 'video' ? cfg.defaultVideoQuality : cfg.defaultImageQuality);
        try {
          estimate = estimateCredits({
            type,
            modelId,
            quality,
            count: Number(opts.count) || 1,
            duration: Number(opts.duration) || 5
          });
        } catch (err) {
          return printError(err.message, { json: opts.json });
        }
      }

      let balance = null;
      let accountEmail = null;
      try {
        const st = await getSessionStatus({ mock: opts.mock });
        balance = st.credits;
        accountEmail = st.email;
      } catch {
        // Oturum kapalıysa sadece tahmini göster
      }

      if (opts.json) {
        return printJson({ ok: true, accountEmail, balance, estimate });
      }

      if (balance !== null) {
        process.stdout.write(
          `Hesap: ${accountEmail || '(aktif)'} | Mevcut Bakiye: ${c('yellow', `${balance} kredi`)}\n`
        );
      } else {
        process.stdout.write(
          c('gray', 'Canlı bakiye okunamadı (oturum kapalı olabilir). `gflow auth status` ile kontrol edin.\n')
        );
      }

      if (estimate) {
        process.stdout.write(
          `Tahmini Maliyet: ${c('bold', `${estimate.estimatedTotalCredits} kredi`)} — ${estimate.formula}\n` +
            `Onay Gerekli mi: ${estimate.requiresConfirmation ? c('yellow', 'Evet (--confirm-credits)') : c('green', 'Hayır (ücretsiz)')}\n`
        );
      }
    });

  const configCmd = program
    .command('config')
    .description('Varsayılan CLI ayarlarını görüntüler veya değiştirir');

  configCmd
    .command('show')
    .description('Tüm ayarları ve dosya yollarını gösterir')
    .option('--json', 'JSON çıktı ver')
    .action((opts) => {
      const cfg = loadConfig();
      const paths = getPaths();
      if (opts.json) {
        return printJson({ ok: true, config: cfg, paths });
      }
      process.stdout.write(`${c('bold', 'Ayarlar')}\n`);
      for (const [k, v] of Object.entries(cfg)) {
        process.stdout.write(`  ${c('cyan', k.padEnd(22))}: ${JSON.stringify(v)}\n`);
      }
      process.stdout.write(`\n${c('bold', 'Yollar')}\n`);
      process.stdout.write(`  Home     : ${paths.home}\n`);
      process.stdout.write(`  Katalog  : ${paths.dbFile}\n`);
      process.stdout.write(`  Çıktılar : ${paths.outputRoot}\n`);
    });

  configCmd
    .command('set <key> <value>')
    .description('Bir ayar değerini günceller')
    .option('--json', 'JSON çıktı ver')
    .action((key, value, opts) => {
      try {
        const next = setConfigKey(key, value);
        if (opts.json) {
          return printJson({ ok: true, key, value: next[key], config: next });
        }
        process.stdout.write(`${c('green', '✓')} ${key} = ${JSON.stringify(next[key])}\n`);
      } catch (err) {
        printError(err.message, { json: opts.json });
      }
    });

  program
    .command('calibrate')
    .description('Açık Google Flow sayfasının DOM/ARIA elementlerini tarayıp selectors.json oluşturur')
    .option('--json', 'JSON çıktı ver')
    .action(async (opts) => {
      try {
        const res = await calibrateFlowUi();
        if (opts.json) {
          return printJson({
            ok: true,
            selectorsFile: res.selectorsFile,
            url: res.url,
            counts: {
              textboxes: res.textboxes.length,
              buttons: res.buttons.length,
              comboboxes: res.comboboxes.length
            }
          });
        }
        process.stdout.write(
          `${c('green', '✓')} Kalibrasyon tamamlandı → ${res.selectorsFile}\n` +
            `  Sayfa: ${res.url}\n` +
            `  Bulunanlar: ${res.textboxes.length} textbox, ${res.buttons.length} buton, ${res.comboboxes.length} seçici\n`
        );
      } catch (err) {
        printError(err.message, { json: opts.json, exitCode: EXIT_CODES.BROWSER_ERROR });
      }
    });

  program
    .command('doctor')
    .description('Chrome, CDP, SQLite katalog ve oturum sağlığını teşhis eder')
    .option('--json', 'JSON çıktı ver')
    .action(async (opts) => {
      const cfg = loadConfig();
      const paths = getPaths();
      const chromeExe = findBrowserExecutable(cfg.chromePath);
      const cdp = await isCdpAlive(cfg.cdpPort);
      let session = null;
      if (cdp) {
        session = await getSessionStatus().catch(() => null);
      }
      let dbOk = false;
      let stats = null;
      try {
        stats = getStats();
        dbOk = true;
      } catch {
        dbOk = false;
      }

      const report = {
        nodeVersion: process.version,
        chromeFound: Boolean(chromeExe),
        chromePath: chromeExe,
        cdpPort: cfg.cdpPort,
        cdpRunning: Boolean(cdp),
        authenticated: Boolean(session?.authenticated),
        accountEmail: session?.email || null,
        credits: session?.credits ?? null,
        catalogOk: dbOk,
        catalogAssets: stats?.totalAssets ?? 0,
        homeDir: paths.home,
        profileExists: fs.existsSync(paths.profileDir)
      };

      if (opts.json) {
        return printJson({ ok: report.chromeFound && report.catalogOk, report });
      }

      const mark = (ok) => (ok ? c('green', '✓') : c('red', '✗'));
      process.stdout.write(`${c('bold', 'gflow Doctor')}\n`);
      process.stdout.write(`  ${mark(true)} Node.js        : ${report.nodeVersion}\n`);
      process.stdout.write(`  ${mark(report.chromeFound)} Tarayıcı       : ${report.chromePath || 'Bulunamadı!'}\n`);
      process.stdout.write(`  ${mark(report.catalogOk)} SQLite Katalog : ${paths.dbFile} (${report.catalogAssets} kayıt)\n`);
      process.stdout.write(`  ${mark(report.cdpRunning)} Chrome CDP     : 127.0.0.1:${report.cdpPort} (${report.cdpRunning ? 'çalışıyor' : 'kapalı'})\n`);
      process.stdout.write(
        `  ${mark(report.authenticated)} Google Oturumu : ` +
          (report.authenticated
            ? `${report.accountEmail || 'aktif'}${report.credits !== null ? ` (${report.credits} kredi)` : ''}`
            : 'kapalı — `gflow auth login` çalıştırın') +
          '\n'
      );
    });

  program
    .command('schema')
    .alias('agent-info')
    .description(
      'AI ajanları için tüm komut, parametre, model, çıkış kodu ve güvenlik kurallarını tek JSON/Markdown şemasında döner'
    )
    .option('--markdown', 'Kısa Markdown özet olarak yazdır (varsayılan JSON)')
    .action((opts) => {
      const schema = {
        ok: true,
        tool: 'gflow',
        purpose:
          'Google AI Flow CLI for free image generation (0 credits), credit-guarded video generation, reference image uploads, and SQLite asset catalog with unique IDs.',
        exitCodes: EXIT_CODES,
        safetyRules: [
          'ALWAYS pass --json when calling gflow from an agent.',
          'Video generation (`video`, `animate`) and >0 credit image tiers (`-q 4k`) MUST run with `--dry-run --json` first.',
          'NEVER pass `--confirm-credits` until the user explicitly approves the estimated credit cost.',
          'Browser runs headless by default; pass `--headed` only when the user wants to watch.',
          'Google Flow Agent Mode is OFF by default; pass `--agent-mode` only if requested.',
          'Auto-prune is OFF by default; pass `--ttl <duration>` (e.g. 5m, 24h, 7d) for temporary files.'
        ],
        enums: {
          imageAspectRatios: IMAGE_ASPECT_RATIOS,
          videoAspectRatios: VIDEO_ASPECT_RATIOS,
          imageQualities: IMAGE_QUALITIES,
          videoQualities: VIDEO_QUALITIES,
          models: listModels().map((m) => ({
            id: m.id,
            displayName: m.displayName,
            type: m.type,
            baseCredits: m.baseCredits,
            aliases: m.aliases
          }))
        },
        referenceUploads: {
          supportedFlags: ['--ref <pathOrId...>', '--first-frame <pathOrId>', '--last-frame <pathOrId>'],
          accepts: [
            'Absolute or relative local file path (e.g. C:/path/to/photo.png)',
            'Existing gflow catalog ID (e.g. img_0001)',
            'Multiple references via repeated --ref flags or comma-separated values'
          ]
        },
        commands: [
          {
            name: 'gflow auth status --json',
            when: 'Check if Google session is active before first generation.'
          },
          {
            name: 'gflow image -p "<prompt>" [--prompt-file prompt.txt] [--preset youtube-thumb|product-studio|cinematic|shorts|character-sheet|ui-icon] [-m nano-banana|nano-banana-pro|imagen-4] [-a 16:9] [-q standard|high] [-n 1-4] [--ref <pathOrId>] [--ttl 5m] [--dedupe] [--write-meta] [--headed] [--agent-mode] --json',
            when: 'Generate 0-credit images (supports presets, prompt files, reference uploads, and idempotency cache).'
          },
          {
            name: 'gflow batch <manifest.json> [--dry-run] [--resume] [--dedupe] [--confirm-credits] --json',
            when: 'Run bulk image/video generation from a JSON manifest with lock-file resume and total credit guard.'
          },
          {
            name: 'gflow preset list | show <name> | save <name> | delete <name> --json',
            when: 'Manage reusable style/model/aspect presets (builtin and custom).'
          },
          {
            name: 'gflow video -p "<prompt>" [--prompt-file scene.md] [-m veo-3.1-lite] [-a 16:9] [-q 720p] [--first-frame <pathOrId>] [--last-frame <pathOrId>] [--ref <pathOrId>] --dry-run --json',
            when: 'Estimate video credit cost BEFORE asking user approval; re-run with --confirm-credits after approval.'
          },
          {
            name: 'gflow animate <imgId> -p "<motion prompt>" --dry-run --json',
            when: 'Animate an existing catalog image into video (requires user credit approval).'
          },
          {
            name: 'gflow remix <id> [--append-prompt "..."] [-a 9:16] [--use-as-ref] --json',
            when: 'Create a variation from an existing catalog ID with parent-child lineage.'
          },
          {
            name: 'gflow list | show <id> | search <query> | tag <id> | copy <id> <dest> | export -o <dir> | prune | stats --json',
            when: 'Inspect, search, organize, copy, export, or safely clean up unmoved expired assets.'
          }
        ]
      };

      if (opts.markdown) {
        const lines = [
          '# gflow Agent Quick Reference',
          '',
          '## Rules',
          ...schema.safetyRules.map((r) => `- ${r}`),
          '',
          '## Reference Uploads',
          `- Flags: ${schema.referenceUploads.supportedFlags.join(', ')}`,
          '- Accepts local file paths OR catalog IDs (`img_0001`), single or multiple.',
          '',
          '## Commands',
          ...schema.commands.map((cmd) => `- \`${cmd.name}\` — ${cmd.when}`)
        ];
        process.stdout.write(lines.join('\n') + '\n');
        return;
      }

      printJson(schema);
    });
}
