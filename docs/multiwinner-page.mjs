import { verifyMultiwinnerPackage } from './multiwinner-v1.mjs';
import { parsePackageText } from './verifier.mjs';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const button = document.getElementById('recalculate');
const status = document.getElementById('verification-status');

async function readVerification() {
  const response = await fetch(new URL('verification.json', location.href), {
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok || !response.body) throw new Error('MULTIWINNER_PACKAGE_UNAVAILABLE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FILE_BYTES) {
      await reader.cancel();
      throw new Error('MULTIWINNER_PACKAGE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = await new Blob(chunks).arrayBuffer();
  return parsePackageText(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}

if (button && status) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Проверяем опубликованный пакет.';
    try {
      const expectedPlanSha256 = button.dataset.planSha256;
      if (!/^[0-9a-f]{64}(?![\s\S])/.test(expectedPlanSha256 ?? '')) throw new Error('MULTIWINNER_PLAN_HASH');
      const {result} = await verifyMultiwinnerPackage(await readVerification(), {expectedPlanSha256});
      if (result.status === 'NO_DRAW') {
        status.textContent = 'План проверен. Розыгрыш завершился без победителей.';
      } else if (result.status === 'AWARD_ALL') {
        status.textContent = `План проверен. Победителями стали все участники с зафиксированными билетами (${result.winner_tickets.length}).`;
      } else {
        status.textContent = `Полный порядок билетов подтверждён. Победителей — ${result.winner_tickets.length}, резервных билетов — ${result.reserve_tickets.length}.`;
      }
    } catch {
      status.textContent = 'Пакет недоступен или его проверка не пройдена.';
    } finally {
      button.disabled = false;
    }
  });
}
