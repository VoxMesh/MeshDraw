import { ALGORITHM_VERSION, UI_CONTRACT, canonicalJson, digest, parsePackageText, sha256, verifyPackage } from './verifier.mjs';

const FORMAT = 'meshdraw-public-state-v2';
const POLL_MS = 60_000;
const STALE_MS = 15 * 60_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const STATUS_NAME = 'show-status.json';
const fileNames = ['RELEASE.json', 'result.json', 'verification.json'];
const storageKey = new URL('.', import.meta.url).pathname + 'meshdraw-show-status';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const byId = id => document.getElementById(id);
const phases = {
  OPEN: 'Приём заявок открыт',
  CLOSING: 'Приём завершён, проверяем список',
  CLOSED: 'Приём завершён, проверяем список',
  DRAINED: 'Приём завершён, проверяем список',
  FROZEN: 'Список зафиксирован',
  WAITING: 'Ожидаем закреплённое время чтения',
  RUNNING: 'Получаем данные и сохраняем расчёт',
  DRAW_FAILED: 'Расчёт не завершён',
  DRAWN: 'Результат проверен в браузере',
};
const order = { OPEN: 0, CLOSING: 1, CLOSED: 1, DRAINED: 1, FROZEN: 2,
  WAITING: 3, RUNNING: 4, DRAW_FAILED: 5, DRAWN: 5 };
const contestFields = ['contest_id', 'title', 'prize', 'rules_text', 'opens_at', 'cutoff_at'];
const planFields = ['profile', 'start', 'end', 'read_at', 'region', 'candidate', 'code_version', 'implementation_sha256'];
const moscowTime = new Intl.DateTimeFormat('ru-RU', {timeZone: 'Europe/Moscow', dateStyle: 'long', timeStyle: 'medium'});
const formatTime = value => moscowTime.format(new Date(value)) + ' МСК';
const integer = new Intl.NumberFormat('ru-RU');
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && /Z$/.test(value);

let accepted;
let acceptedKey;
let frozenKey;
let verificationPackage;
let revealAnimation;
let pinned = readPin();
let checking = false;
let refreshTimer;
let countdownTimer;
let announcement;
let activeAnnouncement;
const announcementReady = loadAnnouncement();

async function loadAnnouncement() {
  if (!document.querySelector('meta[name="meshdraw-announcement"][content="announcement.json"]')) return;
  try {
    const {mountAnnouncement} = await import('./announcement.mjs');
    announcement = await mountAnnouncement();
    renderAnnouncement(null);
  } catch {
    setText('prelaunch-summary', 'Условия конкурса временно недоступны. Попробуйте обновить страницу.');
  }
}

function renderAnnouncement(state) {
  activeAnnouncement = announcement?.matches(state) ? announcement : null;
  byId('prelaunch').hidden = Boolean(state) && !activeAnnouncement;
  byId('announcement-rules').hidden = !activeAnnouncement;
  const rulesLink = byId('rules-link');
  rulesLink.hidden = !activeAnnouncement && !state;
  rulesLink.href = activeAnnouncement ? '#announcement-rules-title' : '#rules-section';
  if (!state && activeAnnouncement) {
    activeAnnouncement.render(null);
    document.title = byId('prelaunch-heading').textContent + ' · MeshDraw';
  }
}

function ensure(condition, code) {
  if (!condition) throw new Error(code);
}

function setText(id, value) {
  const node = byId(id);
  if (node.textContent !== value) node.textContent = value;
}

function readPin() {
  try {
    return JSON.parse(sessionStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

function rememberPin(status, key) {
  pinned = {revision: status.revision, contest: status.contest_id, key, frozenKey,
    phase: status.phase, snapshot_at: status.snapshot_at,
    registered_accounts: accepted?.registered_accounts ?? null};
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(pinned));
  } catch {
    // The current tab still remembers accepted revisions in memory.
  }
}

async function readFile(name, maximum = MAX_FILE_BYTES) {
  const response = await fetch(new URL(name, import.meta.url), {
    credentials: 'omit', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  });
  ensure(response.ok && response.body, 'PUBLISHED_FILE_UNAVAILABLE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error('PUBLIC_FILE_TOO_LARGE');
    }
    chunks.push(value);
  }
  return new Blob(chunks);
}

