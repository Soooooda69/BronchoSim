// Play videos marked data-autoplay-inview only while they are on screen, so a
// page with dozens of looping clips does not decode all of them at once.
function setupAutoplayInView() {
  const videos = document.querySelectorAll('video[data-autoplay-inview]');
  if (!('IntersectionObserver' in window)) {
    videos.forEach(v => v.play().catch(() => {}));
    return;
  }
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const video = entry.target;
      if (entry.isIntersecting) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });
  }, { threshold: 0.35 });
  videos.forEach(v => observer.observe(v));
}

// Paged video grid: .gallery-page children, one visible at a time, switched by
// generated dots and prev/next arrows. Hidden pages never intersect the viewport,
// so their videos (preload="none") are not fetched until the page is opened.
function setupPager(root) {
  const pages = [...root.querySelectorAll('.gallery-page')];
  const dots = root.querySelector('.pager-dots');
  if (!pages.length || !dots) return;
  let current = 0;
  const show = i => {
    current = (i + pages.length) % pages.length;
    pages.forEach((p, k) => p.classList.toggle('is-active', k === current));
    [...dots.children].forEach((d, k) => d.classList.toggle('is-active', k === current));
  };
  pages.forEach((_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pager-dot';
    b.setAttribute('aria-label', `Page ${i + 1}`);
    b.addEventListener('click', () => show(i));
    dots.appendChild(b);
  });
  root.querySelector('[data-pager=prev]')?.addEventListener('click', () => show(current - 1));
  root.querySelector('[data-pager=next]')?.addEventListener('click', () => show(current + 1));
  show(0);
}

// Videos in a [data-sync-group] are frame-aligned files, but each <video> starts,
// buffers and loops on its own clock. Snap the others to the [data-sync-master]
// whenever they drift by more than a few frames.
function setupSyncGroup(group) {
  const master = group.querySelector('video[data-sync-master]');
  if (!master) return;
  const others = [...group.querySelectorAll('video')].filter(v => v !== master);
  const sync = () => others.forEach(v => {
    if (v.readyState >= 1 && Math.abs(v.currentTime - master.currentTime) > 0.1) {
      v.currentTime = master.currentTime;
    }
  });
  ['play', 'seeked', 'timeupdate'].forEach(e => master.addEventListener(e, sync));
}

document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-pager-root]').forEach(setupPager);
  document.querySelectorAll('[data-sync-group]').forEach(setupSyncGroup);
  setupAutoplayInView();
});
