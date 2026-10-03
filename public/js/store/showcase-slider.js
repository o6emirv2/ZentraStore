import { PRODUCT_MEDIA_GROUPS, PRODUCT_MEDIA_SOURCE_PATTERN, SHOWCASE_MEDIA } from './product-media.js?v=audit-20260908-v1';

const AUTOPLAY_DELAY_MS = 3000;
const SWIPE_THRESHOLD_PX = 42;
const instances = new WeakMap();

function normalizeIndex(index, total) {
  return ((Math.trunc(Number(index) || 0) % total) + total) % total;
}

function hydrateSlide(slide) {
  const image = slide?.querySelector('img[data-src]');
  const source = image?.getAttribute('data-src') || '';
  if (!image || !PRODUCT_MEDIA_SOURCE_PATTERN.test(source)) return;
  image.src = source;
  image.removeAttribute('data-src');
}

function renderShowcaseSlides(track) {
  if (!track || !SHOWCASE_MEDIA.length) return;
  const fragment = document.createDocumentFragment();
  SHOWCASE_MEDIA.forEach((item, index) => {
    const slide = document.createElement('figure');
    slide.className = `showcase-slide${item.kind === 'logo' ? ' showcase-slide--logo' : ''}${index === 0 ? ' is-active' : ''}`;
    slide.dataset.showcaseSlide = String(index);
    slide.dataset.showcaseGroup = item.groupKey;
    slide.setAttribute('aria-label', `${index + 1} / ${SHOWCASE_MEDIA.length}: ${item.groupLabel}`);
    slide.setAttribute('aria-hidden', String(index !== 0));
    slide.toggleAttribute('inert', index !== 0);

    const image = document.createElement('img');
    if (index === 0) image.src = item.src;
    else image.dataset.src = item.src;
    image.alt = item.alt;
    image.loading = index === 0 ? 'eager' : 'lazy';
    image.decoding = 'async';
    image.draggable = false;
    image.width = item.kind === 'logo' ? 640 : 1280;
    image.height = item.kind === 'logo' ? 640 : 720;
    if (index === 0) image.fetchPriority = 'high';
    slide.append(image);
    fragment.append(slide);
  });
  track.replaceChildren(fragment);
}

function renderShowcaseGroups(root) {
  const navigation = root?.querySelector?.('[data-showcase-groups]');
  if (!navigation) return [];
  const fragment = document.createDocumentFragment();
  let startIndex = 0;
  PRODUCT_MEDIA_GROUPS.forEach((group, index) => {
    const button = document.createElement('button');
    button.className = `showcase-slider__group${index === 0 ? ' is-active' : ''}`;
    button.type = 'button';
    button.dataset.showcaseControl = '';
    button.dataset.showcaseGroupTarget = String(startIndex);
    button.dataset.showcaseGroupKey = group.key;
    button.setAttribute('aria-pressed', String(index === 0));
    button.setAttribute('aria-label', `${group.label} slayt grubuna git`);
    button.textContent = group.label;
    fragment.append(button);
    startIndex += group.images.length;
  });
  navigation.replaceChildren(fragment);
  return [...navigation.querySelectorAll('[data-showcase-group-target]')];
}