async function readVerified(name, status) {
  const blob = await readFile(name);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  ensure(await sha256(bytes) === status.files[name], 'PUBLIC_FILE_HASH_MISMATCH');
  return { value: parsePackageText(new TextDecoder('utf-8', {fatal: true}).decode(bytes)), blob };
}

function validateStatus(status) {
  ensure(status && typeof status === 'object'
    && Object.keys(status).sort().join(',') === 'contest_id,files,phase,prepared_at,revision,schema_version,snapshot_at'
    && status.schema_version === 'meshdraw-show-status-v1'
    && Number.isSafeInteger(status.revision) && status.revision >= 0
    && status.files && Object.keys(status.files).length === fileNames.length
    && fileNames.every(name => hash(status.files[name])),
  'PUBLIC_STATUS_INVALID');
  ensure(status.revision === 0
    ? status.contest_id === null && status.phase === 'NO_CONTEST'
      && status.snapshot_at === null && status.prepared_at === null
    : typeof status.contest_id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(status.contest_id)
      && Object.hasOwn(phases, status.phase)
      && validTime(status.snapshot_at) && validTime(status.prepared_at)
      && Date.parse(status.snapshot_at) <= Date.parse(status.prepared_at),
  'PUBLIC_STATUS_INVALID');
}

function validateMetadata(value, mode, reserveRule) {
  const version = reserveRule ? 'meshdraw-public-verification-v2' : 'meshdraw-public-verification-v1';
  ensure(value?.schema_version === 'meshdraw-public-release-v2'
    && value.ui_contract === UI_CONTRACT && value.state_format === FORMAT
    && value.algorithm_version === ALGORITHM_VERSION && value.archive_profile === 'archive-input-v1'
    && value.verification_format === version
    && value.source_mode === mode
    && document.querySelector('meta[name="meshdraw-ui-contract"]')?.content === UI_CONTRACT,
  'INCOMPATIBLE_RELEASE_FILES');
}

function validateState(state) {
  ensure(state && typeof state === 'object' && !Array.isArray(state)
    && Object.hasOwn(phases, state.phase) && typeof state.synthetic === 'boolean'
    && contestFields.every(key => typeof state[key] === 'string' && state[key].length <= 4000)
    && /^[A-Za-z0-9_.-]{1,64}$/.test(state.contest_id)
    && validTime(state.snapshot_at)
    && (state.calculated_at === null || (state.phase === 'DRAWN' && validTime(state.calculated_at)
      && Date.parse(state.calculated_at) <= Date.parse(state.snapshot_at)))
    && validTime(state.opens_at) && validTime(state.cutoff_at)
    && Date.parse(state.cutoff_at) > Date.parse(state.opens_at)
    && Array.isArray(state.tickets) && state.tickets.length <= 10_000
    && state.ticket_count === state.tickets.length
    && state.tickets.every(ticket => typeof ticket === 'string' && /^[0-9]{1,32}(?![\s\S])/.test(ticket))
    && state.tickets.every((ticket, index, tickets) => index === 0 || BigInt(tickets[index - 1]) < BigInt(ticket)),
  'PUBLIC_STATE_INVALID');

  if (order[state.phase] >= order.FROZEN) {
    const plan = state.archive_plan;
    const hasReserves = plan && Object.hasOwn(plan, 'reserve_rule');
    ensure(state.registered_accounts === null && state.ticket_count >= 2 && hash(state.plan_sha256)
      && plan && Object.keys(plan).length === planFields.length + Number(hasReserves)
      && planFields.every(key => Object.hasOwn(plan, key))
      && plan.profile === 'archive-input-v1' && plan.region === 'all' && plan.candidate === 'DEDUP_HASH'
      && typeof plan.code_version === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(plan.code_version)
      && plan.implementation_sha256 && typeof plan.implementation_sha256 === 'object'
      && !Array.isArray(plan.implementation_sha256)
      && Object.values(plan.implementation_sha256).length > 0
      && Object.values(plan.implementation_sha256).every(hash)
      && ['start', 'end', 'read_at'].every(key => validTime(plan[key]) && /T\d{2}:\d{2}:00Z$/.test(plan[key]))
      && Date.parse(plan.start) > Date.parse(state.cutoff_at)
      && Date.parse(plan.end) - Date.parse(plan.start) === 60_000
      && Date.parse(plan.read_at) - Date.parse(plan.end) === 300_000,
    'PUBLIC_PLAN_INVALID');
    if (hasReserves) {
      const rule = plan.reserve_rule;
      ensure(rule && Object.keys(rule).length === 2 && rule.version === 'meshdraw-reserve-sha256-v1'
        && Number.isSafeInteger(rule.count) && rule.count >= 1 && rule.count < state.ticket_count,
      'PUBLIC_RESERVE_RULE');
    }
  } else {
    ensure(state.archive_plan === null && state.plan_sha256 === null && state.ticket_count === 0
      && Number.isSafeInteger(state.registered_accounts) && state.registered_accounts >= 0,
    'REGISTRATION_SNAPSHOT_MISMATCH');
  }
  ensure(state.phase === 'DRAWN'
    ? state.tickets.includes(state.winner) && hash(state.verification_sha256)
    : state.winner === null && state.verification_sha256 === null,
  'PUBLIC_RESULT_INVALID');
}

