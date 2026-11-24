const archiveSlug = '2026-11-22';
const phaseLabels = Object.freeze({
  ANNOUNCED: 'Анонсирован',
  OPEN: 'Приём заявок открыт',
  CLOSED: 'Приём заявок завершён',
  DRAWN: 'Завершён',
  CANCELLED: 'Отменён',
});
const legacyAnchors = new Set([
  '#prelaunch', '#prelaunch-heading', '#contest-view', '#show-stage', '#saved-result',
  '#reserve-order', '#rules-section', '#rules-heading', '#announcement-rules',
  '#announcement-rules-title', '#tickets-section', '#tickets-heading', '#ticket-details',
  '#archive-section', '#archive-heading', '#plan-hash', '#verification',
  '#verification-heading', '#calculation-details', '#method', '#method-heading',
]);
const displayDate = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});

function hasOnlyKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isDisplayText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isPublicSlug(value) {
  return value === archiveSlug
    || (typeof value === 'string' && value.length <= 64 && value === value.trim()
      && /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
      && isIsoDate(value.slice(0, 10)));
}

export function parseContestCatalog(value) {
  if (!hasOnlyKeys(value, ['schema_version', 'contests'])
      || value.schema_version !== 'meshdraw-contest-catalog-v1'
      || !Array.isArray(value.contests) || value.contests.length > 500) {
    throw new Error('CATALOG_FORMAT');
  }
  const seen = new Set();
  const contests = value.contests.map((contest) => {
    if (!hasOnlyKeys(contest, ['public_slug', 'title', 'prize', 'phase', 'date'])
        || !isPublicSlug(contest.public_slug)
        || seen.has(contest.public_slug) || !isDisplayText(contest.title, 150)
        || !isDisplayText(contest.prize, 160)
        || typeof contest.phase !== 'string' || !Object.hasOwn(phaseLabels, contest.phase)
        || !isIsoDate(contest.date)) {
      throw new Error('CATALOG_ENTRY');
    }
    seen.add(contest.public_slug);
    return contest;
  });
  const finished = (contest) => ['DRAWN', 'CANCELLED'].includes(contest.phase);
  return {
    current: contests.filter((contest) => !finished(contest)).sort((a, b) => a.date.localeCompare(b.date)),
    archived: contests.filter(finished).sort((a, b) => b.date.localeCompare(a.date)),
  };
}

export function legacyContestTarget(hash) {
  return legacyAnchors.has(hash) ? `./contests/${archiveSlug}/${hash}` : null;
}

function followLegacyAnchor() {
  const target = legacyContestTarget(window.location.hash);
  if (!target) return false;
  window.location.replace(new URL(target, import.meta.url));
  return true;
}

function renderContest(contest, archived) {
  const entry = document.getElementById('contest-entry').content.cloneNode(true);
  const article = entry.querySelector('article');
  article.querySelector('h3').textContent = contest.title;
  article.querySelector('.home-contest-prize').textContent = contest.prize;
  const date = article.querySelector('time');
  date.dateTime = contest.date;
  date.textContent = displayDate.format(new Date(`${contest.date}T00:00:00Z`));
  article.querySelector('.home-contest-meta span').textContent = phaseLabels[contest.phase];
  const link = article.querySelector('a');
  link.href = new URL(`./contests/${contest.public_slug}/`, import.meta.url);
  link.textContent = archived && contest.phase === 'DRAWN' ? 'Результат и проверка' : 'Страница конкурса';
  if (contest.public_slug === archiveSlug) {
    const image = document.createElement('img');
    image.className = 'home-contest-image';
    image.src = new URL('./contests/2026-11-22/assets/ax-865-14y.webp', import.meta.url);
    image.width = 1672;
    image.height = 941;
    image.alt = 'Антенна Яги Антэкс AX-865-14Y на опоре';
    image.decoding = 'async';
    article.classList.add('home-contest--illustrated');
    article.prepend(image);
  }
  return entry;
}

async function mountCatalog() {
  try {
    const response = await fetch(new URL('./contest-catalog.json', import.meta.url));
    if (!response.ok) throw new Error('CATALOG_HTTP');
    const { current, archived } = parseContestCatalog(await response.json());
    if (!archived.some((contest) => contest.public_slug === archiveSlug && contest.phase === 'DRAWN')) {
      throw new Error('CATALOG_ARCHIVE_REQUIRED');
    }
    const currentList = document.getElementById('current-contests');
    currentList.replaceChildren(...current.map((contest) => renderContest(contest, false)));
    currentList.hidden = current.length === 0;
    document.getElementById('current-empty').hidden = current.length !== 0;
    const archivedList = document.getElementById('archived-contests');
    archivedList.replaceChildren(...archived.map((contest) => renderContest(contest, true)));
  } catch {
    document.getElementById('current-empty').hidden = true;
    document.getElementById('catalog-feedback').hidden = false;
  }
}

if (typeof window !== 'undefined' && !followLegacyAnchor()) {
  window.addEventListener('hashchange', followLegacyAnchor);
  mountCatalog();
}
