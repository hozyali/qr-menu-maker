// Lets an owner drag a receipt picture onto the upload area (issue #41). Without JavaScript, the
// normal file input still works. The CSP blocks inline scripts, so this is a file.
(function () {
  "use strict";
  document.querySelectorAll("[data-drop-zone]").forEach(function (zone) {
    var input = zone.querySelector('input[type="file"]');
    var status = zone.querySelector("[data-drop-status]");
    if (!input) return;
    function show() {
      var file = input.files && input.files[0];
      if (status) status.textContent = file ? "Selected: " + file.name : "";
    }
    ["dragenter", "dragover"].forEach(function (name) {
      zone.addEventListener(name, function (event) {
        event.preventDefault();
        zone.classList.add("dragging");
      });
    });
    ["dragleave", "drop"].forEach(function (name) {
      zone.addEventListener(name, function () {
        zone.classList.remove("dragging");
      });
    });
    zone.addEventListener("drop", function (event) {
      event.preventDefault();
      if (!event.dataTransfer || !event.dataTransfer.files.length) return;
      input.files = event.dataTransfer.files;
      // photo.js listens for this and shrinks the picture before upload.
      input.dispatchEvent(new Event("change"));
      show();
    });
    input.addEventListener("change", show);
  });
})();
