// eSports Deep Dive (views/esports-guide.ejs): Folien wie eine Präsentation. „Weiter“ geht erst durch die Schritte der
// Folie (hebt die passende Stelle im Nachbau hervor), dann zur nächsten Folie. Pfeiltasten, Punkte und #folie-n gehen auch.
(() => {
  const root = document.querySelector('[data-gd-root]');
  if (!root) return;
  const slides = [...root.querySelectorAll('[data-gd-slide]')];
  const dots = root.querySelector('[data-gd-dots]');
  const title = root.querySelector('[data-gd-title]');
  const count = root.querySelector('[data-gd-count]');
  const prev = root.querySelector('[data-gd-prev]');
  const next = root.querySelector('[data-gd-next]');
  let cur = 0;
  let step = 0; // 0 = Überblick ohne Hervorhebung

  const stepsOf = (s) => [...s.querySelectorAll('[data-gd-step]')];

  slides.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gd-dot';
    b.setAttribute('aria-label', `Folie ${i + 1}: ${s.dataset.title}`);
    b.addEventListener('click', () => go(i, 0));
    dots.appendChild(b);
    stepsOf(s).forEach((btn) => btn.addEventListener('click', () => go(i, Number(btn.dataset.gdStep) === step ? 0 : Number(btn.dataset.gdStep))));
  });

  function focus(s, n) {
    s.classList.toggle('is-guiding', n > 0);
    s.querySelectorAll('[data-gd]').forEach((el) => el.classList.remove('is-focus', 'is-parent'));
    stepsOf(s).forEach((btn) => btn.classList.toggle('is-active', Number(btn.dataset.gdStep) === n));
    if (!n) return;
    s.querySelectorAll(`[data-gd="${n}"]`).forEach((el) => {
      el.classList.add('is-focus');
      // eine hervorgehobene Stelle in einer anderen: die äußere nicht abdunkeln
      let p = el.parentElement.closest('[data-gd]');
      while (p && s.contains(p)) {
        p.classList.add('is-parent');
        p = p.parentElement.closest('[data-gd]');
      }
    });
  }

  function go(i, n = 0) {
    cur = Math.max(0, Math.min(slides.length - 1, i));
    step = n;
    slides.forEach((s, k) => {
      s.hidden = k !== cur;
    });
    const s = slides[cur];
    focus(s, step);
    title.textContent = s.dataset.title;
    count.textContent = `${cur + 1} / ${slides.length}`;
    [...dots.children].forEach((d, k) => d.classList.toggle('is-on', k === cur));
    prev.disabled = cur === 0 && step === 0;
    const last = cur === slides.length - 1 && step >= stepsOf(s).length;
    next.textContent = last ? 'Zurück zu eSports' : 'Weiter';
    if (window.location.hash !== `#folie-${cur + 1}`) history.replaceState(null, '', `#folie-${cur + 1}`);
  }

  function forward() {
    const total = stepsOf(slides[cur]).length;
    if (step < total) return go(cur, step + 1);
    if (cur < slides.length - 1) return go(cur + 1, 0);
    window.location.assign('/esports');
  }
  function back() {
    if (step > 0) return go(cur, step - 1);
    if (cur > 0) go(cur - 1, stepsOf(slides[cur - 1]).length);
  }

  next.addEventListener('click', forward);
  prev.addEventListener('click', back);
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      forward();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      back();
    }
  });

  const m = /^#folie-(\d+)$/.exec(window.location.hash);
  go(m ? Number(m[1]) - 1 : 0, 0);
})();