function frozenSignature(state) {
  return canonicalJson([...contestFields.map(key => state[key]), state.synthetic,
    state.tickets, state.plan_sha256, state.archive_plan]);
}

async function checkPackage(pkg, state) {
  ensure(pkg && await digest(pkg) === state.verification_sha256, 'PUBLIC_PACKAGE_HASH_MISMATCH');
  const result = await verifyPackage(pkg);
  ensure(result.status === 'MATCH'
    && result.calculation.mapping?.ticket === state.winner
    && canonicalJson(pkg.policy.tickets) === canonicalJson(state.tickets)
    && pkg.projection.original_plan_sha256 === state.plan_sha256
    && canonicalJson(result.reserves?.rule ?? null) === canonicalJson(state.archive_plan.reserve_rule ?? null)
    && pkg.mode === (state.synthetic ? 'SYNTHETIC' : 'REVIEWED_PROJECTION')
    && ['start', 'end', 'profile', 'region', 'candidate'].every(key => pkg.policy[key] === state.archive_plan[key]),
  'PUBLIC_STATE_PACKAGE_MISMATCH');
  return result;
}

function renderClock() {
  const state = accepted;
  if (!state) {
    announcement?.render(null);
    return;
  }
  const now = Date.now();
  const stale = state.phase === 'OPEN' && now - Date.parse(state.snapshot_at) > STALE_MS;
  const label = state.phase === 'OPEN' && now < Date.parse(state.opens_at)
    ? 'Приём ещё не начался' : state.phase === 'OPEN' && now >= Date.parse(state.cutoff_at)
      ? phases.CLOSING : phases[state.phase];
  setText('contest-state', label);
  activeAnnouncement?.render(state, label, now, stale);
  const clock = byId('show-countdown');
  const waiting = state.phase === 'FROZEN' || state.phase === 'WAITING';
  const registering = state.phase === 'OPEN';
  const target = registering ? state.cutoff_at : state.archive_plan?.read_at;
  const remaining = Math.ceil((Date.parse(target) - now) / 1000);
  clock.hidden = !((waiting || registering) && remaining > 0);
  byId('show-clock-label').hidden = clock.hidden;
  if (!clock.hidden) {
    setText('show-clock-label', registering ? 'До закрытия регистрации' : 'До запланированного чтения');
    const parts = [Math.floor(remaining / 3600), Math.floor(remaining / 60) % 60, remaining % 60];
    setText('show-countdown', parts.map(part => String(part).padStart(2, '0')).join(':'));
  }
  setText('show-clock-note', waiting
    ? clock.hidden ? 'Ожидаем опубликованного обновления.' : 'Время по плану. Публикация результата может занять дольше.'
    : state.phase === 'RUNNING' ? 'Получение радиоданных отмечено в опубликованном снимке.' : '');
  byId('show-stale').hidden = !stale;
}

function renderTickets(state, previous) {
  if (previous && canonicalJson(previous.tickets) === canonicalJson(state.tickets)) return;
  setText('ticket-count', state.archive_plan ? integer.format(state.ticket_count) : '');
  const items = document.createDocumentFragment();
  for (const ticket of state.tickets) {
    const item = document.createElement('li');
    item.textContent = ticket;
    items.append(item);
  }
  byId('tickets').replaceChildren(items);
}

