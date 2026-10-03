const GUARD_KEY = '__SHELBY_INTERACTION_GUARD__';
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]';
const MEDIA_SELECTOR = 'img, video, picture, canvas, svg';

function isEditableTarget(target) {
  return target instanceof Element && Boolean(target.closest(EDITABLE_SELECTOR));
}

function normalizeProtectedMedia(root = document) {
  const nodes = [];
  if (root instanceof Element && root.matches(MEDIA_SELECTOR)) nodes.push(root);
  root.querySelectorAll?.(MEDIA_SELECTOR).forEach((node) => nodes.push(node));
  nodes.forEach((node) => {
    node.draggable = false;
    node.setAttribute('draggable', 'false');
  });
}

export function installInteractionGuard({ documentRoot = document, windowRoot = window } = {}) {
  if (windowRoot[GUARD_KEY]) return windowRoot[GUARD_KEY];

  const listeners = [];
  const listen = (target, type, handler, options) => {
    target?.addEventListener?.(type, handler, options);
    listeners.push(() => target?.removeEventListener?.(type, handler, options));
  };
  const prevent = (event) => event.preventDefault();

  const preventMultiTouch = (event) => {
    if (event.touches?.length > 1) event.preventDefault();
  };
  const preventSelection = (event) => {
    if (!isEditableTarget(event.target)) event.preventDefault();
  };
  const preventContextMenu = (event) => {
    if (!isEditableTarget(event.target)) event.preventDefault();
  };
  const preventKeyboardZoom = (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (['+', '=', '-', '0'].includes(event.key)) event.preventDefault();
  };
  const preventWheelZoom = (event) => {
    if (event.ctrlKey) event.preventDefault();
  };

  documentRoot.documentElement.classList.add('shelby-interaction-locked');
  normalizeProtectedMedia(documentRoot);

  listen(documentRoot, 'contextmenu', preventContextMenu, { capture: true });
  listen(documentRoot, 'dragstart', prevent, { capture: true });
  listen(documentRoot, 'dblclick', prevent, { capture: true, passive: false });
  listen(documentRoot, 'selectstart', preventSelection, { capture: true, passive: false });
  listen(documentRoot, 'touchmove', preventMultiTouch, { capture: true, passive: false });
  listen(documentRoot, 'gesturestart', prevent, { capture: true, passive: false });
  listen(documentRoot, 'gesturechange', prevent, { capture: true, passive: false });
  listen(documentRoot, 'gestureend', prevent, { capture: true, passive: false });
  listen(documentRoot, 'keydown', preventKeyboardZoom, { capture: true });
  listen(windowRoot, 'wheel', preventWheelZoom, { capture: true, passive: false });

  const observer = typeof MutationObserver === 'function'
    ? new MutationObserver((mutations) => {
      mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) normalizeProtectedMedia(node);
      }));
    })
    : null;
  observer?.observe(documentRoot.documentElement, { childList: true, subtree: true });

  const controller = Object.freeze({
    destroy() {
      observer?.disconnect();
      listeners.splice(0).forEach((remove) => remove());
      documentRoot.documentElement.classList.remove('shelby-interaction-locked');
      delete windowRoot[GUARD_KEY];
    }
  });
  windowRoot[GUARD_KEY] = controller;
  return controller;
}
