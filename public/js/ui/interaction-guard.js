const GUARD_KEY = '__ZENTRA_INTERACTION_GUARD__';
const MEDIA_SELECTOR = 'img, video, picture, canvas, svg';

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

  documentRoot.documentElement.classList.add('zentra-interaction-locked');
  normalizeProtectedMedia(documentRoot);

  listen(documentRoot, 'dragstart', (event) => {
    if (event.target instanceof Element && event.target.matches(MEDIA_SELECTOR)) event.preventDefault();
  }, { capture: true });

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
      documentRoot.documentElement.classList.remove('zentra-interaction-locked');
      delete windowRoot[GUARD_KEY];
    }
  });
  windowRoot[GUARD_KEY] = controller;
  return controller;
}