function renderRadio(calculation) {
  const { selected_rows: rows, selected_observers: observers } = calculation.counts;
  setText('show-rf-summary', 'Наблюдения: ' + rows + ' · Наблюдатели: ' + observers);
  const sample = calculation.rf.pairs.slice(0, 24).map(pair => Number(pair[0]) / 4);
  const low = Math.min(...sample);
  const span = Math.max(Math.max(...sample) - low, 1);
  const points = sample.map((rssi, index) => {
    const x = 4 + 232 * index / Math.max(sample.length - 1, 1);
    const y = 42 - 36 * (rssi - low) / span;
    return x.toFixed(2) + ',' + y.toFixed(2);
  });
  byId('show-rf-trace').setAttribute('points', points.join(' '));
  setText('show-rf-caption', 'RSSI в порядке расчёта · ' + sample.length + ' из ' + rows + ' · масштаб по диапазону');
  byId('show-rf').hidden = false;
}

function render(state, previous, verified) {
  const stage = byId('show-stage');
  const locked = state.archive_plan !== null;
  renderAnnouncement(state);
  byId('contest-view').hidden = false;
  byId('contest-title').parentElement.hidden = Boolean(activeAnnouncement);
  byId('rules-section').hidden = Boolean(activeAnnouncement);
  byId('tickets-link').hidden = !locked;
  byId('tickets-section').hidden = !locked;
  byId('tickets-section').parentElement.hidden = Boolean(activeAnnouncement) && !locked;
  byId('calculation-details').hidden = !locked;
  byId('show-plan-link').hidden = !locked;
  byId('verification-action').hidden = false;
  byId('synthetic-banner').hidden = !state.synthetic;
  byId('prize').hidden = !state.prize;
  stage.hidden = Boolean(activeAnnouncement) && !locked;
  stage.dataset.phase = state.phase;
  setText('result-heading', locked ? 'Результат розыгрыша' : 'Регистрация');
  document.title = (activeAnnouncement ? byId('prelaunch-heading').textContent : state.title) + ' · MeshDraw';
  setText('contest-title', state.title);
  setText('prize', 'Приз: ' + state.prize);
  setText('rules', state.rules_text);
  setText('opens-at', formatTime(state.opens_at));
  setText('cutoff-at', formatTime(state.cutoff_at));
  setText('show-updated', 'Обновлено ' + formatTime(state.snapshot_at));
  setText('show-count-label', locked ? 'Зафиксировано билетов' : 'Зарегистрировано аккаунтов');
  setText('show-ticket-count', integer.format(locked ? state.ticket_count : state.registered_accounts));
  byId('show-list-note').hidden = locked;
  const width = state.tickets.reduce((largest, ticket) => Math.max(largest, ticket.length), 4);
  setText('show-mask', 'Билет № ' + '*'.repeat(width));
  byId('show-mask').hidden = !locked || state.phase === 'DRAW_FAILED';
  byId('show-result').hidden = !locked;
  byId('contest-state').dataset.tone = state.phase === 'DRAW_FAILED' ? 'error' : 'ready';
  renderTickets(state, previous);
  clearInterval(countdownTimer);
  renderClock();
  if (state.phase === 'OPEN' || state.phase === 'FROZEN' || state.phase === 'WAITING') {
    countdownTimer = setInterval(renderClock, 1000);
  }
  if (locked) {
    byId('archive-section').hidden = false;
    setText('archive-window', formatTime(state.archive_plan.start) + ' — ' + formatTime(state.archive_plan.end));
    setText('archive-read-at', formatTime(state.archive_plan.read_at));
    setText('plan-hash', state.plan_sha256);
  }
  setText('result-note', state.phase === 'DRAW_FAILED'
    ? 'В опубликованном состоянии результата нет. Следите за сообщениями организатора.'
    : 'Победивший билет появится после проверки опубликованного пакета.');
  setText('verification-status', 'Пакет для проверки ещё не опубликован.');
  if (!verified) return;
  renderRadio(verified.calculation);
  present(verified.calculation.mapping.ticket, state, previous, verified.reserves);
}

