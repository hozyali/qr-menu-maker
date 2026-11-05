// Landing page behaviour. The page reads correctly without this script.
(function () {
  "use strict";
  var doc = document;
  var byId = function (id) { return doc.getElementById(id); };

  // Show a whole number the way Pakistani menus print it: 1,300.
  function money(value) {
    var digits = String(value).replace(/\D/g, "").slice(0, 5);
    return digits ? Number(digits).toLocaleString("en-US") : "0";
  }

  // Live editor: changing the sample menu updates the phone, and the QR code stays the same.
  // These forms only drive the on-page previews, so nothing is ever submitted.
  doc.querySelectorAll("form").forEach(function (form) {
    form.addEventListener("submit", function (event) { event.preventDefault(); });
  });
  var edits = 0;
  function renderMenu() {
    byId("r-name").textContent = byId("e-name").value.trim() || "Dish name";
    byId("r-half").textContent = money(byId("e-half").value);
    byId("r-full").textContent = money(byId("e-full").value);
    var available = byId("e-avail").checked;
    byId("r-state").textContent = available ? "Available today" : "Not available today";
    byId("r-item").classList.toggle("is-off", !available);
  }
  var editor = byId("editor");
  if (editor) {
    editor.addEventListener("input", function () {
      renderMenu();
      edits += 1;
      byId("r-count").textContent = edits + (edits === 1 ? " edit" : " edits") + ". Your printed cards still work.";
    });
  }

  // Link preview: this mirrors how a restaurant's permanent link is made.
  function slugify(text) {
    return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  var claim = byId("claim");
  if (claim) {
    var renderSlug = function () {
      var slug = [byId("c-name").value, byId("c-city").value].map(slugify).filter(Boolean).join("-");
      byId("c-slug").textContent = slug || "your-restaurant";
      return slug;
    };
    claim.addEventListener("input", renderSlug);
    // Set data-whatsapp on the form to a full number, digits only, to turn the button on.
    var number = (claim.getAttribute("data-whatsapp") || "").replace(/\D/g, "");
    var go = byId("c-go");
    if (number) {
      var refresh = function () {
        var text = "I want a TomatoFry menu for " + byId("c-name").value + ", " + byId("c-city").value + ".";
        go.href = "https://wa.me/" + number + "?text=" + encodeURIComponent(text);
      };
      go.textContent = "Message us on WhatsApp";
      go.classList.add("is-live");
      go.removeAttribute("aria-disabled");
      go.rel = "noopener";
      refresh();
      claim.addEventListener("input", refresh);
    }
  }

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!("IntersectionObserver" in window)) { return; }

  // Slow crossfade: the fixed example changes to match the section being read.
  var panes = doc.querySelectorAll(".stage .pane");
  var paneObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) { return; }
      var index = Number(entry.target.getAttribute("data-pane"));
      panes.forEach(function (pane, i) { pane.classList.toggle("is-on", i === index); });
    });
  }, { rootMargin: "-45% 0px -45% 0px" });
  doc.querySelectorAll("[data-pane]").forEach(function (el) { paneObserver.observe(el); });

  if (reduced) { return; }

  // Entrance: parts of each section rise in order, once. Hidden only after this line runs.
  doc.documentElement.classList.add("js");
  var parts = "h2, .column p, .plain li, .editor, .result, .split-b, .how-text p, .slip, .price-list > div, .answers p, .cta-text p, .dialog, .foot > *";
  var riseObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) { return; }
      entry.target.classList.add("in");
      riseObserver.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8% 0px" });
  doc.querySelectorAll(parts).forEach(function (el) {
    var siblings = Array.prototype.indexOf.call(el.parentNode.children, el);
    el.classList.add("rise");
    el.style.setProperty("--d", Math.min(siblings, 5) * 70 + "ms");
    riseObserver.observe(el);
  });
})();
