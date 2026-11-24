/**
 * Google Flow model kataloğu, doğrulama ve kredi hesaplama motoru.
 * Not: Google Flow kredi politikaları zamanla değişebilir; bu tablo
 * güvenli tahmin + doğrulama içindir. Canlı oturumda gerçek kredi
 * değeri DOM'dan da okunur.
 */

export const IMAGE_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'];
export const VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];

export const IMAGE_QUALITIES = ['low', 'standard', 'medium', 'high', '1k', '2k', '4k'];
export const VIDEO_QUALITIES = ['360p', '720p', '1080p', '4k'];

export const MODEL_CATALOG = {
  // --- IMAGE MODELS ---
  'nano-banana': {
    id: 'nano-banana',
    displayName: 'Nano Banana',
    aliases: ['nano', 'nb', 'banana', 'free', 'auto'],
    type: 'image',
    uiLabels: ['Nano Banana', 'Nano Banana 2', 'Imagen'],
    baseCredits: 0,
    qualityMultiplier: { standard: 0, high: 0, '1k': 0, '2k': 0, '4k': 5 },
    aspectRatios: IMAGE_ASPECT_RATIOS,
    maxCount: 4,
    notes: 'Ücretsiz / 0 kredi hızlı fotoğraf üretimi (4K upscale hariç).'
  },
  'nano-banana-2.1': {
    id: 'nano-banana-2.1',
    displayName: 'Nano Banana 2.1',
    aliases: ['2.1', 'nb-2.1', 'nb2.1', 'banana-2.1', 'nanobanana-2.1'],
    type: 'image',
    uiLabels: ['Nano Banana 2.1'],
    baseCredits: 0,
    qualityMultiplier: { low: 0, standard: 0, medium: 0, high: 0, '1k': 0, '2k': 0, '4k': 5 },
    aspectRatios: IMAGE_ASPECT_RATIOS,
    maxCount: 4,
    notes: 'Google Flow Nano Banana 2.1 modeli (0 kredi / ücretsiz, 4K upscale hariç).'
  },
  'nano-banana-pro': {
    id: 'nano-banana-pro',
    displayName: 'Nano Banana Pro',
    aliases: ['nb-pro', 'banana-pro', 'pro'],
    type: 'image',
    uiLabels: ['Nano Banana Pro'],
    baseCredits: 0,
    qualityMultiplier: { standard: 0, high: 0, '1k': 0, '2k': 2, '4k': 5 },
    aspectRatios: IMAGE_ASPECT_RATIOS,
    maxCount: 4,
    notes: 'Yüksek detay, tipografi ve tutarlılık odaklı fotoğraf modeli.'
  },
  'imagen-4': {
    id: 'imagen-4',
    displayName: 'Imagen 4',
    aliases: ['imagen', 'imagen4', 'img4'],
    type: 'image',
    uiLabels: ['Imagen 4', 'Imagen 3', 'Imagen'],
    baseCredits: 0,
    qualityMultiplier: { standard: 0, high: 0, '1k': 0, '2k': 0, '4k': 5 },
    aspectRatios: IMAGE_ASPECT_RATIOS,
    maxCount: 4,
    notes: 'Fotogerçekçi Google Imagen serisi.'
  },

  // --- VIDEO MODELS ---
  'veo-3.1-lite': {
    id: 'veo-3.1-lite',
    displayName: 'Veo 3.1 Lite',
    aliases: ['veo', 'veo-lite', 'veo3', 'lite'],
    type: 'video',
    uiLabels: ['Veo 3.1 Lite', 'Veo 3.1 - Lite', 'Veo Lite'],
    baseCredits: 10,
    perSecond: false,
    qualityCredits: { '360p': 5, '720p': 10, '1080p': 20, '4k': 40 },
    aspectRatios: VIDEO_ASPECT_RATIOS,
    durations: [5, 8],
    maxCount: 4,
    supportsAudio: true,
    notes: 'Standart 720p video modeli (~10 kredi / klip).'
  },
  'veo-3.1-fast': {
    id: 'veo-3.1-fast',
    displayName: 'Veo 3.1 Fast',
    aliases: ['veo-fast', 'fast'],
    type: 'video',
    uiLabels: ['Veo 3.1 - Fast', 'Veo 3.1 Fast', 'Veo Fast'],
    baseCredits: 20,
    perSecond: false,
    qualityCredits: { '360p': 10, '720p': 20, '1080p': 30, '4k': 50 },
    aspectRatios: VIDEO_ASPECT_RATIOS,
    durations: [5, 8],
    maxCount: 4,
    supportsAudio: true,
    notes: 'Hızlı yüksek kaliteli Veo modeli (~20 kredi / klip).'
  },
  'veo-3.1-quality': {
    id: 'veo-3.1-quality',
    displayName: 'Veo 3.1 Quality',
    aliases: ['veo-quality', 'quality', 'veo-hq'],
    type: 'video',
    uiLabels: ['Veo 3.1 - Quality', 'Veo 3.1 Quality', 'Veo Quality'],
    baseCredits: 100,
    perSecond: false,
    qualityCredits: { '360p': 50, '720p': 100, '1080p': 100, '4k': 150 },
    aspectRatios: VIDEO_ASPECT_RATIOS,
    durations: [5, 8],
    maxCount: 4,
    supportsAudio: true,
    notes: 'Sinematik en yüksek kalite (~100 kredi / klip).'
  },
  'omni-flash-1.2': {
    id: 'omni-flash-1.2',
    displayName: 'Omni Flash 1.2',
    aliases: ['omni', 'omni-flash', 'flash'],
    type: 'video',
    uiLabels: ['Omni Flash 1.2', 'Omni Flash'],
    baseCredits: 3,
    perSecond: true,
    qualityCreditsPerSec: { '360p': 1, '720p': 3, '1080p': 5, '4k': 10 },
    aspectRatios: VIDEO_ASPECT_RATIOS,
    durations: [3, 5, 8, 10],
    maxCount: 4,
    supportsAudio: true,
    notes: 'Süre bazlı kredi (360p: 1 kredi/sn, 720p: 3 kredi/sn).'
  }
};