function present(ticket, state, previous, reserves) {
  const stage = byId('show-stage');
  const controls = byId('reveal-controls');
  const animate = previous?.archive_plan && !document.hidden && !reducedMotion.matches
    && typeof byId('show-rf-trace').animate === 'function';
  function finish() {
    const hadFocus = controls.contains(document.activeElement);
    controls.hidden = true;
    stage.dataset.reveal = animate ? 'animated' : 'static';
    byId('show-mask').hidden = true;
    byId('winner-label').hidden = false;
    byId('saved-result').hidden = false;
    setText('winner-label', state.synthetic ? 'Учебный билет' : 'Билет победителя');
    setText('saved-result', '№' + ticket);
    setText('show-announcement', (state.synthetic ? 'Учебный билет №' : 'Билет победителя №') + ticket);
    setText('result-note', 'Результат рассчитан по опубликованным данным.');
    for (const item of byId('tickets').children) {
      if (item.textContent === ticket) item.dataset.winner = 'true';
    }
    if (reserves) {
      const items = document.createDocumentFragment();
      for (const candidate of reserves.tickets) {
        const item = document.createElement('li');
        item.textContent = '№' + candidate;
        items.append(item);
      }
      byId('reserve-list').replaceChildren(items);
      byId('reserve-order').hidden = false;
    }
    byId('verification-links').hidden = false;
    byId('recalculate').hidden = false;
    byId('recalculate').disabled = false;
    setText('verification-status', 'Пакет проверен. Можно повторить расчёт в этом браузере.');
    if (hadFocus) byId('saved-result').focus({preventScroll: true});
    revealAnimation = null;
  }
  if (!animate) {
    finish();
    return;
  }
  controls.hidden = false;
  stage.dataset.reveal = 'playing';
  setText('result-note', 'Открываем сохранённый билет. Пакет уже доступен в публикации.');
  setText('verification-status', 'Пакет опубликован. Кнопки проверки появятся после раскрытия.');
  revealAnimation = byId('show-rf-trace').animate(
    [{strokeDashoffset: 1, opacity: .45}, {strokeDashoffset: 0, opacity: 1}],
    {duration: 6000, easing: 'ease-out', fill: 'both'},
  );
  revealAnimation.finished.then(finish, finish);
}

async function acceptUpdate() {
  await announcementReady;
  const status = parsePackageText(await (await readFile(STATUS_NAME, 4096)).text());
  validateStatus(status);
  const key = canonicalJson(status);
  if (key === acceptedKey) return;
  if (pinned) {
    ensure(status.revision >= pinned.revision
      && (status.revision !== pinned.revision || key === pinned.key)
      && (!pinned.contest || status.contest_id === pinned.contest)
      && (!pinned.contest || Date.parse(status.snapshot_at) >= Date.parse(pinned.snapshot_at))
      && (!pinned.contest || (order[status.phase] >= order[pinned.phase]
        && (order[pinned.phase] < order.DRAWN || key === pinned.key))),
    'STALE_OR_DIFFERENT_CONTEST');
  }
  const { value: envelope } = await readVerified('result.json', status);
  ensure(envelope?.schema_version === FORMAT && envelope.ui_contract === UI_CONTRACT, 'PUBLIC_STATE_VERSION');
  const state = envelope.state;
  if (state !== null) {
    validateState(state);
    ensure(status.contest_id === state.contest_id && status.phase === state.phase
      && status.snapshot_at === state.snapshot_at && status.revision > 0
      && (state.registered_accounts === null || pinned?.registered_accounts == null
        || state.registered_accounts >= pinned.registered_accounts), 'PUBLIC_STATUS_STATE_MISMATCH');
  } else {
    ensure(status.revision === 0, 'PUBLIC_STATUS_STATE_MISMATCH');
  }
  const mode = state === null ? 'NO_CONTEST' : state.synthetic ? 'SYNTHETIC' : 'REVIEWED_PROJECTION';
  validateMetadata((await readVerified('RELEASE.json', status)).value, mode, state?.archive_plan?.reserve_rule);
  const signature = state?.archive_plan ? frozenSignature(state) : null;
  ensure(!pinned?.frozenKey || signature === pinned.frozenKey, 'FROZEN_PUBLIC_STATE_CHANGED');

  let verified;
  let verification;
  try {
    verification = await readVerified('verification.json', status);
    if (state?.phase === 'DRAWN') verified = await checkPackage(verification.value, state);
    else ensure(verification.value === null, 'UNEXPECTED_RESULT');
  } catch (error) {
    if (state?.phase === 'DRAWN' && !verificationPackage) {
      byId('verification-action').hidden = false;
      setText('verification-status', 'Проверочный пакет отсутствует или не совпадает с опубликованной версией.');
    }
    throw error;
  }
  const previous = accepted;
  accepted = state;
  acceptedKey = key;
  frozenKey = signature;
  rememberPin(status, key);
  if (state === null) {
    renderAnnouncement(null);
    return;
  }
  if (verified) {
    verificationPackage = verification.value;
    byId('download-verification').href = URL.createObjectURL(verification.blob);
  }
  render(state, previous, verified);
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!document.hidden && !checking) refreshTimer = setTimeout(() => refresh(), POLL_MS);
}

