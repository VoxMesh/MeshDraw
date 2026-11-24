const archiveSlug = '2026-11-22';
const visibleArchiveEntries = 6;
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

function hasOnlyKeys(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function isDisplayText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isPublicSlug(value) {
  return typeof value === 'string' && value.length <= 64 && value === value.trim()
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value);
}

function compareSchedule(a, b, newestFirst = false) {
  if (a.date === b.date) return a.public_slug.localeCompare(b.public_slug);
  if (a.date === null) return 1;
  if (b.date === null) return -1;
  return newestFirst ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
}

export function parseContestCatalog(value) {
  if (!hasOnlyKeys(value, ['schema_version', 'contests'])
      || value.schema_version !== 'meshdraw-contest-catalog-v1'
      || !Array.isArray(value.contests) || value.contests.length > 500) {
    throw new Error('CATALOG_FORMAT');
  }
  const seen = new Set();
  const contests = value.contests.map((contest) => {
    if (!hasOnlyKeys(contest, ['public_slug', 'title', 'prize', 'phase'], ['date'])
        || !isPublicSlug(contest.public_slug)
        || seen.has(contest.public_slug) || !isDisplayText(contest.title, 150)
        || !isDisplayText(contest.prize, 160)
        || typeof contest.phase !== 'string' || !Object.hasOwn(phaseLabels, contest.phase)
        || (Object.hasOwn(contest, 'date') && contest.date !== null && !isIsoDate(contest.date))) {
      throw new Error('CATALOG_ENTRY');
    }
    seen.add(contest.public_slug);
    return { ...contest, date: contest.date ?? null };
  });
  const finished = (contest) => ['DRAWN', 'CANCELLED'].includes(contest.phase);
  return {
    current: contests.filter((contest) => !finished(contest)).sort(compareSchedule),
    archived: contests.filter(finished).sort((a, b) => compareSchedule(a, b, true)),
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
  if (contest.date === null) {
    date.replaceWith(archived ? 'Дата не указана' : 'Дата уточняется');
  } else {
    date.dateTime = contest.date;
    date.textContent = displayDate.format(new Date(`${contest.date}T00:00:00Z`));
  }
  article.querySelector('.home-contest-meta span').textContent = phaseLabels[contest.phase];
  const link = article.querySelector('a');
  link.href = new URL(`./contests/${contest.public_slug}/`, import.meta.url);
  link.textContent = archived && contest.phase === 'DRAWN' ? 'Результат и проверка' : 'Страница конкурса';
  link.setAttribute('aria-label', `${link.textContent} — ${contest.title}`);
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
  const feedback = document.getElementById('catalog-feedback');
  feedback.textContent = 'Загружаем список конкурсов…';
  feedback.hidden = false;
  try {
    const response = await fetch(new URL('./contest-catalog.json', import.meta.url), {
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8_000),
    });
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
    archivedList.replaceChildren(...archived.slice(0, visibleArchiveEntries).map((contest) => renderContest(contest, true)));
    const older = archived.slice(visibleArchiveEntries);
    if (older.length > 0) {
      document.getElementById('older-contests').replaceChildren(...older.map((contest) => renderContest(contest, true)));
      const olderArchive = document.getElementById('older-archive');
      olderArchive.querySelector('summary').textContent = `Другие завершённые конкурсы (${older.length})`;
      olderArchive.hidden = false;
    }
    if (current.length > 0) {
      const cta = document.getElementById('home-cta');
      cta.href = '#contests';
      cta.textContent = current.every((contest) => contest.phase === 'ANNOUNCED') ? 'Смотреть анонсы' : 'Смотреть конкурсы';
    }
    feedback.hidden = true;
  } catch {
    feedback.textContent = 'Список обновить не удалось. Первый конкурс доступен в архиве.';
  }
}

if (typeof window !== 'undefined' && !followLegacyAnchor()) {
  window.addEventListener('hashchange', followLegacyAnchor);
  mountCatalog();
}
