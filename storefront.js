/**
 * FreeGameStore storefront interactions:
 *   - mode tabs (AI Assistant / Simple Search)
 *   - sort tabs (visual only)
 *   - split-pane preview (load game iframe on ≥1024px, navigate to about on <1024px)
 *   - ?game=<id> deep link, plus a fullscreen toolbar button (games need it)
 *
 * Theme toggle + mobile nav are handled by theme.js so they apply on every page.
 * Vendored — each store ships its own copy.
 */
(function () {
  // ---------- Mode tabs ----------
  (function () {
    var aiWrap = document.getElementById('aiInputWrap');
    var searchWrap = document.getElementById('searchInputWrap');
    var aiInput = document.getElementById('ai-prompt');
    if (!aiWrap || !searchWrap) return;

    document.querySelectorAll('.mode-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.mode-tab').forEach(function (t) {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        var mode = tab.dataset.mode;
        if (mode === 'ai') {
          aiWrap.hidden = false;
          searchWrap.hidden = true;
          if (aiInput) aiInput.focus();
        } else {
          aiWrap.hidden = true;
          searchWrap.hidden = false;
          var sb = document.getElementById('storefront-search');
          if (sb) sb.focus();
        }
      });
    });

    if (aiInput) {
      aiInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || !aiInput.value.trim()) return;
        e.preventDefault();
        var sb = document.getElementById('storefront-search');
        if (!sb) return;
        sb.value = aiInput.value;
        sb.dispatchEvent(new Event('input', { bubbles: true }));
        var searchTab = document.querySelector('.mode-tab[data-mode="search"]');
        if (searchTab) searchTab.click();
      });
    }
  })();

  // ---------- Sort tabs (visual only) ----------
  document.querySelectorAll('.apps-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.apps-tab').forEach(function (t) {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
    });
  });

  // ---------- Split-pane preview ----------
  (function () {
    var pane = document.getElementById('previewPane');
    if (!pane) return;
    var SPLIT_MQ = window.matchMedia('(min-width: 1024px)');
    var frame = document.getElementById('previewFrame');
    var empty = document.getElementById('previewEmpty');
    var title = document.getElementById('previewTitle');
    var btnNewTab = document.getElementById('previewNewTab');
    var btnAbout = document.getElementById('previewAbout');
    var btnClose = document.getElementById('previewClose');
    var btnFullscreen = document.getElementById('previewFullscreen');
    var current = null;

    function activate(card) {
      document.querySelectorAll('.app-card.compact.is-active').forEach(function (c) {
        c.classList.remove('is-active');
      });
      if (card) card.classList.add('is-active');
    }

    function setTitle(name, url) {
      var host = '';
      try { host = url ? new URL(url).host : ''; } catch (e) {}
      title.innerHTML = '';
      title.appendChild(document.createTextNode(name || 'No game selected'));
      if (host) {
        var hs = document.createElement('span');
        hs.className = 'preview-host';
        hs.textContent = host;
        title.appendChild(hs);
      }
    }

    function setUrlParam(value) {
      try {
        var u = new URL(window.location.href);
        if (value) u.searchParams.set('game', value);
        else u.searchParams.delete('game');
        history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      } catch (e) {}
    }

    function loadInPane(meta, card) {
      current = meta;
      pane.classList.add('is-loading');
      frame.hidden = false;
      empty.hidden = true;
      btnNewTab.hidden = false;
      if (btnAbout) btnAbout.hidden = !meta.aboutUrl;
      if (btnFullscreen) btnFullscreen.hidden = false;
      btnClose.hidden = false;
      setTitle(meta.name, meta.url);
      frame.src = meta.url;
      activate(card);
      frame.addEventListener('load', function once() {
        pane.classList.remove('is-loading');
        frame.removeEventListener('load', once);
      });
      setUrlParam(meta.id);
    }

    function clearPane() {
      current = null;
      frame.removeAttribute('src');
      frame.hidden = true;
      empty.hidden = false;
      btnNewTab.hidden = true;
      if (btnAbout) btnAbout.hidden = true;
      if (btnFullscreen) btnFullscreen.hidden = true;
      btnClose.hidden = true;
      setTitle(null, '');
      activate(null);
      pane.classList.remove('is-loading');
      setUrlParam(null);
    }

    function cardMeta(card) {
      var cta = card.querySelector('.app-cta');
      var name = card.querySelector('.app-name');
      var nameText = 'Game';
      if (name) {
        var n = name.firstChild;
        while (n && n.nodeType !== Node.TEXT_NODE) n = n.nextSibling;
        nameText = (n && n.textContent.trim()) || name.textContent.trim();
      }
      return {
        id: card.dataset.id || '',
        name: nameText,
        url: cta ? cta.getAttribute('href') : null,
        aboutUrl: card.dataset.about || null,
      };
    }

    document.querySelectorAll('#apps-grid .app-card.compact').forEach(function (card) {
      var aboutUrl = card.dataset.about;
      card.style.cursor = 'pointer';
      card.addEventListener('click', function (e) {
        var onCta = !!e.target.closest('.app-cta');
        if (SPLIT_MQ.matches) {
          e.preventDefault();
          loadInPane(cardMeta(card), card);
          return;
        }
        if (!onCta && aboutUrl) window.location.href = aboutUrl;
      });
    });

    if (btnNewTab) btnNewTab.addEventListener('click', function () {
      if (current && current.url) window.open(current.url, '_blank', 'noopener');
    });
    if (btnAbout) btnAbout.addEventListener('click', function () {
      if (current && current.aboutUrl) window.location.href = current.aboutUrl;
    });
    if (btnClose) btnClose.addEventListener('click', clearPane);
    if (btnFullscreen) btnFullscreen.addEventListener('click', function () {
      if (frame.requestFullscreen) frame.requestFullscreen();
      else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
    });

    // Deep link: ?game=<id> (also accept ?app= for cross-store URLs from FAS).
    try {
      var params = new URLSearchParams(window.location.search);
      var wantId = params.get('game') || params.get('app');
      if (wantId && SPLIT_MQ.matches) {
        var match = document.querySelector('#apps-grid .app-card.compact[data-id="' + CSS.escape(wantId) + '"]');
        if (match) loadInPane(cardMeta(match), match);
      }
    } catch (e) {}

    if (SPLIT_MQ.addEventListener) {
      SPLIT_MQ.addEventListener('change', function (e) { if (!e.matches) activate(null); });
    }
  })();
})();
