export function waitForSignal(promise, signal) {
  const pending = Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException('Request aborted', 'AbortError'));
    if (signal.aborted) { pending.catch(() => {}); aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

// A missing/unusable response does not prove that a write was rolled back.
// Keep the SAME idempotency key when retrying an uncertain financial mutation.
export function isUncertainMutationError(error) {
  return ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'RESPONSE_INVALID'].includes(String(error?.code || ''))
    || Number(error?.status) >= 500 || /^HTTP_5\d\d$/.test(String(error?.code || ''));
}

export async function readApiJson(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const payload = contentType.includes('application/json') ? await response.json().catch(() => null) : null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (response.ok && payload.ok !== true)) {
    const error = new Error('Sunucu yanıtı doğrulanamadı. İşlem sonucunu kontrol ederek yeniden deneyin.');
    error.code = response.ok ? 'RESPONSE_INVALID' : `HTTP_${response.status}`;
    error.status = response.status;
    error.requestId = response.headers.get('x-request-id') || '';
    throw error;
  }
  return payload;
}
