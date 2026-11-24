import crypto from 'node:crypto';

/**
 * Seeded PRNG (Mulberry32) + FNV-1a string hash.
 * Her çalıştırmada rastgele bir seed seçilir (veya --human-seed ile verilir)
 * ve o seed'e özel tutarlı bir insan fare/klavye profili (persona) üretilir.
 */
export function normalizeSeed(rawSeed) {
  if (rawSeed === undefined || rawSeed === null || rawSeed === '') {
    return crypto.randomBytes(4).readUInt32BE(0);
  }
  const asNum = Number(rawSeed);
  if (Number.isInteger(asNum) && asNum >= 0 && asNum <= 0xffffffff) {
    return asNum >>> 0;
  }
  // String seed → FNV-1a 32-bit hash
  let h = 0x811c9dc5;
  const s = String(rawSeed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createPrng(seedUint32) {
  let state = seedUint32 >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  return uu * u * p0 + 3 * uu * t * p1 + 3 * u * tt * p2 + tt * t * p3;
}

// Fitts's Law benzeri ease-in-out hız eğrisi
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createHumanizer({ seed = null, enabled = true } = {}) {
  const resolvedSeed = normalizeSeed(seed);
  const rand = createPrng(resolvedSeed);

  const range = (min, max) => min + rand() * (max - min);
  const intRange = (min, max) => Math.floor(range(min, max + 1));

  // Yaklaşık normal (çan eğrisi) dağılım: 3 uniform ortalaması
  const bell = (min, max) => {
    const u = (rand() + rand() + rand()) / 3;
    return min + u * (max - min);
  };

  // Seed'e özel tutarlı insan profili (her çalıştırmada farklı bir insan ritmi)
  const persona = {
    seed: resolvedSeed,
    curveFactor: Number(range(0.14, 0.36).toFixed(3)),
    jitterPx: Number(range(0.6, 2.2).toFixed(2)),
    overshootChance: Number(range(0.15, 0.42).toFixed(2)),
    clickHoldMinMs: intRange(38, 65),
    clickHoldMaxMs: intRange(85, 145),
    stepDelayMinMs: intRange(6, 12),
    stepDelayMaxMs: intRange(15, 26),
    typingBaseMs: intRange(18, 42),
    pauseScale: Number(range(0.85, 1.3).toFixed(2))
  };

  let cursor = {
    x: intRange(240, 960),
    y: intRange(180, 620)
  };

  async function sleep(ms) {
    if (!enabled || ms <= 0) return;
    await new Promise((r) => setTimeout(r, Math.round(ms)));
  }

  async function pause(minMs = 180, maxMs = 520) {
    if (!enabled) return;
    const ms = bell(minMs, maxMs) * persona.pauseScale;
    await sleep(ms);
  }

  /**
   * Başlangıç noktasından hedefe kübik Bézier + overshoot + jitter içeren
   * yol noktalarını üretir (test edilebilir saf fonksiyon).
   */
  function generateMousePath(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 4) {
      return [{ x: to.x, y: to.y, delayMs: intRange(8, 18) }];
    }

    const steps = Math.max(10, Math.min(42, Math.round(dist / range(16, 28))));

    // Eğri için dikey normal vektörü + seed bazlı kavis yönü
    const perpX = -dy / dist;
    const perpY = dx / dist;
    const sign = rand() < 0.5 ? 1 : -1;
    const spread = dist * persona.curveFactor * range(0.6, 1.35) * sign;

    const cp1 = {
      x: from.x + dx * range(0.22, 0.38) + perpX * spread * range(0.6, 1.1),
      y: from.y + dy * range(0.22, 0.38) + perpY * spread * range(0.6, 1.1)
    };
    const cp2 = {
      x: from.x + dx * range(0.62, 0.82) + perpX * spread * range(0.2, 0.7),
      y: from.y + dy * range(0.62, 0.82) + perpY * spread * range(0.2, 0.7)
    };

    // Uzun hareketlerde hedefi hafifçe geçip geri düzeltme (overshoot)
    const doOvershoot = dist > 120 && rand() < persona.overshootChance;
    const overshootTarget = doOvershoot
      ? {
          x: to.x + (dx / dist) * range(6, 18) + range(-4, 4),
          y: to.y + (dy / dist) * range(6, 18) + range(-4, 4)
        }
      : to;

    const points = [];
    for (let i = 1; i <= steps; i++) {
      const rawT = i / steps;
      const t = easeInOutCubic(rawT);
      // Başta ve sonda jitter sıfıra yaklaşır, ortada hafif el titremesi olur
      const jitterFade = Math.sin(Math.PI * rawT);
      const jx = (rand() * 2 - 1) * persona.jitterPx * jitterFade;
      const jy = (rand() * 2 - 1) * persona.jitterPx * jitterFade;

      const x = cubicBezier(from.x, cp1.x, cp2.x, overshootTarget.x, t) + jx;
      const y = cubicBezier(from.y, cp1.y, cp2.y, overshootTarget.y, t) + jy;
      const delayMs = Math.round(bell(persona.stepDelayMinMs, persona.stepDelayMaxMs));
      points.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, delayMs });
    }

    if (doOvershoot) {
      const fixSteps = intRange(4, 7);
      for (let i = 1; i <= fixSteps; i++) {
        const t = easeInOutCubic(i / fixSteps);
        const x = overshootTarget.x + (to.x - overshootTarget.x) * t;
        const y = overshootTarget.y + (to.y - overshootTarget.y) * t;
        points.push({
          x: Math.round(x * 10) / 10,
          y: Math.round(y * 10) / 10,
          delayMs: intRange(10, 22)
        });
      }
    }

    return points;
  }

  async function moveTo(page, targetX, targetY) {
    if (!enabled) {
      cursor = { x: targetX, y: targetY };
      return;
    }
    const pts = generateMousePath(cursor, { x: targetX, y: targetY });
    for (const pt of pts) {
      await page.mouse.move(pt.x, pt.y).catch(() => {});
      await sleep(pt.delayMs);
    }
    cursor = { x: targetX, y: targetY };
  }

  async function clickLocator(page, locator) {
    if (!enabled) {
      await locator.click();
      return;
    }

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox().catch(() => null);
    if (!box || box.width < 2 || box.height < 2) {
      await pause(80, 180);
      await locator.click();
      return;
    }

    // Tam merkez yerine kutunun iç %22-%78 bölgesinde doğal tıklama noktası
    const tx = box.x + box.width * bell(0.22, 0.78);
    const ty = box.y + box.height * bell(0.22, 0.78);

    await moveTo(page, tx, ty);
    await sleep(bell(45, 130));
    await page.mouse.down();
    await sleep(bell(persona.clickHoldMinMs, persona.clickHoldMaxMs));
    await page.mouse.up();
    await pause(120, 320);
  }

  /**
   * Doğal insan ritminde metin girişi.
   * Kısa metinlerde karakter karakter; uzun promptlarda doğal 2-5 karakterlik
   * akıcı gruplarla + noktalama/boşluk sonrası mikro duraksamalarla yazar.
   */
  async function typeText(page, locator, text) {
    await clickLocator(page, locator);

    if (!enabled) {
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.insertText(text);
      return;
    }

    await sleep(bell(70, 160));
    await page.keyboard.press('Control+A').catch(() => {});
    await sleep(bell(40, 100));
    await page.keyboard.press('Backspace').catch(() => {});
    await sleep(bell(90, 220));

    const str = String(text);
    const chunkMode = str.length > 90;
    let i = 0;

    while (i < str.length) {
      const step = chunkMode ? intRange(2, 5) : 1;
      const chunk = str.slice(i, i + step);
      await page.keyboard.insertText(chunk);
      i += chunk.length;

      let delay = bell(persona.typingBaseMs * 0.6, persona.typingBaseMs * 1.45);
      if (/[.,;:!?\n]/.test(chunk)) {
        delay += bell(70, 190);
      } else if (/\s/.test(chunk)) {
        delay += bell(15, 55);
      } else if (rand() < 0.04) {
        // Arada çok kısa düşünme molası
        delay += bell(90, 210);
      }
      await sleep(delay);
    }

    await pause(180, 420);
  }

  async function idleWander(page) {
    if (!enabled) return;
    const dx = range(-80, 80);
    const dy = range(-50, 50);
    const nx = Math.max(80, Math.min(1300, cursor.x + dx));
    const ny = Math.max(80, Math.min(820, cursor.y + dy));
    await moveTo(page, nx, ny);
  }

  return {
    enabled: Boolean(enabled),
    seed: resolvedSeed,
    persona,
    getCursor: () => ({ ...cursor }),
    generateMousePath,
    pause,
    moveTo,
    clickLocator,
    typeText,
    idleWander
  };
}
