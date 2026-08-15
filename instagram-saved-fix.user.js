// ==UserScript==
// @name         Instagram — Fix coleções salvas (endpoint morto)
// @namespace    local.ig.savedfix
// @version      1.5.0
// @description  O endpoint /api/v1/feed/collection/<id>/posts/ foi descontinuado pela Meta (404 / "Dead endpoint save.api.views.* unshipped"). Este script intercepta a chamada (fetch e XHR) e reconstrói a resposta a partir de /api/v1/feed/saved/posts/, filtrando por saved_collection_ids. O índice é varrido incrementalmente e persistido página a página em IndexedDB, então é retomável.
// @author       Gabriel Francato
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // ---------------------------------------------------------------- config --
  const VERSION = '1.5.0';

  const CFG = {
    FEED_COUNT: 50,          // itens por página do feed geral (default da IG: 21)
    HARD_PAGE_CAP: 80,       // teto absoluto de páginas
    CACHE_TTL_MIN: 60 * 24 * 7, // validade do índice (7 dias)
    RETRIES: 3,              // tentativas por página em 429/5xx
    TOPUP_MAX_PAGES: 5,      // páginas varridas no top-up incremental
    PREFETCH_DELAY_MS: 1500, // atraso do prefetch pra não competir com o load
    MAX_WAIT_MS: 8000,       // quanto esperar o índice antes de servir parcial
    DEBUG: true,
    BADGE: true,
  };

  const COLLECTION_RE = /\/api\/v1\/feed\/collection\/(\d+)\/(?:posts|all|media)\/?/;
  const SAVED_PATH = '/api/v1/feed/saved/posts/';
  const DB_NAME = 'ig-saved-fix';
  const STORE = 'cache';
  const META_KEY = 'meta';
  const HEAD_KEY = 'head'; // itens salvos DEPOIS da varredura inicial
  const pageKey = (n) => `p:${String(n).padStart(4, '0')}`; // zero-pad: ordem lexicográfica = ordem numérica

  const log = (...a) => CFG.DEBUG && console.log('%c[ig-saved-fix]', 'color:#0af;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[ig-saved-fix]', 'color:#fa0;font-weight:bold', ...a);

  const origFetch = window.fetch.bind(window);

  try { document.documentElement.dataset.igSavedFix = VERSION; } catch { /* noop */ }

  // ------------------------------------------------------------- badge -----
  let badgeEl = null;
  let onBadgeClick = async () => { await cacheClear().catch(() => {}); location.reload(); };

  function badge(text, color = '#0a7', handler = null) {
    if (!CFG.BADGE) return;
    onBadgeClick = handler || (async () => { await cacheClear().catch(() => {}); location.reload(); });
    const paint = () => {
      if (!document.body) return;
      if (!badgeEl) {
        badgeEl = document.createElement('div');
        badgeEl.style.cssText = [
          'position:fixed', 'z-index:2147483647', 'bottom:12px', 'left:12px',
          'padding:6px 10px', 'border-radius:6px', 'cursor:pointer',
          'font:12px/1.3 ui-monospace,monospace', 'color:#fff', 'opacity:.92',
        ].join(';');
        badgeEl.addEventListener('click', () => onBadgeClick());
        document.body.appendChild(badgeEl);
      }
      badgeEl.title = 'clique para reindexar os salvos';
      badgeEl.textContent = `ig-saved-fix ${text}`;
      badgeEl.style.background = color;
    };
    if (document.body) paint();
    else document.addEventListener('DOMContentLoaded', paint, { once: true });
  }

  // ---------------------------------------------------------- IndexedDB ----
  // Cada página vira um registro próprio (p:0000, p:0001, …) e o meta guarda
  // cursor/done. Assim a gravação por página é barata e o crawl é RETOMÁVEL:
  // gravar o buffer inteiro a cada página custaria um structured-clone de
  // dezenas de MB, e gravar só no fim (v1.3) perdia tudo em qualquer reload.
  function openDb() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }

  function withStore(mode, run) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      let out;
      try {
        const tx = db.transaction(STORE, mode);
        out = run(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : out); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      } catch (e) { db.close(); reject(e); }
    }));
  }

  const metaGet = () => withStore('readonly', (s) => s.get(META_KEY));
  const metaSet = (meta) => withStore('readwrite', (s) => s.put(meta, META_KEY));
  const pagePut = (n, items) => withStore('readwrite', (s) => s.put(items, pageKey(n)));
  const cacheClear = () => withStore('readwrite', (s) => s.clear());
  const headGet = () => withStore('readonly', (s) => s.get(HEAD_KEY));
  const headSet = (items) => withStore('readwrite', (s) => s.put(items, HEAD_KEY));

  function loadPages(count) {
    return withStore('readonly', (s) => s.getAll(IDBKeyRange.bound(pageKey(0), pageKey(count))));
  }

  // ------------------------------------------------------------- estado ----
  const crawl = {
    buffer: [],
    head: [],
    cursor: undefined,
    done: false,
    pages: 0,
    promise: null,
    countSupported: true,
    servedPartial: false,
  };

  let APP_ID = null;
  const appId = () => (APP_ID ||= (
    document.documentElement.innerHTML.match(/"APP_ID":"(\d+)"/) || [, '936619743392459']
  )[1]);

  // ------------------------------------------------- varredura do feed -----
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  // 429/5xx são transitórios. Numa varredura de ~40 requisições sequenciais um
  // 503 solitário derrubava o crawl inteiro (foi o que aconteceu na v1.4).
  async function fetchSavedRaw(path) {
    let last = 0;
    for (let attempt = 1; attempt <= CFG.RETRIES; attempt += 1) {
      const res = await origFetch(path, {
        headers: { 'X-IG-App-ID': appId(), 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
      });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) return res; // erro definitivo: quem chamou trata
      last = res.status;
      const wait = 2000 * (2 ** (attempt - 1));
      warn(`${res.status} na varredura, tentativa ${attempt}/${CFG.RETRIES}, aguardando ${wait / 1000}s`);
      await sleepMs(wait);
    }
    throw new Error(`${SAVED_PATH} falhou após ${CFG.RETRIES} tentativas (último status ${last})`);
  }

  async function fetchSavedPage() {
    const url = new URL(SAVED_PATH, location.origin);
    if (crawl.cursor) url.searchParams.set('max_id', crawl.cursor);
    if (CFG.FEED_COUNT && crawl.countSupported) url.searchParams.set('count', String(CFG.FEED_COUNT));

    const res = await fetchSavedRaw(url.pathname + url.search);

    if (!res.ok && crawl.countSupported && CFG.FEED_COUNT) {
      warn(`count=${CFG.FEED_COUNT} rejeitado (${res.status}); repetindo sem o parâmetro`);
      crawl.countSupported = false;
      return fetchSavedPage();
    }
    if (!res.ok) throw new Error(`${SAVED_PATH} respondeu ${res.status}`);

    const json = await res.json();
    const items = Array.isArray(json.items) ? json.items : [];

    const index = crawl.pages;
    crawl.buffer.push(...items);
    crawl.cursor = json.next_max_id;
    crawl.pages += 1;
    crawl.done = !json.more_available || !json.next_max_id || items.length === 0;

    // grava ANTES de seguir: se o usuário recarregar agora, nada se perde
    await pagePut(index, items).catch((e) => warn('falha ao gravar página:', e));
    await metaSet({
      at: Date.now(), cursor: crawl.cursor, done: crawl.done, pages: crawl.pages, version: VERSION,
    }).catch((e) => warn('falha ao gravar meta:', e));

    log(`varredura: +${items.length} (total ${crawl.buffer.length}, página ${crawl.pages}, fim=${crawl.done})`);
    return items.length;
  }

  async function resumeFromCache() {
    try {
      const meta = await metaGet();
      if (!meta || !meta.pages) return false;

      const ageMin = (Date.now() - meta.at) / 60000;
      if (ageMin > CFG.CACHE_TTL_MIN) {
        log(`cache expirado (${Math.round(ageMin)} min), reindexando`);
        await cacheClear().catch(() => {});
        return false;
      }

      const pages = await loadPages(meta.pages);
      const head = (await headGet().catch(() => null)) || [];
      const items = head.concat(pages.flat());
      if (!items.length) return false;

      crawl.head = head;
      crawl.buffer = items;
      crawl.cursor = meta.cursor;
      crawl.done = !!meta.done;
      crawl.pages = meta.pages;

      log(`cache: ${items.length} itens em ${meta.pages} páginas (${Math.round(ageMin)} min), completo=${crawl.done}`);
      return true;
    } catch (e) {
      warn('cache indisponível:', e);
      return false;
    }
  }

  const idOf = (item) => {
    const m = (item && (item.media || item)) || {};
    return String(m.pk || m.id || '');
  };

  // Índice completo em cache + você salvou posts novos: em vez de revarrer 2000
  // itens, lê só o topo do feed até reencontrar algo já conhecido.
  async function topUp() {
    const known = new Set(crawl.buffer.map(idOf));
    const fresh = [];
    let cursor = null;

    for (let page = 0; page < CFG.TOPUP_MAX_PAGES; page += 1) {
      const url = new URL(SAVED_PATH, location.origin);
      if (cursor) url.searchParams.set('max_id', cursor);
      if (CFG.FEED_COUNT && crawl.countSupported) url.searchParams.set('count', String(CFG.FEED_COUNT));

      const res = await fetchSavedRaw(url.pathname + url.search);
      if (!res.ok) { warn(`top-up abortado (${res.status})`); break; }

      const json = await res.json();
      const items = Array.isArray(json.items) ? json.items : [];
      const novos = items.filter((it) => !known.has(idOf(it)));
      fresh.push(...novos);

      // apareceu item conhecido => emendou no que já estava indexado
      if (novos.length < items.length || !json.more_available || !json.next_max_id) break;
      cursor = json.next_max_id;
    }

    if (!fresh.length) { log('top-up: nada novo'); return; }

    crawl.head = fresh.concat(crawl.head || []);
    crawl.buffer = fresh.concat(crawl.buffer);
    await headSet(crawl.head).catch((e) => warn('falha ao gravar head:', e));
    log(`top-up: +${fresh.length} salvos novos (total ${crawl.buffer.length})`);
  }

  // Varredura sequencial: a paginação é por cursor, então preciso do
  // next_max_id de uma página pra pedir a próxima. Não há como paralelizar.
  function ensureIndex() {
    if (crawl.promise) return crawl.promise;

    crawl.promise = (async () => {
      await resumeFromCache();
      if (crawl.done) {
        badge(`${crawl.buffer.length} salvos em cache`, '#06c');
        await topUp().catch((e) => warn('top-up falhou:', e));
        badge(`${crawl.buffer.length} salvos em cache`, '#06c');
        return;
      }

      const t0 = performance.now();
      const startCount = crawl.buffer.length;

      while (!crawl.done && crawl.pages < CFG.HARD_PAGE_CAP) {
        await fetchSavedPage();
        badge(`indexando… ${crawl.buffer.length} salvos`, '#c60');
      }

      if (!crawl.done) warn(`teto de ${CFG.HARD_PAGE_CAP} páginas, índice pode estar incompleto`);

      const secs = Math.round((performance.now() - t0) / 1000);
      log(`índice pronto: ${crawl.buffer.length} itens (+${crawl.buffer.length - startCount} nesta sessão, ${secs}s)`);

      if (crawl.servedPartial) {
        badge('índice completo, clique para recarregar', '#c60', () => location.reload());
      } else {
        badge(`${crawl.buffer.length} salvos indexados`, '#06c');
      }
    })().catch((err) => {
      crawl.promise = null; // permite nova tentativa
      throw err;
    });

    return crawl.promise;
  }

  // --------------------------------------------------------------- filtro --
  const mediaOf = (item) => (item && (item.media || item)) || {};
  const belongsTo = (item, id) => {
    const ids = mediaOf(item).saved_collection_ids;
    return Array.isArray(ids) && ids.some((x) => String(x) === String(id));
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Devolve a coleção inteira de uma vez (more_available: false). Paginar aqui
  // trava a grade: com filtro esparso a página sai curta, não enche a viewport,
  // o scroll infinito nunca dispara e nada mais é pedido.
  async function buildPayload(collectionId) {
    // Não bloqueia indefinidamente: se o índice ainda está sendo varrido,
    // serve o que já existe e avisa quando ficar completo.
    const done = await Promise.race([
      ensureIndex().then(() => true).catch(() => true),
      sleep(CFG.MAX_WAIT_MS).then(() => false),
    ]);

    if (!done) {
      crawl.servedPartial = true;
      warn(`índice ainda incompleto (${crawl.buffer.length} itens), servindo resultado parcial`);
    }

    const items = crawl.buffer.filter((it) => belongsTo(it, collectionId));
    log(`coleção ${collectionId}: ${items.length} itens de ${crawl.buffer.length} salvos varridos`);

    return {
      items,
      num_results: items.length,
      more_available: false,
      next_max_id: null,
      auto_load_more_enabled: false,
      status: 'ok',
    };
  }

  // ------------------------------------------------------- patch do fetch --
  window.fetch = async function patchedFetch(input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch { /* noop */ }

    const match = url && COLLECTION_RE.exec(url);
    if (!match) return origFetch(input, init);

    log(`fetch interceptado: coleção ${match[1]}`);
    try {
      const payload = await buildPayload(match[1]);
      return new Response(JSON.stringify(payload), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    } catch (err) {
      warn('falha ao reconstruir; repassando pro fetch original:', err);
      badge('ERRO, ver console', '#c00');
      return origFetch(input, init);
    }
  };

  // ------------------------------------------------ patch do XMLHttpRequest -
  // É por aqui que a IG realmente chama o endpoint (stack: send @ ...).
  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSend = XHR.prototype.send;
  const TAG = '__igSavedFix__';

  function fakeXhrResponse(xhr, url, text) {
    const define = (prop, value) => {
      try { Object.defineProperty(xhr, prop, { configurable: true, get: () => value }); }
      catch { /* noop */ }
    };

    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* noop */ }

    const type = xhr.responseType;
    define('readyState', 4);
    define('status', 200);
    define('statusText', 'OK');
    define('responseURL', new URL(url, location.origin).href);
    define('responseText', type === '' || type === 'text' ? text : '');
    define('response', type === 'json' ? parsed : text);

    xhr.getAllResponseHeaders = () => 'content-type: application/json; charset=utf-8\r\n';
    xhr.getResponseHeader = (name) => (
      String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null
    );

    // dispatchEvent já aciona listeners E handlers on*, chamar os dois duplicaria
    const progress = { lengthComputable: true, loaded: text.length, total: text.length };
    try { xhr.dispatchEvent(new Event('readystatechange')); } catch (e) { warn(e); }
    try { xhr.dispatchEvent(new ProgressEvent('load', progress)); } catch (e) { warn(e); }
    try { xhr.dispatchEvent(new ProgressEvent('loadend', progress)); } catch (e) { warn(e); }
  }

  XHR.prototype.open = function (method, url, ...rest) {
    try {
      const match = typeof url === 'string' ? COLLECTION_RE.exec(url) : null;
      this[TAG] = match ? { url, collectionId: match[1] } : null;
    } catch { this[TAG] = null; }
    return origOpen.call(this, method, url, ...rest);
  };

  XHR.prototype.send = function (body) {
    const info = this[TAG];
    if (!info) return origSend.call(this, body);

    log(`XHR interceptado: coleção ${info.collectionId}`);

    buildPayload(info.collectionId)
      .then((payload) => fakeXhrResponse(this, info.url, JSON.stringify(payload)))
      .catch((err) => {
        warn('XHR: falha ao reconstruir; deixando a request original seguir:', err);
        badge('ERRO, ver console', '#c00');
        try { origSend.call(this, body); } catch (e) { warn(e); }
      });
  };

  // ----------------------------------------------------------- prefetch ----
  // Começa (ou retoma) a indexação assim que qualquer página /saved/ abre.
  const maybePrefetch = () => {
    if (!location.pathname.includes('/saved/')) return;
    ensureIndex().catch((e) => warn('prefetch falhou:', e));
  };

  if (document.readyState === 'complete') setTimeout(maybePrefetch, CFG.PREFETCH_DELAY_MS);
  else window.addEventListener('load', () => setTimeout(maybePrefetch, CFG.PREFETCH_DELAY_MS), { once: true });

  log(`v${VERSION} ativo (fetch + XHR, índice retomável em IndexedDB)`);
  badge(`v${VERSION} ativo`, '#06c');
})();
