import { canonicalJson, digest, toUtcUs, verifyPackage as verifyArchive } from './verifier.mjs';

const PLAN_SCHEMA = 'meshdraw-pilot-plan-v3';
const RESULT_SCHEMA = 'meshdraw-pilot-result-v2';
const PACKAGE_SCHEMA = 'meshdraw-public-verification-v3';
const ORDER_ALGORITHM = 'meshdraw-reserve-sha256-v1';
const SECTIONS = ['plan', 'result', 'archive_verification'];
const MAX_TICKETS = 10_000;
const HASH = /^[0-9a-f]{64}(?![\s\S])/;
const UTC_MINUTE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z(?![\s\S])/;

function fields(value, names, error) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) {
    throw new Error(error);
  }
}

export async function validateMultiwinnerPlan(plan, {expectedPlanSha256} = {}) {
  fields(plan, ['schema_version', 'contest_id', 'tickets', 'winner_count', 'underfilled_policy',
    'order_algorithm', 'archive', 'plan_sha256'], 'MULTIWINNER_PLAN_FIELDS');
  if (plan.schema_version !== PLAN_SCHEMA || plan.order_algorithm !== ORDER_ALGORITHM) {
    throw new Error('MULTIWINNER_PLAN_VERSION');
  }
  if (typeof plan.contest_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?![\s\S])/.test(plan.contest_id)) {
    throw new Error('MULTIWINNER_CONTEST_ID');
  }
  const {tickets, winner_count: count, underfilled_policy: policy, archive} = plan;
  if (!Array.isArray(tickets) || tickets.some(ticket => typeof ticket !== 'string'
      || !/^[0-9]{1,32}(?![\s\S])/.test(ticket))) throw new Error('MULTIWINNER_TICKETS');
  if (tickets.length > MAX_TICKETS) throw new Error('MULTIWINNER_TICKET_COUNT');
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_TICKETS) {
    throw new Error('MULTIWINNER_WINNER_COUNT');
  }
  if (!['AWARD_ALL', 'NO_DRAW'].includes(policy)) throw new Error('MULTIWINNER_UNDERFILLED_POLICY');
  if (tickets.some((ticket, index) => index > 0 && BigInt(ticket) <= BigInt(tickets[index - 1]))) {
    throw new Error('MULTIWINNER_TICKETS');
  }

  let outcome = 'DRAWN';
  if (tickets.length === 0 || (tickets.length < count && policy === 'NO_DRAW')) outcome = 'NO_DRAW';
  else if ((tickets.length === 1 && count === 1) || (tickets.length <= count && policy === 'AWARD_ALL')) outcome = 'AWARD_ALL';

  if (outcome === 'DRAWN') {
    if (tickets.length < 2) throw new Error('MULTIWINNER_RF_TICKET_COUNT');
    fields(archive, ['mode', 'profile', 'start', 'end', 'plan_sha256'], 'MULTIWINNER_ARCHIVE_FIELDS');
    if (!['SYNTHETIC', 'REVIEWED_PROJECTION'].includes(archive.mode) || archive.profile !== 'archive-input-v1'
        || typeof archive.plan_sha256 !== 'string' || !HASH.test(archive.plan_sha256)) {
      throw new Error('MULTIWINNER_ARCHIVE_PROFILE');
    }
    if ([archive.start, archive.end].some(value => typeof value !== 'string' || !UTC_MINUTE.test(value))
        || toUtcUs(archive.end) - toUtcUs(archive.start) !== 60_000_000n) {
      throw new Error('MULTIWINNER_ARCHIVE_WINDOW');
    }
  } else if (archive !== null) {
    throw new Error('MULTIWINNER_UNEXPECTED_ARCHIVE');
  }

  const {plan_sha256: saved, ...body} = plan;
  if (saved !== await digest(body) || (expectedPlanSha256 != null && saved !== expectedPlanSha256)) {
    throw new Error('MULTIWINNER_PLAN_HASH');
  }
  return outcome;
}

