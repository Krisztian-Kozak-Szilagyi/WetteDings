// eSports Deep Dive (views/esports-guide.ejs): Präsentation mit ganzen Seiten.
// Jede Folie hat versteckt ihre Schritte (<ol data-gd-steps>, erster Eintrag ohne data-gd-step = Einleitung).
// „Weiter“ läuft alle Schritte aller Folien der Reihe nach durch. Pro Schritt: Erklärung oben (bleibt stehen),
// die passende Stelle [data-gd="n"] wird ausgeleuchtet (Spot mit Abdunklung drumherum) und in die Mitte gescrollt.
(() => {
  const root = document.querySelector('[data-gd-root]');
  if (!root) return;
  const $ = (sel) => root.querySelector(`[data-gd-${sel}]`);
  const slides = [...root.querySelectorAll('[data-gd-slide]')];
  const caption = $('caption');
  const prev = $('prev');
  const next = $('next');
  const dots = $('dots');

  // alle Schritte als flache Liste: { slide, n (0 = Einleitung), title, text }
  const steps = [];
  slides.forEach((s, si) => {
    s.querySelectorAll('[data-gd-steps] > li').forEach((li) => {
      steps.push({ si, n: Number(li.dataset.gdStep || 0), title: li.dataset.title || '', text: li.textContent.trim() });
    });
  });
  const firstOf = (si) => steps.findIndex((x) => x.si === si);
  let cur = 0;

  slides.forEach((s, si) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gd-dot';
    b.setAttribute('aria-label', `Folie ${si + 1}: ${s.dataset.title}`);
    b.addEventListener('click', () => go(firstOf(si)));
    dots.appendChild(b);
  });

  /** Spot über alle Stellen mit data-gd="n" legen → Rechteck (Seitenkoordinaten) oder null */
  function spot(slide, n) {
    const screen = slide.querySelector('.gd-screen');
    let el = screen.querySelector('.gd-spot');
    if (!el) {
      el = document.createElement('div');
      el.className = 'gd-spot';
      el.setAttribute('aria-hidden', 'true');
      screen.appendChild(el);
    }
    const targets = n ? [...screen.querySelectorAll(`[data-gd="${n}"]`)] : [];
    screen.classList.toggle('is-dim', targets.length > 0);
    if (!targets.length) {
      el.hidden = true;
      return null;
    }
    const base = screen.getBoundingClientRect();
    const rs = targets.map((t) => t.getBoundingClientRect());
    const pad = 8;
    const left = Math.min(...rs.map((r) => r.left)) - base.left - pad;
    const top = Math.min(...rs.map((r) => r.top)) - base.top - pad;
    const right = Math.max(...rs.map((r) => r.right)) - base.left + pad;
    const bottom = Math.max(...rs.map((r) => r.bottom)) - base.top + pad;
    el.hidden = false;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${right - left}px`;
    el.style.height = `${bottom - top}px`;
    return { top: base.top + window.scrollY + top, height: bottom - top };
  }

  /** Stelle mittig in den freien Bereich unter der Erklärung scrollen */
  function scrollTo(rect, slide) {
    const capBottom = caption.getBoundingClientRect().bottom;
    const free = window.innerHeight - capBottom;
    let y;
    if (rect) y = rect.top - capBottom - Math.max(16, (free - rect.height) / 2);
    else y = slide.getBoundingClientRect().top + window.scrollY - capBottom - 16;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }

  function go(i, { scroll = true } = {}) {
    cur = Math.max(0, Math.min(steps.length - 1, i));
    const st = steps[cur];
    slides.forEach((s, si) => {
      s.hidden = si !== st.si;
    });
    const slide = slides[st.si];
    const inSlide = steps.filter((x) => x.si === st.si);
    const pos = inSlide.indexOf(st);
    $('kicker').textContent = `Folie ${st.si + 1} von ${slides.length} · ${slide.dataset.title}`;
    $('count').textContent = pos > 0 ? `Schritt ${pos} von ${inSlide.length - 1}` : '';
    $('ctitle').textContent = st.title;
    $('ctext').textContent = st.text;
    [...dots.children].forEach((d, k) => d.classList.toggle('is-on', k === st.si));
    prev.disabled = cur === 0;
    next.textContent = cur === steps.length - 1 ? 'Zurück zu eSports' : 'Weiter';
    const rect = spot(slide, st.n);
    if (scroll) scrollTo(rect, slide);
    history.replaceState(null, '', `#schritt-${cur + 1}`);
  }

  next.addEventListener('click', () => (cur === steps.length - 1 ? window.location.assign('/esports') : go(cur + 1)));
  prev.addEventListener('click', () => go(cur - 1));
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      next.click();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(cur - 1);
    }
  });
  // Spot bei geänderter Fenstergröße und nach dem Laden der Bilder neu anlegen
  const refresh = () => spot(slides[steps[cur].si], steps[cur].n);
  window.addEventListener('resize', refresh);
  window.addEventListener('load', refresh);

  const m = /^#schritt-(\d+)$/.exec(window.location.hash);
  go(m ? Number(m[1]) - 1 : 0, { scroll: !!m });
})();
