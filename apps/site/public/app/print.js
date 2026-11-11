// Opens the browser's print dialog from the table card page. A file, because the CSP blocks inline scripts.
(function () {
  "use strict";
  var button = document.querySelector("[data-print]");
  if (button) button.addEventListener("click", function () { window.print(); });
})();
