'use strict';

const express = require('express');

function wrap(value) {
  if (Array.isArray(value)) return value.map(wrap);
  if (typeof value !== 'function' || value.constructor.name !== 'AsyncFunction') return value;
  return (req, res, next) => Promise.resolve(value(req, res, next)).catch(next);
}

// Express 4 does not forward rejected async handler promises by itself.
function createAsyncRouter() {
  const router = express.Router();
  for (const method of ['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'use']) {
    const register = router[method];
    router[method] = function (...args) { return register.apply(this, args.map(wrap)); };
  }
  return router;
}

module.exports = createAsyncRouter;