async function refresh(manual = false) {
  if (checking || (document.hidden && !manual)) return;
  clearTimeout(refreshTimer);
  checking = true;
  byId('refresh-state').setAttribute('aria-disabled', 'true');
  try {
    await acceptUpdate();
    renderClock();
    byId('state-feedback').hidden = true;
    byId('refresh-feedback').dataset.tone = 'ready';
    setText('refresh-feedback', manual ? 'Опубликованное состояние проверено.' : '');
  } catch {
    if (acceptedKey === undefined) {
      byId('state-feedback').hidden = false;
      byId('state-feedback').dataset.tone = 'error';
      setText('state-feedback', 'Снимок конкурса пока недоступен. Страница проверит его снова.');
    }
    byId('refresh-feedback').dataset.tone = 'error';
    setText('refresh-feedback', acceptedKey === undefined
      ? 'Проверьте обновление позже.'
      : 'Данные могут быть устаревшими. Показан последний принятый снимок.');
  } finally {
    byId('main').setAttribute('aria-busy', 'false');
    byId('refresh-state').removeAttribute('aria-disabled');
    checking = false;
    scheduleRefresh();
  }
}

byId('pause-reveal').addEventListener('click', () => {
  if (!revealAnimation) return;
  const paused = revealAnimation.playState === 'paused';
  if (paused) revealAnimation.play();
  else revealAnimation.pause();
  byId('show-stage').dataset.reveal = paused ? 'playing' : 'paused';
  setText('pause-reveal', paused ? 'Пауза' : 'Продолжить');
});
byId('skip-reveal').addEventListener('click', () => revealAnimation?.finish());
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) revealAnimation?.finish();
});

byId('refresh-state').addEventListener('click', () => refresh(true));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(refreshTimer);
  else {
    renderClock();
    refresh();
  }
});

byId('recalculate').addEventListener('click', async () => {
  const button = byId('recalculate');
  if (!verificationPackage || button.getAttribute('aria-disabled') === 'true') return;
  button.setAttribute('aria-disabled', 'true');
  try {
    const { selection, calculation, reserves } = await checkPackage(verificationPackage, accepted);
    setText('calculation-output', JSON.stringify({
      selection, selected_ids: calculation.selected_ids, counts: calculation.counts,
      excluded: calculation.excluded, ambiguity_group_count: calculation.ambiguity_group_count,
      quantized_pairs: calculation.rf.pairs, rf_bytes_hex: calculation.rf.bytes_hex,
      rf_sha256: calculation.rf.sha256, ticket_index_zero_based: calculation.mapping.index,
      ticket: calculation.mapping.ticket, mapping_words_used: calculation.mapping.words_used,
      ...(reserves ? {reserves} : {}),
      independent_provenance: 'NOT_CONFIRMED',
    }, null, 2));
    byId('calculation-output').hidden = false;
    byId('steps-note').hidden = true;
    byId('verification-status').dataset.state = 'match';
    setText('verification-status', 'Расчёт совпал. Билет №' + calculation.mapping.ticket + '.');
  } catch {
    byId('verification-status').dataset.state = 'error';
    byId('calculation-output').hidden = true;
    byId('steps-note').hidden = false;
    setText('verification-status', 'Повторный расчёт не подтверждён. Проверьте сохранённый пакет отдельно.');
  } finally {
    button.removeAttribute('aria-disabled');
  }
});

await refresh();
