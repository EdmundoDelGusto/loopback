var express = require('express');
var merge = require('util')._extend;
var PhaseList = require('loopback-phase').PhaseList;
var debug = require('debug')('loopback:app');

var proto = {};

module.exports = function loopbackExpress() {
  var app = express();
  app.__expressLazyRouter = app.lazyrouter;
  merge(app, proto);
  return app;
};

/**
 * Register a middleware handler to be executed in a given phase.
 * @param {string} name The phase name, e.g. "init" or "routes".
 * @param {function} handler The middleware handler, one of
 *   `function(req, res, next)` or
 *   `function(err, req, res, next)`
 * @returns {object} this (fluent API)
 */
proto.middleware = function(name, handler) {
  this.lazyrouter();

  var fullName = name;
  var handlerName = handler.name || '(anonymous)';

  var hook = 'use';
  var m = name.match(/^(.+):(before|after)$/);
  if (m) {
    name = m[1];
    hook = m[2];
  }

  var phase = this._requestHandlingPhases.find(name);
  if (!phase)
    throw new Error('Unknown middleware phase ' + name);

  var wrapper;
  if (handler.length === 4) {
    // handler is function(err, req, res, next)
    debug('Add error handler %j to phase %j', handlerName, fullName);

    wrapper = function errorHandler(ctx, next) {
      if (ctx.err) {
        var err = ctx.err;
        ctx.err = undefined;
        handler(err, ctx.req, ctx.res, storeErrorAndContinue(ctx, next));
      } else {
        next();
      }
    };
  } else {
    // handler is function(req, res, next)
    debug('Add middleware %j to phase %j', handlerName , fullName);
    wrapper = function regularHandler(ctx, next) {
      if (ctx.err) {
        next();
      } else {
        handler(ctx.req, ctx.res, storeErrorAndContinue(ctx, next));
      }
    };
  }

  phase[hook](wrapper);
  return this;
};

function storeErrorAndContinue(ctx, next) {
  return function(err) {
    if (err) ctx.err = err;
    next();
  };
}

// Install our custom PhaseList-based handler into the app
proto.lazyrouter = function() {
  var self = this;
  if (self._router) return;

  self.__expressLazyRouter();

  // Storing the fn in another property of the router object
  // allows us to call the method with the router as `this`
  // without the need to use slow `call` or `apply`.
  self._router.__expressHandle = self._router.handle;

  self._requestHandlingPhases = new PhaseList();
  self._requestHandlingPhases.add([
    'initial', 'session', 'auth', 'parse',
    'routes', 'files', 'final'
  ]);

  // In order to pass error into express router, we have
  // to pass it to a middleware executed from within the router.
  // This is achieved by adding a phase-handler that wraps the error
  // into `req` object and then a router-handler that unwraps the error
  // and calls `next(err)`.
  // It is important to register these two handlers at the very beginning,
  // before any other handlers are added.
  self.middleware('routes', function wrapError(err, req, res, next) {
    req.__err = err;
    next();
  });

  self.use(function unwrapError(req, res, next) {
    var err = req.__err;
    req.__err = undefined;
    next(err);
  });

  self.middleware('routes', function runRootHandlers(req, res, next) {
    self._router.__expressHandle(req, res, next);
  });

  // Overwrite the original handle() function provided by express,
  // replace it with our implementation based on PhaseList
  self._router.handle = function(req, res, next) {
    var ctx = { req: req, res: res };
    self._requestHandlingPhases.run(ctx, function(err) {
      next(err || ctx.err);
    });
  };
};