(function () {
  'use strict';

  var RARE_RANK = 3; // ab Holo gibt es den großen Auftritt

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function showFlash(type, message) {
    var area = $('[data-flash-area]');
    if (!area) return window.alert(message);
    area.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'flash flash-' + type;
    div.setAttribute('role', 'status');
    var span = document.createElement('span');
    span.textContent = message;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'flash-close';
    close.setAttribute('aria-label', 'Hinweis schließen');
    close.textContent = '×';
    div.appendChild(span);
    div.appendChild(close);
    area.appendChild(div);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- Filter der Sammlung ----------
  $all('[data-tcg-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-tcg-filter');
      $all('[data-tcg-filter]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      $all('.tcg-grid .tcg-slot').forEach(function (slot) {
        slot.hidden = key !== 'all' && slot.getAttribute('data-rarity') !== key;
      });
    });
  });

  // ---------- 3D-Neigung (Zoom-Ansicht) ----------
  function bindTilt(el) {
    if (!el) return;
    el.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width;
      var y = (e.clientY - r.top) / r.height;
      el.style.setProperty('--rx', ((0.5 - y) * 18).toFixed(2) + 'deg');
      el.style.setProperty('--ry', ((x - 0.5) * 22).toFixed(2) + 'deg');
      el.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
      el.style.setProperty('--my', (y * 100).toFixed(1) + '%');
      el.classList.add('tilting');
    });
    el.addEventListener('pointerleave', function () {
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
      el.classList.remove('tilting');
    });
  }

  // ---------- Karte vergrößern + verkaufen ----------
  var modal = $('[data-tcg-modal]');
  if (modal) {
    var tilt = $('[data-tcg-tilt]', modal);
    bindTilt(tilt);

    var sellOne = $('[data-tcg-sell-one]', modal);
    var sellDupes = $('[data-tcg-sell-dupes]', modal);

    document.addEventListener('click', function (e) {
      var slot = e.target.closest('[data-tcg-card]');
      if (!slot) return;
      var d = slot.dataset;
      var count = parseInt(d.count, 10) || 0;
      var rank = parseInt(d.rank, 10) || 0;
      var sell = parseInt(d.sell, 10) || 0;

      tilt.className = 'tcg-zoom r-' + d.rarity;
      $('[data-tcg-modal-img]', modal).src = d.image;
      $('[data-tcg-modal-img]', modal).alt = d.name + ' (' + d.rarityLabel + ')';
      $('[data-tcg-modal-name]', modal).textContent = d.name;
      var badge = $('[data-tcg-modal-rarity]', modal);
      badge.textContent = d.rarityLabel;
      badge.className = 'tcg-badge r-' + d.rarity;
      $('[data-tcg-modal-count]', modal).textContent = count === 1 ? '1 Stück im Besitz' : count + ' Stück im Besitz';

      sellOne.querySelector('input[name="card"]').value = d.tcgCard;
      $('[data-tcg-sell-text]', sellOne).textContent = d.sellText;
      if (rank >= RARE_RANK) {
        sellOne.setAttribute('data-confirm', d.name + ' (' + d.rarityLabel + ') wirklich für ' + d.sellText + ' verkaufen?');
      } else {
        sellOne.removeAttribute('data-confirm');
      }

      sellDupes.hidden = count < 2;
      if (count > 1) {
        var total = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(((count - 1) * sell) / 100);
        sellDupes.querySelector('input[name="card"]').value = d.tcgCard;
        sellDupes.querySelector('button').textContent = 'Duplikate verkaufen (' + (count - 1) + '×) · ' + total;
        sellDupes.setAttribute('data-confirm', (count - 1) + '× ' + d.name + ' verkaufen und eine behalten?');
      }

      if (typeof modal.showModal === 'function') modal.showModal();
      else modal.setAttribute('open', '');
    });

    function closeModal() {
      if (typeof modal.close === 'function') modal.close();
      else modal.removeAttribute('open');
    }
    $('[data-tcg-close]', modal).addEventListener('click', closeModal);
    // Klick auf den Hintergrund schließt
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });
  }

  // ---------- Pack öffnen ----------
  var form = $('[data-tcg-open]');
  var reveal = $('[data-tcg-reveal]');
  if (!form || !reveal || !window.fetch) return;

  var packBtn = $('[data-tcg-pack]', reveal);
  var cardsBox = $('[data-tcg-cards]', reveal);
  var actions = $('[data-tcg-actions]', reveal);
  var hint = $('[data-tcg-hint]', reveal);
  var flipAllBtn = $('[data-tcg-flip-all]', reveal);
  var againBtn = $('[data-tcg-again]', reveal);
  var doneBtn = $('[data-tcg-done]', reveal);

  var state = { busy: false, cards: null, flipped: 0, canAfford: true, opened: false };

  function setBalance(text) {
    $all('[data-tcg-balance]').forEach(function (el) { el.textContent = text; });
    var chip = $('[data-live="balance"] strong');
    if (chip) chip.textContent = text;
  }

  function resetStage() {
    reveal.classList.remove('all-flipped');
    packBtn.hidden = false;
    packBtn.className = 'tcg-reveal-pack';
    packBtn.disabled = true;
    cardsBox.innerHTML = '';
    actions.hidden = true;
    state.cards = null;
    state.flipped = 0;
    state.opened = false;
  }

  function openPack() {
    if (state.busy) return;
    state.busy = true;
    resetStage();
    reveal.hidden = false;
    document.body.classList.add('tcg-noscroll');
    hint.textContent = 'Pack wird gekauft …';

    fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(new FormData(form)).toString(),
      credentials: 'same-origin',
    })
      .then(function (res) {
        return res.json().catch(function () { return { error: 'Das hat nicht geklappt. Bitte lade die Seite neu.' }; });
      })
      .then(function (data) {
        state.busy = false;
        if (data.error) {
          closeReveal(false);
          showFlash('error', data.error);
          return;
        }
        setBalance(data.balance);
        state.canAfford = data.canAfford;
        // Seltenste Karte zuletzt – für die Spannung
        state.cards = data.cards.slice().sort(function (a, b) { return a.rank - b.rank; });
        packBtn.disabled = false;
        packBtn.classList.add('ready');
        hint.textContent = 'Tippe auf das Pack, um es aufzureißen';
        packBtn.focus();
      })
      .catch(function () {
        state.busy = false;
        closeReveal(false);
        showFlash('error', 'Keine Verbindung. Bitte versuche es erneut.');
      });
  }

  function tearPack() {
    if (!state.cards || state.opened) return;
    state.opened = true;
    packBtn.classList.remove('ready');
    packBtn.classList.add('torn');
    hint.textContent = '';
    setTimeout(function () {
      packBtn.hidden = true;
      dealCards();
    }, 650);
  }

  function dealCards() {
    state.cards.forEach(function (c, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tcg-flip r-' + c.rarity + (c.rank >= RARE_RANK ? ' tcg-rare-hint' : '');
      btn.style.animationDelay = i * 140 + 'ms';
      btn.setAttribute('aria-label', 'Karte ' + (i + 1) + ' aufdecken');
      btn.innerHTML =
        '<span class="tcg-flip-inner">' +
          '<span class="tcg-face tcg-back"><span class="tcg-back-logo"><span>BfW</span></span></span>' +
          '<span class="tcg-face tcg-front"><img alt="" width="720" height="1008"><span class="tcg-shine"></span></span>' +
        '</span>' +
        '<span class="tcg-flip-label"><span class="tcg-dot"></span><span></span></span>';
      var img = btn.querySelector('img');
      img.src = c.image;
      img.alt = c.name + ' (' + c.rarityLabel + ')';
      btn.querySelector('.tcg-flip-label span:last-child').textContent = c.rarityLabel + ' · ' + c.sell;
      btn.addEventListener('click', function () { flip(btn, c); });
      cardsBox.appendChild(btn);
    });
    hint.textContent = 'Tippe die Karten an, um sie aufzudecken';
    actions.hidden = false;
    flipAllBtn.hidden = false;
    againBtn.hidden = true;
    doneBtn.hidden = true;
    var first = cardsBox.querySelector('.tcg-flip');
    if (first) first.focus();
  }

  function flip(btn, c) {
    if (btn.classList.contains('flipped')) return;
    btn.classList.add('flipped');
    btn.setAttribute('aria-label', c.name + ' (' + c.rarityLabel + ')');
    if (c.rank >= RARE_RANK) {
      btn.classList.add('tcg-burst');
      reveal.classList.add('flash-' + c.rarity);
      setTimeout(function () { reveal.classList.remove('flash-' + c.rarity); }, 900);
    }
    state.flipped++;
    if (state.flipped === state.cards.length) finish();
  }

  function finish() {
    reveal.classList.add('all-flipped');
    var best = state.cards[state.cards.length - 1];
    hint.textContent = best.rank >= RARE_RANK ? 'Wow – ' + best.name + ' (' + best.rarityLabel + ')!' : 'Alle Karten sind in deiner Sammlung.';
    flipAllBtn.hidden = true;
    againBtn.hidden = false;
    againBtn.disabled = !state.canAfford;
    againBtn.title = state.canAfford ? '' : 'Dein Guthaben reicht nicht für ein weiteres Pack.';
    doneBtn.hidden = false;
    doneBtn.focus();
  }

  function flipAll() {
    $all('.tcg-flip', cardsBox).forEach(function (btn, i) {
      setTimeout(function () { btn.click(); }, i * 220);
    });
  }

  function closeReveal(reload) {
    if (reload) {
      window.location.hash = 'sammlung';
      window.location.reload();
      return;
    }
    reveal.hidden = true;
    document.body.classList.remove('tcg-noscroll');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    openPack();
  });
  packBtn.addEventListener('click', tearPack);
  flipAllBtn.addEventListener('click', flipAll);
  againBtn.addEventListener('click', openPack);
  doneBtn.addEventListener('click', function () { closeReveal(true); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !reveal.hidden && reveal.classList.contains('all-flipped')) closeReveal(true);
  });
})();