async function archiveOrder(plan, packageValue) {
  if (packageValue === null || typeof packageValue !== 'object' || Array.isArray(packageValue)) {
    throw new Error('MULTIWINNER_ARCHIVE_PROOF_REQUIRED');
  }
  const verified = await verifyArchive(packageValue);
  const {calculation} = verified;
  if (verified.status !== 'MATCH' || calculation.status !== 'ARCHIVE_DRAW') {
    throw new Error('MULTIWINNER_ARCHIVE_DRAW_REQUIRED');
  }
  const {archive, tickets} = plan;
  const {policy, projection, snapshot, mode} = packageValue;
  if (mode !== archive.mode || projection.original_plan_sha256 !== archive.plan_sha256
      || ['profile', 'start', 'end'].some(key => policy[key] !== archive[key])
      || canonicalJson(policy.tickets) !== canonicalJson(tickets)
      || (mode === 'REVIEWED_PROJECTION' && snapshot.schema_version !== 'meshdraw-source-snapshot-v2')) {
    throw new Error('MULTIWINNER_ARCHIVE_PLAN_MISMATCH');
  }

  const primary = calculation.mapping.ticket;
  const rfHash = calculation.rf.sha256;
  const remaining = tickets.filter(ticket => ticket !== primary);
  const ranked = [];
  const batchSize = 128;
  for (let offset = 0; offset < remaining.length; offset += batchSize) {
    const batch = remaining.slice(offset, offset + batchSize);
    ranked.push(...await Promise.all(batch.map(async (ticket, index) => ({ticket, index: offset + index,
      hash: await digest([ORDER_ALGORITHM, rfHash, ticket])}))));
  }
  ranked.sort((left, right) => left.hash === right.hash
    ? left.index - right.index : left.hash < right.hash ? -1 : 1);
  return {orderedTickets: [primary, ...ranked.map(item => item.ticket)], rfHash};
}

export async function verifyMultiwinnerPackage(packageValue, {expectedPlanSha256} = {}) {
  fields(packageValue, ['schema_version', 'manifest', ...SECTIONS], 'MULTIWINNER_PACKAGE_FIELDS');
  if (packageValue.schema_version !== PACKAGE_SCHEMA) throw new Error('MULTIWINNER_PACKAGE_VERSION');
  fields(packageValue.manifest, SECTIONS, 'MULTIWINNER_MANIFEST_FIELDS');
  for (const name of SECTIONS) {
    if (packageValue.manifest[name] !== await digest(packageValue[name])) {
      throw new Error('MULTIWINNER_MANIFEST_MISMATCH');
    }
  }
  const {plan, archive_verification: evidence} = packageValue;
  const status = await validateMultiwinnerPlan(plan, {expectedPlanSha256});
  let orderedTickets = status === 'AWARD_ALL' ? [...plan.tickets] : [];
  let rfHash = null;
  if (status === 'DRAWN') {
    ({orderedTickets, rfHash} = await archiveOrder(plan, evidence));
  } else if (evidence !== null) {
    throw new Error('MULTIWINNER_UNEXPECTED_ARCHIVE');
  }
  const count = plan.winner_count;
  const result = {schema_version: RESULT_SCHEMA, contest_id: plan.contest_id, plan_sha256: plan.plan_sha256,
    winner_count: count, status, rf_sha256: rfHash, ordered_tickets: orderedTickets,
    winner_tickets: orderedTickets.slice(0, count), reserve_tickets: orderedTickets.slice(count)};
  if (canonicalJson(result) !== canonicalJson(packageValue.result)) throw new Error('MULTIWINNER_RESULT_MISMATCH');
  return {status: 'MATCH', provenance: status === 'DRAWN' ? 'NOT_INDEPENDENTLY_CONFIRMED' : 'NOT_APPLICABLE',
    plan, result};
}
