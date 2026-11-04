(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;
  var LS_LANG = "keyper.site.lang";
  var LS_THEME = "keyper.site.theme";
  var EN = window.KEYPER_EN || {};
  var ZH = {};
  var ZH_TITLE = doc.title;
  var ZH_DESC = (doc.querySelector('meta[name="description"]') || {}).content || "";

  /* ---------- dictionary snapshot (index.html is authored in zh-CN) ---------- */
  function nodes() {
    return doc.querySelectorAll("[data-i18n],[data-i18n-html],[data-i18n-aria]");
  }
  function keyOf(el) {
    return el.getAttribute("data-i18n") || el.getAttribute("data-i18n-html") || el.getAttribute("data-i18n-aria");
  }
  nodes().forEach(function (el) {
    var k = keyOf(el);
    if (el.hasAttribute("data-i18n-aria")) ZH[k] = el.getAttribute("aria-label") || "";
    else ZH[k] = el.innerHTML;
  });

  var missing = [];
  function apply(lang) {
    var dict = lang === "en" ? EN : ZH;
    nodes().forEach(function (el) {
      var k = keyOf(el);
      var v = dict[k];
      if (v === undefined) {
        if (lang === "en") missing.push(k);
        v = ZH[k];
      }
      if (v === undefined) return;
      if (el.hasAttribute("data-i18n-aria")) el.setAttribute("aria-label", v);
      else el.innerHTML = v;
    });

    doc.title = lang === "en" ? (EN["page.title"] || ZH_TITLE) : ZH_TITLE;
    root.lang = lang === "en" ? "en" : "zh-CN";

    var desc = doc.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute("content", lang === "en" ? (EN["page.desc"] || ZH_DESC) : ZH_DESC);

    doc.querySelectorAll("[data-full]").forEach(function (fig) {
      var cap = fig.querySelector("figcaption");
      var img = fig.querySelector("img");
      if (cap && img) img.alt = cap.textContent.trim();
    });

    doc.querySelectorAll(".copy-btn").forEach(function (b) {
      b.textContent = lang === "en" ? "Copy" : "复制";
    });

    doc.querySelectorAll("[data-lang]").forEach(function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-lang") === lang);
    });

    if (lang === "en" && missing.length) {
      console.warn("[i18n] missing English keys:", missing.slice(0, 40).join(", "));
      missing = [];
    }
  }

  var lang = null;
  try { lang = localStorage.getItem(LS_LANG); } catch (e) {}
  if (lang !== "en" && lang !== "zh") {
    lang = (navigator.language || "zh-CN").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  }
  apply(lang);

  doc.querySelectorAll("[data-lang]").forEach(function (b) {
    b.addEventListener("click", function () {
      lang = b.getAttribute("data-lang");
      try { localStorage.setItem(LS_LANG, lang); } catch (e) {}
      apply(lang);
    });
  });

  /* ---------- theme ---------- */
  var theme = null;
  try { theme = localStorage.getItem(LS_THEME); } catch (e) {}
  if (theme !== "light" && theme !== "dark") theme = "dark";
  root.setAttribute("data-theme", theme);

  doc.getElementById("theme-btn").addEventListener("click", function () {
    theme = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem(LS_THEME, theme); } catch (e) {}
  });

  /* ---------- nav ---------- */
  var nav = doc.getElementById("nav");
  var burger = doc.getElementById("burger");
  burger.addEventListener("click", function () {
    var open = nav.classList.toggle("is-open");
    burger.setAttribute("aria-expanded", open ? "true" : "false");
  });
  nav.querySelectorAll(".nav-links a").forEach(function (a) {
    a.addEventListener("click", function () {
      nav.classList.remove("is-open");
      burger.setAttribute("aria-expanded", "false");
    });
  });

  var sections = [];
  nav.querySelectorAll(".nav-links a").forEach(function (a) {
    var id = (a.getAttribute("href") || "").slice(1);
    var el = id && doc.getElementById(id);
    if (el) sections.push({ link: a, el: el });
  });

  function onScroll() {
    nav.classList.toggle("is-stuck", window.scrollY > 8);
    var probe = window.scrollY + 140;
    var current = null;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].el.offsetTop <= probe) current = sections[i];
    }
    sections.forEach(function (s) { s.link.classList.toggle("is-active", s === current); });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- pixel heading ---------- */
  var pixel = doc.querySelector("[data-pixel]");
  if (pixel) {
    var word = pixel.getAttribute("data-pixel");
    pixel.textContent = "";
    word.split("").forEach(function (ch, i) {
      var s = doc.createElement("span");
      s.className = "ch" + (i === 0 || ch === "p" ? " accent" : "");
      s.textContent = ch;
      s.style.animationDelay = (90 + i * 55) + "ms";
      pixel.appendChild(s);
    });
  }

  /* ---------- mock CLI typer ---------- */
  var typer = doc.getElementById("typer");
  if (typer) {
    var cmds = [
      "HGETALL user:1002:profile",
      "SCAN 0 MATCH user:* COUNT 500",
      "MEMORY USAGE user:1001",
      "SLOWLOG GET 10",
      "XLEN stream:audit"
    ];
    var ci = 0, cj = 0, del = false;
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      typer.textContent = cmds[0];
    } else {
      (function tick() {
        var c = cmds[ci];
        if (!del) {
          cj++;
          typer.textContent = c.slice(0, cj);
          if (cj >= c.length) { del = true; return setTimeout(tick, 1900); }
          return setTimeout(tick, 46 + Math.random() * 40);
        }
        cj--;
        typer.textContent = c.slice(0, cj);
        if (cj <= 0) { del = false; ci = (ci + 1) % cmds.length; return setTimeout(tick, 320); }
        setTimeout(tick, 18);
      })();
    }
  }

  /* ---------- copy ---------- */
  function copyText(text, btn) {
    var done = function (ok) {
      if (!btn) return;
      btn.classList.toggle("done", !!ok);
      btn.textContent = ok ? (lang === "en" ? "Copied" : "已复制") : (lang === "en" ? "Failed" : "复制失败");
      setTimeout(function () {
        btn.classList.remove("done");
        btn.textContent = lang === "en" ? "Copy" : "复制";
      }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallback(text)); });
    } else {
      done(fallback(text));
    }
  }
  function fallback(text) {
    var ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    doc.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = doc.execCommand("copy"); } catch (e) { ok = false; }
    doc.body.removeChild(ta);
    return ok;
  }

  doc.querySelectorAll("[data-copy]").forEach(function (block) {
    var text;
    if (block.hasAttribute("data-copy")) {
      var a = block.getAttribute("data-copy");
      text = a && a.length ? a : Array.prototype.map.call(block.querySelectorAll("code"), function (c) {
        return c.textContent.replace(/[ \t]+$/gm, "");
      }).join("\n").trim();
    }
    var btn;
    if (block.classList.contains("code-line")) {
      block.addEventListener("click", function () { copyText(text, null); });
    } else {
      btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn";
      btn.textContent = lang === "en" ? "Copy" : "复制";
      block.appendChild(btn);
      btn.addEventListener("click", function () { copyText(text, btn); });
    }
  });

  /* ---------- tab groups ---------- */
  function wireTabs(btnSel, panelSel, btnAttr, panelAttr) {
    doc.querySelectorAll(btnSel).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var name = btn.getAttribute(btnAttr);
        var scope = btn.parentNode.parentNode;
        scope.querySelectorAll(btnSel.split(" ").pop()).forEach(function (b) {
          var on = b === btn;
          b.classList.toggle("is-on", on);
          if (b.hasAttribute("aria-selected")) b.setAttribute("aria-selected", on ? "true" : "false");
        });
        scope.querySelectorAll(panelSel).forEach(function (p) {
          p.classList.toggle("is-on", p.getAttribute(panelAttr) === name);
        });
        buildLightboxList();
      });
    });
  }
  wireTabs(".tabs .tab", ".panel[data-panel]", "data-tab", "data-panel");
  wireTabs(".gal-tabs .gt", ".gal-panel[data-g]", "data-g", "data-g");

  /* ---------- lightbox ---------- */
  var lb = doc.getElementById("lb");
  var lbImg = doc.getElementById("lb-img");
  var lbCap = doc.getElementById("lb-cap");
  var list = [];
  var idx = 0;

  function visible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }
  function buildLightboxList() {
    list = [];
    doc.querySelectorAll("[data-full]").forEach(function (f) {
      if (!visible(f)) return;
      var cap = f.querySelector("figcaption");
      list.push({ src: f.getAttribute("data-full"), cap: cap ? cap.textContent.trim() : "" });
    });
  }
  function openLb(i) {
    if (!list.length) return;
    idx = (i + list.length) % list.length;
    lbImg.src = list[idx].src;
    lbImg.alt = list[idx].cap;
    lbCap.textContent = list[idx].cap;
    lb.classList.add("is-on");
    lb.setAttribute("aria-hidden", "false");
    doc.body.style.overflow = "hidden";
    doc.getElementById("lb-x").focus();
  }
  function closeLb() {
    lb.classList.remove("is-on");
    lb.setAttribute("aria-hidden", "true");
    lbImg.src = "";
    doc.body.style.overflow = "";
  }
  doc.querySelectorAll("[data-full]").forEach(function (f) {
    function go() {
      buildLightboxList();
      var src = f.getAttribute("data-full");
      var at = 0;
      for (var i = 0; i < list.length; i++) if (list[i].src === src) { at = i; break; }
      openLb(at);
    }
    f.addEventListener("click", go);
    f.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });
  doc.getElementById("lb-x").addEventListener("click", closeLb);
  doc.getElementById("lb-prev").addEventListener("click", function () { openLb(idx - 1); });
  doc.getElementById("lb-next").addEventListener("click", function () { openLb(idx + 1); });
  lb.addEventListener("click", function (e) { if (e.target === lb) closeLb(); });
  doc.addEventListener("keydown", function (e) {
    if (!lb.classList.contains("is-on")) return;
    if (e.key === "Escape") closeLb();
    else if (e.key === "ArrowLeft") openLb(idx - 1);
    else if (e.key === "ArrowRight") openLb(idx + 1);
  });

  /* ---------- scroll reveal ---------- */
  var targets = doc.querySelectorAll(".card, .feat, .skin, .shot, .cstep, .pipe-step, .stat, .arch-layer, .tl-item, .lim-list li, .faq details");
  targets.forEach(function (el, i) {
    el.classList.add("rv");
    el.style.transitionDelay = (i % 6) * 45 + "ms";
  });
  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });
    doc.querySelectorAll(".rv").forEach(function (el) { io.observe(el); });
  } else {
    targets.forEach(function (el) { el.classList.add("in"); });
  }
})();