export function resolveModel(nameOrAlias, expectedType = null) {
  if (!nameOrAlias) return null;
  const needle = String(nameOrAlias).trim().toLowerCase();

  for (const model of Object.values(MODEL_CATALOG)) {
    if (expectedType && model.type !== expectedType) continue;
    if (
      model.id === needle ||
      model.displayName.toLowerCase() === needle ||
      (model.aliases && model.aliases.includes(needle))
    ) {
      return model;
    }
  }
  return null;
}

export function listModels(type = null) {
  return Object.values(MODEL_CATALOG).filter((m) => !type || m.type === type);
}

export function normalizeAspectRatio(aspect, type) {
  const allowed = type === 'video' ? VIDEO_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS;
  const cleaned = String(aspect || (type === 'video' ? '16:9' : '16:9'))
    .trim()
    .toLowerCase()
    .replace('x', ':')
    .replace('/', ':');

  const aliases = {
    square: '1:1',
    kare: '1:1',
    landscape: '16:9',
    yatay: '16:9',
    wide: '16:9',
    portrait: '9:16',
    dikey: '9:16',
    vertical: '9:16',
    classic: '4:3',
    photo: '3:2'
  };

  const resolved = aliases[cleaned] || cleaned;
  if (!allowed.includes(resolved)) {
    throw new Error(
      `Geçersiz en-boy oranı (${type}): "${aspect}". Desteklenenler: ${allowed.join(', ')}`
    );
  }
  return resolved;
}

export function normalizeQuality(quality, type) {
  const allowed = type === 'video' ? VIDEO_QUALITIES : IMAGE_QUALITIES;
  const cleaned = String(quality || (type === 'video' ? '720p' : 'standard'))
    .trim()
    .toLowerCase();

  if (!allowed.includes(cleaned)) {
    throw new Error(
      `Geçersiz kalite (${type}): "${quality}". Desteklenenler: ${allowed.join(', ')}`
    );
  }
  return cleaned;
}

export function estimateCredits({ type, modelId, quality, count = 1, duration = 5 }) {
  const model = resolveModel(modelId, type);
  if (!model) {
    throw new Error(`Bilinmeyen ${type} modeli: "${modelId}". Listelemek için: gflow models`);
  }

  const safeCount = Math.max(1, Math.min(model.maxCount || 4, Number(count) || 1));
  const safeQuality = normalizeQuality(quality, type);
  const safeDuration = Number(duration) || 5;

  let perItem = 0;
  let formula = '';

  if (type === 'image') {
    const qCost = model.qualityMultiplier?.[safeQuality] ?? model.baseCredits;
    perItem = qCost;
    formula = perItem === 0
      ? `0 kredi (${model.displayName} / ${safeQuality})`
      : `${perItem} kredi x ${safeCount} adet`;
  } else {
    if (model.perSecond) {
      const rate = model.qualityCreditsPerSec?.[safeQuality] ?? model.baseCredits;
      perItem = rate * safeDuration;
      formula = `${rate} kredi/sn x ${safeDuration}sn x ${safeCount} klip`;
    } else {
      perItem = model.qualityCredits?.[safeQuality] ?? model.baseCredits;
      formula = `${perItem} kredi x ${safeCount} klip (${safeQuality})`;
    }
  }

  const total = perItem * safeCount;
  return {
    model: model.id,
    displayName: model.displayName,
    type,
    quality: safeQuality,
    count: safeCount,
    duration: type === 'video' ? safeDuration : null,
    creditsPerItem: perItem,
    estimatedTotalCredits: total,
    isFree: total === 0,
    requiresConfirmation: type === 'video' || total > 0,
    formula
  };
}