export function installShowcaseSlider(root = document.querySelector('[data-showcase-slider]')) {
  if (!root) return null;
  if (instances.has(root)) return instances.get(root);

  const viewport = root.querySelector('[data-showcase-viewport]');
  const track = root.querySelector('[data-showcase-track]');
  renderShowcaseSlides(track);
  const groupButtons = renderShowcaseGroups(root);
  const slides = [...root.querySelectorAll('[data-showcase-slide]')];
  const current = root.querySelector('[data-showcase-current]');
  const total = root.querySelector('[data-showcase-total]');
  const progress = root.querySelector('[data-showcase-progress]');
  const toggle = root.querySelector('[data-showcase-toggle]');
  const previous = root.querySelector('[data-showcase-previous]');
  const next = root.querySelector('[data-showcase-next]');
  const groupLabel = root.querySelector('[data-showcase-group-label]');
  const groupPosition = root.querySelector('[data-showcase-group-position]');
  if (!viewport || !track || !slides.length) return null;

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  let index = 0;
  let timer = 0;
  let visible = true;
  let paused = !!reducedMotion?.matches;
  let pointer = null;
  let observer = null;
  const listeners = [];

  function listen(target, event, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(event, handler, options);
    listeners.push(() => target.removeEventListener(event, handler, options));
  }

  function stop() {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = 0;
  }

  function schedule() {
    stop();
    if (paused || !visible || document.visibilityState === 'hidden' || slides.length < 2) return;
    timer = window.setTimeout(() => {
      timer = 0;
      show(index + 1);
    }, AUTOPLAY_DELAY_MS);
  }

  function synchronizeControls() {
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(paused));
      toggle.setAttribute('aria-label', paused ? 'Otomatik görsel geçişini başlat' : 'Otomatik görsel geçişini durdur');
      toggle.classList.toggle('is-paused', paused);
    }
    root.dataset.showcasePlaying = String(!paused);
  }

  function show(candidate, { restart = true } = {}) {
    index = normalizeIndex(candidate, slides.length);
    const item = SHOWCASE_MEDIA[index];
    hydrateSlide(slides[index]);
    hydrateSlide(slides[normalizeIndex(index + 1, slides.length)]);
    track.style.transform = `translate3d(-${index * 100}%, 0, 0)`;
    for (let position = 0; position < slides.length; position += 1) {
      const active = position === index;
      slides[position].classList.toggle('is-active', active);
      slides[position].setAttribute('aria-hidden', String(!active));
      slides[position].toggleAttribute('inert', !active);
    }
    if (current) current.textContent = String(index + 1).padStart(2, '0');
    if (groupLabel) groupLabel.textContent = item.groupLabel;
    if (groupPosition) {
      groupPosition.textContent = item.kind === 'logo'
        ? 'MARKA LOGOSU · BAŞLANGIÇ'
        : `OYUN ${item.groupIndex}/${Math.max(1, item.groupTotal - 1)}`;
    }
    groupButtons.forEach((button) => {
      const active = button.dataset.showcaseGroupKey === item.groupKey;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
      if (active) button.scrollIntoView({ behavior: reducedMotion?.matches ? 'auto' : 'smooth', block: 'nearest', inline: 'center' });
    });
    if (progress) progress.style.setProperty('--showcase-progress', String((index + 1) / slides.length));
    root.dataset.showcaseIndex = String(index);
    if (restart) schedule();
  }

  function step(direction) {
    show(index + direction);
  }

  function onPointerDown(event) {
    if (event.target?.closest?.('[data-showcase-control]')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointer = { id: event.pointerId, x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
    stop();
  }

  function onPointerUp(event) {
    if (!pointer || (typeof event.pointerId === 'number' && pointer.id !== event.pointerId)) return;
    const horizontal = (Number(event.clientX) || 0) - pointer.x;
    const vertical = (Number(event.clientY) || 0) - pointer.y;
    pointer = null;
    if (Math.abs(horizontal) >= SWIPE_THRESHOLD_PX && Math.abs(horizontal) > Math.abs(vertical) * 1.2) {
      step(horizontal < 0 ? 1 : -1);
      return;
    }
    schedule();
  }

  function onPointerCancel() {
    pointer = null;
    schedule();
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      show(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      show(slides.length - 1);
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') stop();
    else schedule();
  }

  function onImageError(event) {
    const image = event.target;
    if (!image?.matches?.('[data-showcase-slide] img') || image.dataset.showcaseFallback === '1') return;
    image.dataset.showcaseFallback = '1';
    image.src = '/public/assets/images/shelby-store-brand.jpeg';
    image.alt = 'SHELBY STORE premium oyun mağazası';
  }

  if (total) total.textContent = String(slides.length).padStart(2, '0');
  if (previous) listen(previous, 'click', () => step(-1));
  if (next) listen(next, 'click', () => step(1));
  const releasePointerFocus = (event) => {
    if (event.pointerType !== 'mouse') event.currentTarget?.blur?.();
  };
  if (previous) listen(previous, 'pointerup', releasePointerFocus, { passive: true });
  if (next) listen(next, 'pointerup', releasePointerFocus, { passive: true });
  groupButtons.forEach((button) => {
    listen(button, 'click', () => show(Number(button.dataset.showcaseGroupTarget)));
    listen(button, 'pointerup', releasePointerFocus, { passive: true });
  });
  if (toggle) {
    listen(toggle, 'click', () => {
      paused = !paused;
      synchronizeControls();
      schedule();
    });
  }

  listen(viewport, 'pointerdown', onPointerDown, { passive: true });
  listen(viewport, 'pointerup', onPointerUp, { passive: true });
  listen(viewport, 'pointercancel', onPointerCancel, { passive: true });
  listen(root, 'keydown', onKeyDown);
  listen(root, 'error', onImageError, true);
  listen(document, 'visibilitychange', onVisibilityChange);
  listen(window, 'pagehide', stop);
  listen(window, 'pageshow', schedule);

  if (reducedMotion?.addEventListener) {
    listen(reducedMotion, 'change', (event) => {
      paused = event.matches;
      synchronizeControls();
      schedule();
    });
  }

  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      const entry = entries.find((item) => item.target === root);
      if (!entry) return;
      visible = entry.isIntersecting;
      if (visible) schedule();
      else stop();
    }, { threshold: 0.15 });
    observer.observe(root);
  }

  synchronizeControls();
  show(0);

  const controls = Object.freeze({
    next: () => step(1),
    previous: () => step(-1),
    goTo: (position) => show(position),
    destroy() {
      stop();
      observer?.disconnect();
      for (const remove of listeners.splice(0)) remove();
      instances.delete(root);
    }
  });
  instances.set(root, controls);
  return controls;
}
