import {parsePackageText} from './verifier.mjs';

const byId = id => document.getElementById(id);
const textFields = [
  'title', 'channel', 'open_status', 'closed_status', 'prize',
  'sponsor', 'cta', 'rules_label', 'participation',
];
const telegramPost = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,64}\/[1-9][0-9]{0,11}(?![\s\S])/;
const photoPath = /^assets\/[a-z0-9][a-z0-9-]{0,63}\.webp(?![\s\S])/;
const privateText = /\b(?:10\.\d{1,3}\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.\d{1,3}\.)|\b[0-9]{7,12}:[A-Za-z0-9_-]{30}|(?:^|[\s(])@[A-Za-z0-9_]{3,}/;

function publicText(value, limit) {
  return typeof value === 'string' && value.trim() && [...value].length <= limit && !privateText.test(value);
}

function utcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ(?![\s\S])/.test(value)
      || value.startsWith('0000')) throw new Error('PUBLIC_ANNOUNCEMENT_REVIEW_REQUIRED');
  const date = new Date(value);
  if (!Number.isFinite(+date) || date.toISOString() !== value.replace('Z', '.000Z')) {
    throw new Error('PUBLIC_ANNOUNCEMENT_REVIEW_REQUIRED');
  }
  return date;
}

export function validateAnnouncement(data) {
  const imagePresent = data && Object.hasOwn(data, 'prize_image');
  if (data?.schema_version !== 'meshdraw-announcement-v1'
      || Object.keys(data).length !== textFields.length + 6 + Number(imagePresent)
      || textFields.some(key => !publicText(data[key], 700))
      || !Array.isArray(data.conditions) || !data.conditions.length || data.conditions.length > 12
      || data.conditions.some(value => !publicText(value, 700))
      || ![data.post_url, data.rules_url].every(value => typeof value === 'string' && telegramPost.test(value))) {
    throw new Error('PUBLIC_ANNOUNCEMENT_REVIEW_REQUIRED');
  }
  const cutoff = utcDate(data.cutoff_at);
  const ceremony = utcDate(data.ceremony_at);
  if (cutoff >= ceremony) throw new Error('PUBLIC_ANNOUNCEMENT_REVIEW_REQUIRED');
  if (imagePresent) {
    const image = data.prize_image;
    if (!image || typeof image !== 'object' || Array.isArray(image)
        || Object.keys(image).length !== 4
        || typeof image.src !== 'string' || !photoPath.test(image.src)
        || !publicText(image.alt, 200)
        || ![image.width, image.height].every(size => Number.isInteger(size) && size >= 1 && size <= 2400)) {
      throw new Error('PUBLIC_ANNOUNCEMENT_IMAGE_REVIEW_REQUIRED');
    }
  }
  return {cutoff, ceremony};
}

const dateOptions = {day: 'numeric', month: 'long', timeZone: 'Europe/Moscow'};
const moscowDate = new Intl.DateTimeFormat('ru-RU', dateOptions);
const moscowTime = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Moscow',
});
const moscowSnapshot = new Intl.DateTimeFormat('ru-RU', {
  ...dateOptions, year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const integer = new Intl.NumberFormat('ru-RU');

function setTime(id, date) {
  const element = byId(id);
  element.dateTime = date.toISOString();
  element.textContent = moscowDate.format(date) + ', ' + moscowTime.format(date) + '\u00a0МСК';
}

function setLink(id, label, href) {
  const link = byId(id);
  link.textContent = label;
  link.href = href;
}

function setLinkedText(element, text, link) {
  const label = link.textContent;
  const position = text.indexOf(label);
  if (position === -1) {
    element.textContent = text;
    return;
  }
  const inlineLink = document.createElement('a');
  inlineLink.href = link.href;
  inlineLink.rel = link.rel;
  inlineLink.textContent = label;
  element.replaceChildren(text.slice(0, position), inlineLink, text.slice(position + label.length));
}

export async function mountAnnouncement() {
  const response = await fetch(new URL('./announcement.json', import.meta.url), {
    cache: 'no-cache', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('ANNOUNCEMENT_UNAVAILABLE');
  const data = parsePackageText(await response.text());
  const {cutoff, ceremony} = validateAnnouncement(data);
  const heading = byId('prelaunch-heading');
  byId('announcement-title').textContent = data.title;
  const channelUrl = new URL('.', data.post_url).href.slice(0, -1);
  setLink('announcement-title-channel', data.channel, channelUrl);
  byId('announcement-title-channel-line').hidden = false;
  byId('announcement-copy').prepend(heading);
  byId('prelaunch').classList.add('announcement');
  byId('prelaunch-summary').hidden = true;
  byId('announcement-prize-title').textContent = data.prize;
  byId('announcement-sponsor').textContent = data.sponsor;
  setLinkedText(byId('announcement-participation'), data.participation, byId('announcement-title-channel'));
  setTime('announcement-cutoff', cutoff);
  setTime('announcement-ceremony', ceremony);
  setLink('announcement-cta', data.cta, data.post_url);
  setLink('announcement-rules-link', data.rules_label, data.rules_url);
  setLink('announcement-full-rules', 'Полные правила в Telegram', data.rules_url);
  byId('announcement-conditions').replaceChildren(...data.conditions.map(text => {
    const item = document.createElement('li');
    setLinkedText(item, text, byId('announcement-sponsor-link'));
    return item;
  }));
  if (data.prize_image) {
    const image = byId('announcement-prize-image');
    const {src, alt, width, height} = data.prize_image;
    image.alt = alt;
    image.width = width;
    image.height = height;
    image.src = new URL(src, import.meta.url).href;
    image.hidden = false;
  }
  byId('announcement-content').hidden = false;
  return {
    matches: state => !state || Date.parse(state.cutoff_at) === +cutoff,
    render(state, phaseLabel, now = Date.now(), stale = false) {
      const open = state?.phase === 'OPEN' && now >= Date.parse(state.opens_at) && now < +cutoff;
      const registration = state?.registered_accounts;
      const status = state ? (open ? data.open_status : phaseLabel)
        : now >= +cutoff ? data.closed_status : 'Ожидаем официальный снимок регистрации';
      const statusNode = byId('announcement-status');
      if (statusNode.textContent !== status) statusNode.textContent = status;
      statusNode.dataset.tone = state?.phase === 'DRAW_FAILED' ? 'error' : open ? 'open' : 'pending';

      const cta = byId('announcement-cta');
      const ctaText = open ? data.cta : 'Открыть пост розыгрыша';
      if (cta.textContent !== ctaText) cta.textContent = ctaText;
      cta.hidden = !open && (Boolean(state) || now >= +cutoff);
      const locked = state?.archive_plan != null;
      byId('announcement-content').toggleAttribute('data-locked', locked);
      byId('announcement-registration').hidden = locked;
      const countText = registration == null ? 'Число зарегистрированных аккаунтов пока недоступно.'
        : 'Зарегистрировано аккаунтов: ' + integer.format(registration);
      const count = byId('announcement-meta');
      if (count.textContent !== countText) count.textContent = countText;
      byId('announcement-updated').hidden = registration == null;
      byId('announcement-stale').hidden = !stale;
      if (registration != null) {
        const snapshot = byId('announcement-snapshot');
        if (snapshot.dateTime !== state.snapshot_at) {
          snapshot.dateTime = state.snapshot_at;
          snapshot.textContent = moscowSnapshot.format(new Date(state.snapshot_at)) + ' МСК';
        }
      }
    },
  };
}
