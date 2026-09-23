/* ============================================================
   YOU® — theme.js
   Vanilla JS: cart drawer (AJAX), quick add, variants, overlays,
   scroll reveal, editorial parallax, background music.
   No libraries.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.YOU || {};
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  function formatMoney(cents) {
    var amount = (cents / 100).toFixed(2);
    var fmt = CFG.moneyFormat || '${{amount}}';
    return fmt.replace(/\{\{\s*amount\s*\}\}/, amount).replace(/\{\{\s*amount_no_decimals\s*\}\}/, Math.round(cents / 100));
  }

  function toast(msg, type) {
    var el = $('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.classList.toggle('toast--error', type === 'error');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    el.textContent = msg;
    el.classList.add('is-visible');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('is-visible'); }, 2400);
  }

  /* ----------------------------------------------------------
     Overlay management (drawers + search)
     ---------------------------------------------------------- */
  var veil = $('.overlay-veil');
  var openOverlays = [];

  function lockScroll() { document.body.classList.add('scroll-locked'); }
  function unlockScrollIfFree() { if (openOverlays.length === 0) document.body.classList.remove('scroll-locked'); }

  function openOverlay(el) {
    if (!el || el.classList.contains('is-open')) return;
    el.classList.add('is-open');
    openOverlays.push(el);
    if (veil) veil.classList.add('is-visible');
    lockScroll();
  }

  function closeOverlay(el) {
    if (!el || !el.classList.contains('is-open')) return;
    el.classList.remove('is-open');
    openOverlays = openOverlays.filter(function (o) { return o !== el; });
    if (openOverlays.length === 0 && veil) veil.classList.remove('is-visible');
    unlockScrollIfFree();
  }

  function closeAllOverlays() { openOverlays.slice().forEach(closeOverlay); }

  if (veil) veil.addEventListener('click', closeAllOverlays);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAllOverlays();
  });

  $$('[data-drawer-close]').forEach(function (btn) {
    btn.addEventListener('click', function () { closeOverlay(btn.closest('.drawer, .search')); });
  });

  /* ----------------------------------------------------------
     Sticky header
     ---------------------------------------------------------- */
  var header = $('.header');
  if (header) {
    var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 12); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ----------------------------------------------------------
     Scroll reveal (fade-up)
     ---------------------------------------------------------- */
  if ('IntersectionObserver' in window) {
    var revealIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('is-in'); revealIO.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    $$('.reveal').forEach(function (el) { revealIO.observe(el); });
  } else {
    $$('.reveal').forEach(function (el) { el.classList.add('is-in'); });
  }

  /* ----------------------------------------------------------
     Editorial motion — parallax + section reveal
     mirrors the reference hook: --p progress, --po edge fade
     ---------------------------------------------------------- */
  var edSections = $$('.ed');
  if (edSections.length) {
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if ('IntersectionObserver' in window) {
      var edIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { en.target.classList.toggle('ed-in', en.isIntersecting); });
      }, { rootMargin: '14% 0px 14% 0px', threshold: 0.04 });
      edSections.forEach(function (s) { edIO.observe(s); });
    } else {
      edSections.forEach(function (s) { s.classList.add('ed-in'); });
    }
    if (!reduced) {
      var ticking = false;
      var updateEd = function () {
        ticking = false;
        var vh = window.innerHeight || 1;
        edSections.forEach(function (el) {
          var rect = el.getBoundingClientRect();
          if (rect.bottom < -80 || rect.top > vh + 80) return;
          var center = rect.top + rect.height / 2;
          var denom = vh / 2 + rect.height / 2;
          var p = Math.max(-1, Math.min(1, (vh / 2 - center) / denom));
          el.style.setProperty('--p', p.toFixed(4));
          el.style.setProperty('--po', (1 - Math.max(0, Math.abs(p) - 0.55) * 1.1).toFixed(3));
        });
      };
      var onEdScroll = function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(updateEd);
      };
      updateEd();
      window.addEventListener('scroll', onEdScroll, { passive: true });
      window.addEventListener('resize', onEdScroll, { passive: true });
    }
  }

  /* ----------------------------------------------------------
     Mobile menu
     ---------------------------------------------------------- */
  var mobileMenu = $('#mobile-menu');
  $$('[data-open-menu]').forEach(function (btn) {
    btn.addEventListener('click', function () { openOverlay(mobileMenu); });
  });

  /* ----------------------------------------------------------
     Cart core (AJAX)
     ---------------------------------------------------------- */
  var cartDrawer = $('#cart-drawer');

  function storefrontUrl(path) {
    var root = CFG.routesRoot || '/';
    return root.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
  }

  function cartErrorMessage(error) {
    var text = String((error.data && (error.data.description || error.data.message)) || error.message || '').toLowerCase();
    if (/sold out|not available/.test(text)) return 'This variant is sold out.';
    if (/inventory|stock|quantity|maximum/.test(text)) return 'The requested quantity is not available.';
    if (/variant|product/.test(text)) return 'This product option is no longer available.';
    return 'Unable to add this item. Please try again.';
  }

  function CartError(message, status, data) {
    this.name = 'CartError';
    this.message = message;
    this.status = status;
    this.data = data;
  }
  CartError.prototype = Object.create(Error.prototype);
  CartError.prototype.constructor = CartError;

  function normalizeVariantId(id) {
    // Theme product JSON supplies numeric Ajax API IDs. Support a Storefront API
    // ProductVariant GID only when one is explicitly passed by another caller.
    if (typeof id === 'string' && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)) {
      id = id.split('/').pop();
    }
    var normalized = String(id == null ? '' : id).trim();
    if (!/^\d+$/.test(normalized) || normalized === '0') return null;
    return normalized;
  }

  function readJson(response) {
    return response.text().then(function (text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch (_) { return { description: text }; }
    });
  }

  function getCart() {
    return fetch(storefrontUrl('cart.js'), { headers: { 'Accept': 'application/json' } }).then(function (r) {
      return readJson(r).then(function (data) {
        if (!r.ok) throw new CartError('Unable to load cart.', r.status, data);
        return data;
      });
    });
  }

  function cartAdd(id, qty) {
    var variantId = normalizeVariantId(id);
    var quantity = Number(qty);
    if (!variantId) return Promise.reject(new CartError('Invalid variant ID.', 0, { id: id }));
    if (!Number.isInteger(quantity) || quantity < 1) return Promise.reject(new CartError('Invalid quantity.', 0, { quantity: qty }));
    var payload = { items: [{ id: variantId, quantity: quantity }] };
    return fetch(storefrontUrl('cart/add.js'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return readJson(r).then(function (data) {
        if (!r.ok) {
          // Keep Shopify's response available in DevTools; do not replace it with
          // an opaque HTTP status, which hides the actual cause of a 422.
          console.error('Shopify cart error', { status: r.status, payload: payload, data: data });
          throw new CartError(cartErrorMessage({ data: data }), r.status, data);
        }
        return data;
      });
    });
  }

  function cartChange(lineKey, qty) {
    return fetch(storefrontUrl('cart/change.js'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ id: String(lineKey), quantity: qty })
    }).then(function (r) { return r.json(); });
  }

  function updateCartCount(count) {
    $$('[data-cart-count]').forEach(function (el) {
      el.textContent = count;
      el.style.display = count > 0 ? 'flex' : 'none';
    });
  }

  function renderShipBar(cart) {
    var box = $('[data-ship-bar]');
    if (!box) return;
    var threshold = CFG.freeShippingThreshold || 0;
    var textEl = $('[data-ship-text]', box);
    var fillEl = $('[data-ship-fill]', box);
    if (!threshold) { box.style.display = 'none'; return; }
    box.style.display = '';
    var remaining = threshold - (cart.total_price / 100);
    if (remaining <= 0) {
      textEl.innerHTML = '<strong>' + 'Free shipping unlocked' + '</strong>';
      if (fillEl) fillEl.style.width = '100%';
    } else {
      textEl.innerHTML = 'Spend <strong>' + formatMoney(remaining * 100) + '</strong> away from free shipping';
      if (fillEl) fillEl.style.width = Math.min(100, (cart.total_price / 100 / threshold) * 100) + '%';
    }
  }

  function renderCartDrawer(cart) {
    var itemsBox = $('[data-cart-items]');
    var footBox = $('[data-cart-foot]');
    if (!itemsBox) return;
    updateCartCount(cart.item_count);
    renderShipBar(cart);

    if (!cart.items || cart.items.length === 0) {
      itemsBox.innerHTML =
        '<div class="drawer__empty"><p>' + 'Your cart is empty' + '</p>' +
        '<button class="btn btn--ink" data-drawer-close-now>Continue shopping</button></div>';
      if (footBox) footBox.style.display = 'none';
      var again = $('[data-drawer-close-now]', itemsBox);
      if (again) again.addEventListener('click', function () { closeOverlay(cartDrawer); });
      return;
    }
    if (footBox) footBox.style.display = '';

    itemsBox.innerHTML = cart.items.map(function (item) {
      var img = item.image
        ? '<img class="cart-line__img" src="' + item.image.replace(/(\.[a-zA-Z]+)(\?|$)/, '_360x480$1$2') + '" alt="" loading="lazy">'
        : '<div class="cart-line__img"></div>';
      var variant = item.variant_title ? '<p class="cart-line__variant">' + item.variant_title + '</p>' : '';
      return (
        '<div class="cart-line" data-line="' + item.key + '">' +
          img +
          '<div>' +
            '<p class="cart-line__title"><a href="' + item.url + '">' + item.product_title + '</a></p>' +
            variant +
            '<div class="cart-line__row">' +
              '<span class="cart-line__qty">' +
                '<button data-qty-minus aria-label="Decrease">−</button>' +
                '<span>' + item.quantity + '</span>' +
                '<button data-qty-plus aria-label="Increase">+</button>' +
              '</span>' +
              '<span class="cart-line__price money">' + formatMoney(item.final_line_price) + '</span>' +
            '</div>' +
            '<div class="cart-line__row"><button class="cart-line__remove" data-line-remove>Remove</button></div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    var subtotal = $('[data-cart-subtotal]');
    if (subtotal) subtotal.textContent = formatMoney(cart.total_price);

    $$('[data-qty-plus]', itemsBox).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var line = btn.closest('.cart-line');
        var span = $('.cart-line__qty span', line);
        cartChange(line.getAttribute('data-line'), parseInt(span.textContent, 10) + 1)
          .then(function (c) { renderCartDrawer(c); })
          .catch(function () { toast('Could not update', 'error'); });
      });
    });
    $$('[data-qty-minus]', itemsBox).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var line = btn.closest('.cart-line');
        var span = $('.cart-line__qty span', line);
        var next = parseInt(span.textContent, 10) - 1;
        cartChange(line.getAttribute('data-line'), next)
          .then(function (c) { renderCartDrawer(c); })
          .catch(function () { toast('Could not update', 'error'); });
      });
    });
    $$('[data-line-remove]', itemsBox).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var line = btn.closest('.cart-line');
        cartChange(line.getAttribute('data-line'), 0)
          .then(function (c) { renderCartDrawer(c); })
          .catch(function () { toast('Could not update', 'error'); });
      });
    });
  }

  function openCart() {
    if (!cartDrawer) { window.location.href = '/cart'; return; }
    getCart().then(renderCartDrawer).catch(function () {});
    openOverlay(cartDrawer);
  }

  $$('[data-open-cart]').forEach(function (btn) {
    btn.addEventListener('click', function (e) { e.preventDefault(); openCart(); });
  });

  // expose for other modules
  window.YOUCart = { open: openCart, render: function () { getCart().then(renderCartDrawer).catch(function () {}); }, add: cartAdd, toast: toast };

  /* ----------------------------------------------------------
     Quick add (product cards)
     ---------------------------------------------------------- */
  var productCache = {};

  function fetchProduct(handle) {
    if (productCache[handle]) return Promise.resolve(productCache[handle]);
    return fetch(storefrontUrl('products/' + encodeURIComponent(handle) + '.js'), { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (p) { productCache[handle] = p; return p; });
  }

  $$('.card__quick').forEach(function (quick) {
    var handle = quick.getAttribute('data-handle');
    var sizesBox = $('.card__sizes', quick);
    if (!handle || !sizesBox) return;
    var loaded = false;
    var load = function () {
      if (loaded) return;
      loaded = true;
      fetchProduct(handle).then(function (product) {
        var sizeOption = product.options.filter(function (o) { return /size/i.test(o.name); })[0];
        var sizes = sizeOption ? sizeOption.values : [];
        if (!sizes.length) {
          var first = product.variants.filter(function (v) { return v.available; })[0];
          sizesBox.innerHTML = first
            ? '<button class="card__no-sizes" data-variant="' + first.id + '">Add to cart — ' + formatMoney(first.price) + '</button>'
            : '<span class="card__no-sizes is-disabled">Sold out</span>';
        } else {
          sizesBox.innerHTML = sizes.map(function (s) { return '<button class="card__size" data-size="' + s + '">' + s + '</button>'; }).join('');
        }
        $$('[data-variant]', sizesBox).forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (btn.disabled) return;
            btn.classList.add('is-disabled');
            btn.disabled = true;
            cartAdd(btn.getAttribute('data-variant'), 1)
              .then(function () { btn.classList.remove('is-disabled'); btn.disabled = false; openCart(); })
              .catch(function (e) { btn.classList.remove('is-disabled'); btn.disabled = false; toast(e.message, 'error'); });
          });
        });
        $$('[data-size]', sizesBox).forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (btn.disabled) return;
            var size = btn.getAttribute('data-size');
            var sizeIdx = product.options.indexOf(sizeOption);
            var variant = product.variants.filter(function (v) {
              return v.available && v.options[sizeIdx] === size;
            })[0];
            if (!variant) { toast('Size unavailable', 'error'); return; }
            btn.classList.add('is-disabled');
            btn.disabled = true;
            cartAdd(variant.id, 1)
              .then(function () { btn.classList.remove('is-disabled'); btn.disabled = false; openCart(); })
              .catch(function (e) { btn.classList.remove('is-disabled'); btn.disabled = false; toast(e.message, 'error'); });
          });
        });
      }).catch(function () {
        loaded = false;
        sizesBox.innerHTML = '<a class="card__no-sizes" href="/products/' + handle + '">Choose options</a>';
      });
    };
    var media = quick.closest('.card__media');
    if (media) {
      media.addEventListener('mouseenter', load);
      media.addEventListener('touchstart', load, { passive: true });
      media.addEventListener('focusin', load);
    }
    load();
  });

  /* ----------------------------------------------------------
     PDP — variant picker + gallery + accordions
     ---------------------------------------------------------- */
  var pdp = $('[data-product-form]');
  if (pdp) {
    var variants = JSON.parse($('[data-variant-json]', pdp).textContent);
    var optionNames = JSON.parse($('[data-option-names]', pdp).textContent);
    var idInput = $('[data-variant-id]', pdp);
    var priceEl = $('[data-price]', pdp);
    var compareEl = $('[data-compare]', pdp);
    var atcBtn = $('[data-atc]', pdp);
    var skuEl = $('[data-sku]', pdp);

    var selected = optionNames.map(function (name) {
      var active = $('.pill.is-active[data-option="' + name + '"]', pdp);
      return active ? active.getAttribute('data-value') : null;
    });

    function findVariant() {
      return variants.filter(function (v) {
        return optionNames.every(function (name, i) {
          return !selected[i] || v.options[i] === selected[i];
        });
      });
    }

    function refresh() {
      var matches = findVariant();
      var exact = matches.filter(function (v) { return optionNames.every(function (name, i) { return !selected[i] || v.options[i] === selected[i]; }); })[0];
      // availability pills for the next unselected option
      optionNames.forEach(function (name, i) {
        if (selected[i]) return;
        var availableValues = {};
        matches.forEach(function (v) {
          if (v.available) availableValues[v.options[i]] = true;
        });
        $$('.pill[data-option="' + name + '"]', pdp).forEach(function (pill) {
          pill.classList.toggle('is-unavailable', !availableValues[pill.getAttribute('data-value')]);
        });
      });
      if (!exact) return;
      idInput.value = exact.id;
      if (priceEl) priceEl.innerHTML = formatMoney(exact.price);
      if (compareEl) {
        compareEl.textContent = exact.compare_at_price > exact.price ? formatMoney(exact.compare_at_price) : '';
      }
      if (skuEl) skuEl.textContent = exact.sku || '';
      if (atcBtn) {
        atcBtn.disabled = !exact.available;
        atcBtn.textContent = exact.available ? atcBtn.getAttribute('data-label') : 'Sold out';
      }
      if (history.replaceState) {
        var url = new URL(window.location);
        url.searchParams.set('variant', exact.id);
        history.replaceState({}, '', url.toString());
      }
    }

    $$('.pill[data-option]', pdp).forEach(function (pill) {
      pill.addEventListener('click', function (e) {
        e.preventDefault();
        var name = pill.getAttribute('data-option');
        var idx = optionNames.indexOf(name);
        selected[idx] = pill.getAttribute('data-value');
        $$('.pill[data-option="' + name + '"]', pdp).forEach(function (p) { p.classList.remove('is-active'); });
        pill.classList.add('is-active');
        $$('.pill[data-option="' + name + '"]', pdp).forEach(function (p) {
          p.setAttribute('aria-pressed', p === pill ? 'true' : 'false');
        });
        var valueEl = $('[data-option-value="' + name + '"]', pdp);
        if (valueEl) valueEl.textContent = pill.getAttribute('data-value');
        refresh();
      });
    });

    // gallery thumbs
    var mainImg = $('[data-gallery-main]');
    $$('.pdp-thumb').forEach(function (thumb) {
      thumb.addEventListener('click', function () {
        $$('.pdp-thumb').forEach(function (t) { t.classList.remove('is-active'); });
        thumb.classList.add('is-active');
        if (mainImg) {
          mainImg.style.opacity = 0;
          setTimeout(function () {
            mainImg.src = thumb.getAttribute('data-full');
            mainImg.style.opacity = 1;
          }, 160);
        }
      });
    });

    // ATC
    if (atcBtn) {
      atcBtn.addEventListener('click', function () {
        if (atcBtn.disabled || atcBtn.classList.contains('is-disabled')) return;
        atcBtn.classList.add('is-disabled');
        atcBtn.disabled = true;
        cartAdd(idInput.value, parseInt(($('[data-qty-input]', pdp) || {}).value || 1, 10))
          .then(function () {
            atcBtn.classList.remove('is-disabled');
            atcBtn.disabled = false;
            openCart();
          })
          .catch(function (e) {
            atcBtn.classList.remove('is-disabled');
            if (cartErrorMessage(e) === 'This variant is sold out.') {
              atcBtn.disabled = true;
              atcBtn.textContent = 'Sold out';
            } else {
              atcBtn.disabled = false;
            }
            toast(e.message || 'Unable to add', 'error');
          });
      });
    }

    // buy now → standard checkout via form post
    var buyBtn = $('[data-buy]');
    if (buyBtn) {
      buyBtn.addEventListener('click', function () {
        var form = document.createElement('form');
        form.method = 'post';
        form.action = storefrontUrl('cart/add');
        var inputId = document.createElement('input');
        inputId.type = 'hidden'; inputId.name = 'id'; inputId.value = idInput.value;
        var inputQ = document.createElement('input');
        inputQ.type = 'hidden'; inputQ.name = 'quantity'; inputQ.value = '1';
        var channel = document.createElement('input');
        channel.type = 'hidden'; channel.name = 'checkout'; channel.value = '1';
        form.appendChild(inputId); form.appendChild(inputQ); form.appendChild(channel);
        document.body.appendChild(form);
        form.submit();
      });
    }

    refresh();
  }

  // accordions (site-wide)
  $$('.acc__head').forEach(function (head) {
    head.addEventListener('click', function () {
      head.closest('.acc').classList.toggle('is-open');
    });
  });

  // qty steppers (PDP)
  $$('[data-qty-box]').forEach(function (box) {
    var input = $('[data-qty-input]', box);
    if (!input) return;
    $('[data-qty-dec]', box).addEventListener('click', function () {
      input.value = Math.max(1, parseInt(input.value || 1, 10) - 1);
    });
    $('[data-qty-inc]', box).addEventListener('click', function () {
      input.value = Math.min(9, parseInt(input.value || 1, 10) + 1);
    });
  });

  /* ----------------------------------------------------------
     Search overlay + predictive results
     ---------------------------------------------------------- */
  var search = $('#search');
  var searchInput = $('[data-search-input]');
  var resultsBox = $('[data-search-results]');

  $$('[data-open-search]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      openOverlay(search);
      setTimeout(function () { if (searchInput) searchInput.focus(); }, 350);
    });
  });

  function searchTemplate(item) {
    var img = item.featured_image && item.featured_image.url
      ? '<img class="search-hit__img" src="' + item.featured_image.url + '" alt="" loading="lazy">'
      : '<div class="search-hit__img"></div>';
    return (
      '<a class="card" href="' + item.url + '">' +
        '<div class="card__media">' + img + '</div>' +
        '<div class="card__info"><div>' +
          '<p class="search-hit__title">' + item.title + '</p>' +
          '<p class="search-hit__price money">' + formatMoney(item.price) + '</p>' +
        '</div></div>' +
      '</a>'
    );
  }

  var searchTimer = 0;
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      var q = searchInput.value.trim();
      clearTimeout(searchTimer);
      if (q.length < 2) { if (resultsBox) resultsBox.innerHTML = ''; return; }
      searchTimer = setTimeout(function () {
        fetch('/search/suggest.json?q=' + encodeURIComponent(q) + '&resources[type]=product&resources[limit]=8', {
          headers: { 'Accept': 'application/json' }
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var products = (data.resources && data.resources.results && data.resources.results.products) || [];
            if (!resultsBox) return;
            if (!products.length) {
              resultsBox.innerHTML = '<p class="search__empty">No results for “' + q + '”.</p>';
              return;
            }
            resultsBox.innerHTML =
              '<p class="search__label">Products</p>' +
              '<div class="search__grid">' + products.map(searchTemplate).join('') + '</div>';
          })
          .catch(function () {});
      }, 260);
    });
    searchInput.closest('form') && searchInput.closest('form').addEventListener('submit', function (e) {
      e.preventDefault();
      window.location.href = '/search?q=' + encodeURIComponent(searchInput.value.trim());
    });
  }

  /* ----------------------------------------------------------
     Background music — unlock on first interaction
     ---------------------------------------------------------- */
  if (CFG.music && CFG.music.enabled) {
    var audio = new Audio(CFG.music.track);
    audio.loop = true;
    audio.preload = 'metadata';
    var target = CFG.music.volume || 0.55;
    var unlocked = false;
    var rafId = 0;
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    try {
      var pref = localStorage.getItem('you-sound');
      if (pref === 'off') { audio.muted = true; }
    } catch (e) {}

    var eqButtons = $$('[data-sound-toggle]');

    function paintToggle() {
      var on = !audio.muted;
      eqButtons.forEach(function (btn) {
        btn.classList.toggle('is-off', !on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-label', on ? 'Mute background music' : 'Play background music');
      });
    }

    function fadeIn() {
      if (reduceMotion) { audio.volume = target; return; }
      cancelAnimationFrame(rafId);
      var t0 = performance.now();
      var tick = function (t) {
        var k = Math.min(1, (t - t0) / 1800);
        audio.volume = target * (1 - Math.pow(1 - k, 3));
        if (k < 1) rafId = requestAnimationFrame(tick);
      };
      audio.volume = 0;
      rafId = requestAnimationFrame(tick);
    }

    function tryStart() {
      if (unlocked || audio.muted) return;
      audio.play().then(function () {
        unlocked = true;
        fadeIn();
      }).catch(function () {});
    }

    var events = ['pointerdown', 'touchstart', 'keydown'];
    var onGesture = function () {
      tryStart();
      if (unlocked) events.forEach(function (ev) { window.removeEventListener(ev, onGesture); });
    };
    events.forEach(function (ev) { window.addEventListener(ev, onGesture, { passive: true }); });

    eqButtons.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        audio.muted = !audio.muted;
        try { localStorage.setItem('you-sound', audio.muted ? 'off' : 'on'); } catch (err) {}
        if (!audio.muted) tryStart();
        paintToggle();
      });
    });
    paintToggle();
  }
})();
