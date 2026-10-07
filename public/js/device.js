// Geräte-Erkennung (Schutz vor Mehrfach-Konten, siehe Datenschutzerklärung): meldet dem Server einmal pro
// Sitzung einen Hash aus Browser-Merkmalen und hält die Geräte-Kennung zusätzlich im lokalen Speicher.
(function () {
  'use strict';
  var script = document.currentScript;
  var csrf = script ? script.getAttribute('data-csrf') : '';
  var KEY = 'bfw.geraet';

  function cookie(name) {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(name + '=') === 0) return decodeURIComponent(p.slice(name.length + 1));
    }
    return '';
  }

  function canvasPrint() {
    try {
      var c = document.createElement('canvas');
      c.width = 240;
      c.height = 60;
      var g = c.getContext('2d');
      g.textBaseline = 'top';
      g.font = '16px Arial';
      g.fillStyle = '#f60';
      g.fillRect(100, 5, 80, 30);
      g.fillStyle = '#069';
      g.fillText('BfW Holdings, 0123 äöü €', 4, 8);
      g.fillStyle = 'rgba(120, 200, 10, .7)';
      g.font = '18px Georgia';
      g.fillText('BfW Holdings, 0123 äöü €', 8, 28);
      return c.toDataURL();
    } catch (err) {
      return '';
    }
  }

  function gpu() {
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return '';
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) + '|' + gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : String(gl.getParameter(gl.RENDERER));
    } catch (err) {
      return '';
    }
  }

  // Ersatz, falls der Browser keine Hash-Funktion anbietet
  function simpleHash(text) {
    var out = '';
    for (var seed = 0; seed < 4; seed++) {
      var h = 2166136261 ^ seed;
      for (var i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      out += ('0000000' + (h >>> 0).toString(16)).slice(-8);
    }
    return Promise.resolve(out);
  }

  function hash(text) {
    if (!window.crypto || !crypto.subtle || !window.TextEncoder) return simpleHash(text);
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('').slice(0, 40);
    }, function () { return simpleHash(text); });
  }

  var n = navigator;
  var tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (err) { /* ohne Zeitzone */ }
  var traits = [
    n.userAgent, n.platform, (n.languages || []).join(','), n.hardwareConcurrency, n.deviceMemory, n.maxTouchPoints,
    screen.width + 'x' + screen.height + 'x' + screen.colorDepth, window.devicePixelRatio, tz, gpu(), canvasPrint(),
  ].join('~');

  // Kennung im lokalen Speicher aufbewahren; fehlt das Cookie später, schickt der Browser die alte Kennung mit
  var stored = '';
  try {
    stored = localStorage.getItem(KEY) || '';
    if (!stored && cookie(KEY)) localStorage.setItem(KEY, cookie(KEY));
  } catch (err) { /* lokaler Speicher gesperrt */ }

  hash(traits).then(function (fp) {
    var body = new URLSearchParams();
    body.set('_csrf', csrf);
    body.set('fp', fp);
    if (n.webdriver) body.set('wd', '1'); // ferngesteuerter Browser (Selenium, Puppeteer …)
    if (stored && stored !== cookie(KEY)) body.set('alt', stored);
    return fetch('/geraet', { method: 'POST', body: body, credentials: 'same-origin' });
  }).catch(function () { /* nicht wichtig für die Seite */ });
})();
