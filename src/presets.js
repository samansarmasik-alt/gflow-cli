import fs from 'node:fs';
import { ensureDirs } from './config.js';

export const BUILTIN_PRESETS = {
  'youtube-thumb': {
    name: 'youtube-thumb',
    builtin: true,
    type: 'image',
    model: 'nano-banana-pro',
    aspect: '16:9',
    quality: 'high',
    count: 2,
    promptSuffix:
      'vibrant high-contrast YouTube thumbnail composition, dramatic studio rim lighting, sharp focal subject, clean readable background',
    negative: 'blurry, cluttered text, watermark, low resolution',
    tags: ['youtube', 'thumbnail']
  },
  'product-studio': {
    name: 'product-studio',
    builtin: true,
    type: 'image',
    model: 'nano-banana-pro',
    aspect: '1:1',
    quality: 'high',
    count: 2,
    promptSuffix:
      'commercial studio product photography, softbox lighting, subtle contact shadow, clean minimalist backdrop, 85mm lens, hyper sharp',
    negative: 'clutter, watermark, text overlay, distorted geometry',
    tags: ['product', 'studio']
  },
  cinematic: {
    name: 'cinematic',
    builtin: true,
    type: 'image',
    model: 'nano-banana-pro',
    aspect: '16:9',
    quality: 'high',
    count: 1,
    promptSuffix:
      'cinematic anamorphic film still, 35mm subtle grain, atmospheric volumetric lighting, shallow depth of field, movie color grading',
    negative: 'cartoon, oversaturated, plastic skin, watermark',
    tags: ['cinematic']
  },
  shorts: {
    name: 'shorts',
    builtin: true,
    type: 'image',
    model: 'nano-banana',
    aspect: '9:16',
    quality: 'high',
    count: 2,
    promptSuffix:
      'vertical 9:16 mobile-first visual composition, crisp subject separation, vibrant modern lighting',
    negative: 'horizontal crop, blurry, watermark',
    tags: ['shorts', 'vertical']
  },
  'character-sheet': {
    name: 'character-sheet',
    builtin: true,
    type: 'image',
    model: 'nano-banana-pro',
    aspect: '16:9',
    quality: 'high',
    count: 1,
    promptSuffix:
      'character design reference sheet showing front view, side profile, and 3/4 view of the exact same character side by side on a clean neutral studio background, consistent outfit and facial features',
    negative: 'inconsistent face, cropped head, busy background, text labels',
    tags: ['character', 'reference-sheet']
  },
  'ui-icon': {
    name: 'ui-icon',
    builtin: true,
    type: 'image',
    model: 'nano-banana',
    aspect: '1:1',
    quality: 'standard',
    count: 2,
    promptSuffix:
      'minimalist modern app icon design, centered balanced geometry, crisp edges, high contrast, subtle depth',
    negative: 'photographic noise, tiny unreadable text, busy background',
    tags: ['ui', 'icon']
  }
};

function loadUserPresets() {
  const { presetsFile } = ensureDirs();
  if (!fs.existsSync(presetsFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(presetsFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveUserPresets(map) {
  const { presetsFile } = ensureDirs();
  const tmp = `${presetsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, presetsFile);
}

export function listPresets() {
  const user = loadUserPresets();
  const merged = { ...BUILTIN_PRESETS };
  for (const [k, v] of Object.entries(user)) {
    merged[k] = { ...v, name: k, builtin: false };
  }
  return Object.values(merged);
}

export function getPreset(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  const user = loadUserPresets();
  if (user[key]) return { ...user[key], name: key, builtin: false };
  if (BUILTIN_PRESETS[key]) return { ...BUILTIN_PRESETS[key] };
  return null;
}

export function savePreset(name, spec) {
  const key = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-');
  if (!key) throw new Error('Geçersiz preset adı.');

  const user = loadUserPresets();
  const entry = {
    name: key,
    type: spec.type || 'image',
    model: spec.model || null,
    aspect: spec.aspect || null,
    quality: spec.quality || null,
    count: spec.count ? Number(spec.count) : null,
    promptPrefix: spec.promptPrefix || null,
    promptSuffix: spec.promptSuffix || null,
    negative: spec.negative || null,
    project: spec.project || null,
    tags: Array.isArray(spec.tags)
      ? spec.tags
      : spec.tags
        ? String(spec.tags).split(',').map((t) => t.trim()).filter(Boolean)
        : []
  };

  user[key] = entry;
  saveUserPresets(user);
  return { ...entry, builtin: false };
}

export function deletePreset(name) {
  const key = String(name || '').trim().toLowerCase();
  const user = loadUserPresets();
  if (!user[key]) {
    if (BUILTIN_PRESETS[key]) {
      throw new Error(`"${key}" yerleşik bir presettir, silinemez (üzerine kaydederek özelleştirebilirsiniz).`);
    }
    return false;
  }
  delete user[key];
  saveUserPresets(user);
  return true;
}

export function applyPresetToOptions(opts, preset) {
  if (!preset) return opts;
  const merged = { ...opts };

  if (!merged.model && preset.model) merged.model = preset.model;
  if (!merged.aspect && preset.aspect) merged.aspect = preset.aspect;
  if (!merged.quality && preset.quality) merged.quality = preset.quality;
  if (merged.count === undefined && preset.count) merged.count = preset.count;
  if (!merged.negative && preset.negative) merged.negative = preset.negative;
  if (!merged.project && preset.project) merged.project = preset.project;

  const basePrompt = String(merged.prompt || '').trim();
  const parts = [];
  if (preset.promptPrefix) parts.push(preset.promptPrefix.trim());
  if (basePrompt) parts.push(basePrompt);
  if (preset.promptSuffix) parts.push(preset.promptSuffix.trim());
  merged.prompt = parts.join(', ');

  const presetTags = Array.isArray(preset.tags) ? preset.tags : [];
  const cliTags = merged.tag
    ? String(merged.tag).split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const combinedTags = [...new Set([...presetTags, ...cliTags])];
  if (combinedTags.length) merged.tag = combinedTags.join(',');

  return merged;
}
