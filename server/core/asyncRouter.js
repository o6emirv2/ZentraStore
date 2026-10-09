'use strict';

const express = require('express');

function wrap(handler) {
  if (Array.isArray(handler)) return handler.map(wrap);
  if (typeof handler !== 'function' || handler.length === 4) return handler;
  return function guardedHandler(req, res, next) {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') result.catch(next);
    } catch (error) {
      next(error);
    }
  };
}

function createRouter(options) {
  const router = express.Router(options);
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'use']) {
    const register = router[method];
    router[method] = function registerGuarded(...args) {
      return register.apply(this, args.map(wrap));
    };
  }
  return router;
}

module.exports = { createRouter };
