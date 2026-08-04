const { createSlug, durationToMinutes } = require('./tourHelpers');

const CONTENT_FIELDS = [
  'title',
  'description',
  'coverPhoto',
  'photos',
  'tags',
  'metaTitle',
  'metaDescription',
  'categorization',
  'theme',
  'productContent',
  'schedulesAndPricing',
  'bookingAndTickets',
];

function tourContentSnapshot(tour) {
  return {
    title: tour.title,
    description: tour.description,
    coverPhoto: tour.coverPhoto ?? null,
    photos: tour.photos || [],
    tags: tour.tags || [],
    metaTitle: tour.metaTitle ?? null,
    metaDescription: tour.metaDescription ?? null,
    categorization: tour.categorization,
    theme: tour.theme,
    productContent: tour.productContent,
    schedulesAndPricing: tour.schedulesAndPricing,
    bookingAndTickets: tour.bookingAndTickets,
  };
}

function mergeDraftContent(liveRow, draftContent) {
  const snapshot = tourContentSnapshot(liveRow);
  if (!draftContent || typeof draftContent !== 'object') return snapshot;
  return {
    ...snapshot,
    ...Object.fromEntries(CONTENT_FIELDS.map((f) => [f, draftContent[f] !== undefined ? draftContent[f] : snapshot[f]])),
  };
}

function truncate(value, max = 400) {
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === 'object') return '[object]';
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}...` : value;
  return value;
}

function buildTourDiff(live, draft, maxDepth = 4) {
  const liveSrc = live || {};
  const draftSrc = draft || {};
  const diffs = [];
  const record = (path, kind, before, after) => diffs.push({ path, kind, before, after });

  if (JSON.stringify(liveSrc.photos || []) !== JSON.stringify(draftSrc.photos || [])) {
    const oldSet = new Set(liveSrc.photos || []);
    const newSet = new Set(draftSrc.photos || []);
    const added = (draftSrc.photos || []).filter((p) => !oldSet.has(p));
    const removed = (liveSrc.photos || []).filter((p) => !newSet.has(p));
    if (added.length || removed.length) {
      record('photos', 'changed', `${removed.length} removed`, `${added.length} added`);
    }
  }

  const walk = (a, b, path, depth) => {
    if (a === b) return;
    if (a === undefined || a === null) {
      record(path, 'added', undefined, truncate(b));
      return;
    }
    if (b === undefined || b === null) {
      record(path, 'removed', truncate(a), undefined);
      return;
    }
    const aObj = typeof a === 'object' && a !== null;
    const bObj = typeof b === 'object' && b !== null;
    if (aObj && bObj) {
      const aArr = Array.isArray(a);
      const bArr = Array.isArray(b);
      if (aArr && bArr) {
        const len = Math.max(a.length, b.length);
        for (let i = 0; i < len; i += 1) walk(a[i], b[i], `${path}[${i}]`, depth + 1);
        return;
      }
      if (aArr !== bArr) {
        record(path, 'changed', truncate(a), truncate(b));
        return;
      }
      if (depth >= maxDepth) {
        if (JSON.stringify(a) !== JSON.stringify(b)) record(path, 'changed', truncate(a), truncate(b));
        return;
      }
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) walk(a[key], b[key], path ? `${path}.${key}` : key, depth + 1);
      return;
    }
    record(path, 'changed', truncate(a), truncate(b));
  };

  for (const field of CONTENT_FIELDS) {
    if (field === 'photos') continue;
    walk(liveSrc[field], draftSrc[field], field, 0);
  }

  return diffs;
}

function computeChangesSummary(diff) {
  const sections = {};
  for (const entry of diff) {
    const section = String(entry.path).split(/[.[]/)[0] || 'other';
    if (!sections[section]) sections[section] = [];
    sections[section].push(entry.path);
  }
  return {
    count: diff.length,
    sections: Object.keys(sections).map((name) => ({ section: name, changes: sections[name].length, paths: sections[name] })),
  };
}

function parseJson(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value || null;
}

async function buildLiveUpdateData(tx, liveRow, draftContent) {
  const merged = mergeDraftContent(liveRow, draftContent);

  const updateData = {
    title: merged.title,
    description: merged.description,
    coverPhoto: merged.coverPhoto,
    photos: merged.photos,
    tags: merged.tags,
    metaTitle: merged.metaTitle,
    metaDescription: merged.metaDescription,
    categorization: merged.categorization,
    theme: merged.theme,
    productContent: merged.productContent,
    schedulesAndPricing: merged.schedulesAndPricing,
    bookingAndTickets: merged.bookingAndTickets,
  };

  const cat = parseJson(merged.categorization);
  if (cat && typeof cat === 'object') {
    updateData.category = cat.category || null;
    updateData.subcategory = cat.subcategory || null;
    updateData.activityType = cat.activityType || null;
    updateData.difficulty = cat.difficulty || null;
    updateData.durationMinutes = durationToMinutes(cat.duration);
  }

  const th = parseJson(merged.theme);
  if (th && typeof th === 'object') {
    updateData.primaryTheme = th.primaryTheme || th.primary || null;
  }

  const pc = parseJson(merged.productContent);
  const firstLoc = Array.isArray(pc && pc.locations) ? pc.locations[0] : (pc && pc.location) || null;
  updateData.city = firstLoc ? firstLoc.city || null : null;
  updateData.country = firstLoc ? firstLoc.country || null : null;
  updateData.region = firstLoc ? firstLoc.region || null : null;

  if (merged.title && merged.title !== liveRow.title) {
    updateData.slug = await createSlug(merged.title, tx);
  }

  return updateData;
}

module.exports = {
  CONTENT_FIELDS,
  tourContentSnapshot,
  mergeDraftContent,
  buildTourDiff,
  computeChangesSummary,
  buildLiveUpdateData,
};
