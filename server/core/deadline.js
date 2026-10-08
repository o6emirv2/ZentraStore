'use strict';

// Only read operations may use this deadline. Financial writes retain their
// transaction result and idempotency semantics, even after a client disconnects.
function withReadDeadline(pending, timeoutMs, code = 'STORE_READ_TIMEOUT') {
  let timer;
  return Promise.race([
    Promise.resolve(pending),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(code), { code, statusCode: 503 })), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

module.exports = { withReadDeadline };
