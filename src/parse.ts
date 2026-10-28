import { MakerWorldError } from './errors.js';

export interface ModelRef { id: number; profileId?: number }

export function parseModelRef(input: string): ModelRef {
  const s = input.trim();
  if (/^\d+$/.test(s)) return { id: Number(s) };
  let url: URL;
  try { url = new URL(s); } catch { throw invalid(input); }
  if (!/(^|\.)makerworld\.com$/.test(url.hostname)) throw invalid(input);
  const m = url.pathname.match(/\/models\/(\d+)/);
  if (!m) throw invalid(input);
  const ref: ModelRef = { id: Number(m[1]) };
  const p = url.hash.match(/profileId-(\d+)/);
  if (p) ref.profileId = Number(p[1]);
  return ref;
}

function invalid(input: string): MakerWorldError {
  return new MakerWorldError('INVALID_INPUT', `Not a MakerWorld model id or URL: "${input}". Use a number like 1400000 or https://makerworld.com/en/models/1400000-...`);
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface Filament { type: string; color: string; grams: number }
export interface Profile {
  id: number; title: string; isDefault: boolean;
  printer?: string; nozzle?: number; printSeconds?: number; weightG?: number;
  filaments: Filament[]; pictureUrls: string[];
}
export interface Design {
  id: number; slug: string; title: string; url: string; coverUrl: string;
  creator: { uid: number; name: string };
  descriptionHtml: string; tags: string[]; categories: string[]; license: string;
  stats: { likes: number; downloads: number; prints: number; collections: number };
  pictureUrls: string[]; defaultProfileId?: number; profiles: Profile[];
}

type Json = Record<string, any>;
const urls = (pics: unknown): string[] =>
  Array.isArray(pics) ? pics.map((p: Json) => p?.url).filter((u): u is string => typeof u === 'string' && u.length > 0) : [];

function parseProfile(i: Json): Profile {
  const compat = i.extention?.modelInfo?.compatibility ?? {};
  return {
    id: Number(i.id),
    title: String(i.title ?? ''),
    isDefault: Boolean(i.isDefault),
    printer: compat.devProductName || undefined,
    nozzle: typeof compat.nozzleDiameter === 'number' ? compat.nozzleDiameter : undefined,
    printSeconds: typeof i.prediction === 'number' && i.prediction > 0 ? i.prediction : undefined,
    weightG: typeof i.weight === 'number' && i.weight > 0 ? i.weight : undefined,
    filaments: (Array.isArray(i.instanceFilaments) ? i.instanceFilaments : []).map((f: Json) => ({
      type: String(f.type ?? ''), color: String(f.color ?? ''), grams: Number(f.usedG ?? 0),
    })),
    pictureUrls: urls(i.pictures),
  };
}

export function parseDesign(raw: unknown): Design {
  const d = raw as Json;
  if (!d || typeof d !== 'object' || typeof d.id !== 'number' || typeof d.title !== 'string') {
    throw new MakerWorldError('UPSTREAM_ERROR', `Unexpected design response: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  const slug = String(d.slug ?? '');
  return {
    id: d.id, slug, title: d.title,
    url: `https://makerworld.com/en/models/${d.id}${slug ? '-' + slug : ''}`,
    coverUrl: String(d.coverUrl ?? ''),
    creator: { uid: Number(d.designCreator?.uid ?? 0), name: String(d.designCreator?.name ?? '') },
    descriptionHtml: String(d.summary ?? ''),
    tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
    categories: Array.isArray(d.categories) ? d.categories.map((c: Json) => String(c.name)) : [],
    license: String(d.license ?? ''),
    stats: {
      likes: Number(d.likeCount ?? 0), downloads: Number(d.downloadCount ?? 0),
      prints: Number(d.printCount ?? 0), collections: Number(d.collectionCount ?? 0),
    },
    pictureUrls: urls(d.designExtension?.design_pictures),
    defaultProfileId: d.defaultInstanceId ? Number(d.defaultInstanceId) : undefined,
    profiles: (Array.isArray(d.instances) ? d.instances : []).map(parseProfile),
  };
}

const MAX_DESC = 4000;
function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function formatDesign(d: Design): string {
  let desc = htmlToText(d.descriptionHtml);
  if (desc.length > MAX_DESC) desc = desc.slice(0, MAX_DESC) + '…';
  const lines = [
    `# ${d.title}`,
    `ID: ${d.id}  URL: ${d.url}`,
    `Creator: ${d.creator.name} (uid ${d.creator.uid})`,
    `License: ${d.license}`,
    `Likes: ${d.stats.likes}  Downloads: ${d.stats.downloads}  Prints: ${d.stats.prints}  Collections: ${d.stats.collections}`,
    `Tags: ${d.tags.join(', ') || '(none)'}`,
    `Categories: ${d.categories.join(', ') || '(none)'}`,
    `Pictures: ${d.pictureUrls.length}`,
    '',
    '## Description',
    desc || '(none)',
    '',
    `## Print profiles (${d.profiles.length})`,
  ];
  if (!d.profiles.length) lines.push('None. Use download_model with format "stl" for the raw model files.');
  for (const p of d.profiles) {
    const bits = [
      p.printer && `printer ${p.printer}${p.nozzle ? ` ${p.nozzle}mm` : ''}`,
      p.printSeconds && `time ${fmtDuration(p.printSeconds)}`,
      p.weightG && `${p.weightG}g`,
      p.filaments.length && `filaments ${p.filaments.map((f) => `${f.type} ${f.color} ${f.grams}g`).join(', ')}`,
      `${p.pictureUrls.length} pictures`,
    ].filter(Boolean);
    const isDefault = p.id === d.defaultProfileId || p.isDefault ? ' [default]' : '';
    lines.push(`- ${p.id}${isDefault}: ${p.title} (${bits.join('; ')})`);
  }
  return lines.join('\n');
}

export function pickProfile(d: Design, requested?: number): Profile {
  if (!d.profiles.length) {
    throw new MakerWorldError('PROFILE_NOT_FOUND', `Model ${d.id} has no print profiles. Use format "stl" to download the raw model files.`);
  }
  const id = requested ?? d.defaultProfileId;
  const found = id === undefined ? undefined : d.profiles.find((p) => p.id === id);
  if (found) return found;
  if (requested !== undefined) {
    throw new MakerWorldError('PROFILE_NOT_FOUND', `Profile ${requested} not found on model ${d.id}. Valid profile ids: ${d.profiles.map((p) => p.id).join(', ')}`);
  }
  return d.profiles[0];
}

export function buildFilename(d: Design, format: '3mf' | 'stl', profileId?: number): string {
  const base = `${d.id}${d.slug ? '-' + d.slug : ''}`;
  return format === '3mf' ? `${base}-${profileId}.3mf` : `${base}.zip`;
}

export function resolveDownloadDir(destDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return destDir || env.MAKERWORLD_DOWNLOAD_DIR || '/tmp/makerworld';
}
