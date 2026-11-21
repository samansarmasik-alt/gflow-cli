import fs from 'node:fs';
import { getPaths, loadConfig } from '../config.js';
import { getSessionStatus, loginFlow } from '../flow-driver.js';
import { c, EXIT_CODES, printError, printJson } from '../output.js';

export function registerAuthCommands(program) {
  const auth = program
    .command('auth')
    .description('Google hesabı oturum yönetimi (Chrome CDP üzerinden güvenli giriş)');

  auth
    .command('login')
    .description('İzole Chrome profili açar ve Google AI Flow girişini bekler')
    .option('--timeout <seconds>', 'Giriş bekleme süresi (saniye)', '180')
    .option('--json', 'JSON çıktı ver')
    .action(async (opts) => {
      try {
        if (!opts.json) {
          process.stdout.write(
            `${c('cyan', '→')} Google Flow için izole Chrome penceresi açılıyor...\n` +
              `  Açılan pencerede Gmail hesabınızla giriş yapın. Giriş tamamlanınca CLI otomatik algılayacak.\n`
          );
        }
        const status = await loginFlow({ timeoutMs: Number(opts.timeout) * 1000 });
        if (opts.json) {
          printJson({ ok: status.authenticated, ...status });
          if (!status.authenticated) process.exitCode = EXIT_CODES.AUTH_REQUIRED;
          return;
        }
        if (status.authenticated) {
          process.stdout.write(
            `${c('green', '✓')} Giriş başarılı! Hesap: ${c('bold', status.email || '(algılandı)')}` +
              (status.credits !== null ? ` | Kredi: ${c('yellow', status.credits)}` : '') +
              '\n'
          );
        } else {
          printError('Giriş zaman aşımına uğradı veya tamamlanmadı.', {
            exitCode: EXIT_CODES.AUTH_REQUIRED,
            details: { hint: 'Açılan Chrome penceresinde Google hesabınıza giriş yapıp tekrar deneyin.' }
          });
        }
      } catch (err) {
        printError(err.message, { json: opts.json, exitCode: EXIT_CODES.BROWSER_ERROR });
      }
    });

  auth
    .command('status')
    .description('Aktif Google oturumu ve kredi bakiyesini kontrol eder')
    .option('--mock', 'Mock/test modunda çalıştır')
    .option('--json', 'JSON çıktı ver')
    .action(async (opts) => {
      try {
        const status = await getSessionStatus({ mock: opts.mock });
        if (opts.json) {
          printJson({ ok: status.authenticated, ...status });
          if (!status.authenticated) process.exitCode = EXIT_CODES.AUTH_REQUIRED;
          return;
        }
        if (status.authenticated) {
          process.stdout.write(`${c('green', '✓ Oturum aktif')}\n`);
          process.stdout.write(`  Hesap  : ${status.email || '(bilinmiyor)'}\n`);
          process.stdout.write(
            `  Kredi  : ${status.credits !== null ? c('yellow', status.credits) : '(okunamadı)'}\n`
          );
          process.stdout.write(`  URL    : ${status.url}\n`);
        } else {
          process.stdout.write(`${c('red', '✗ Oturum aktif değil')}\n`);
          process.stdout.write(`  Giriş yapmak için: ${c('cyan', 'gflow auth login')}\n`);
          process.exitCode = EXIT_CODES.AUTH_REQUIRED;
        }
      } catch (err) {
        printError(err.message, {
          json: opts.json,
          exitCode: EXIT_CODES.AUTH_REQUIRED,
          details: { hint: 'Önce `gflow auth login` ile Chrome oturumunu başlatın.' }
        });
      }
    });

  auth
    .command('logout')
    .description('İzole Chrome profilini ve kayıtlı oturum çerezlerini temizler')
    .option('--json', 'JSON çıktı ver')
    .action(async (opts) => {
      try {
        const { profileDir } = getPaths();
        if (fs.existsSync(profileDir)) {
          fs.rmSync(profileDir, { recursive: true, force: true });
        }
        const cfg = loadConfig();
        if (opts.json) {
          printJson({ ok: true, clearedProfile: profileDir, cdpPort: cfg.cdpPort });
        } else {
          process.stdout.write(
            `${c('green', '✓')} Oturum profili temizlendi: ${profileDir}\n` +
              `  Not: Eğer gflow Chrome penceresi hâlâ açıksa kapatın.\n`
          );
        }
      } catch (err) {
        printError(err.message, {
          json: opts.json,
          details: { hint: 'Açık gflow Chrome penceresini kapatıp tekrar deneyin.' }
        });
      }
    });
}
