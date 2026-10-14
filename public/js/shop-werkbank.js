// Shop-Demo-Arbeitstisch (views/shop-werkbank.ejs): „?“ blendet die ausführlichen Erklärungen ein und aus.
// Der Tisch selbst ist der Grading-Tisch der Seite (public/js/grading.js) – hier nur das Fenster drumherum.
(function () {
  var btn = document.querySelector('[data-sd-help]');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var on = document.body.classList.toggle('is-help');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
})();
