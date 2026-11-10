// Shrinks a chosen photo in the browser before upload, so menus load fast on slow phones.
// If anything fails, the original file is uploaded and the server still checks it.
(function () {
  "use strict";
  var MAX_SIDE = 800;
  var forms = document.querySelectorAll("[data-photo-form]");
  forms.forEach(function (form) {
    var input = form.querySelector('input[type="file"]');
    if (!input || !window.createImageBitmap || !window.DataTransfer) return;
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (!file) return;
      createImageBitmap(file)
        .then(function (bitmap) {
          var scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
          var canvas = document.createElement("canvas");
          canvas.width = Math.round(bitmap.width * scale);
          canvas.height = Math.round(bitmap.height * scale);
          canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          return new Promise(function (resolve) {
            canvas.toBlob(resolve, "image/webp", 0.82);
          });
        })
        .then(function (blob) {
          if (!blob || blob.type !== "image/webp") return;
          var smaller = new File([blob], "photo.webp", { type: "image/webp" });
          var transfer = new DataTransfer();
          transfer.items.add(smaller);
          input.files = transfer.files;
        })
        .catch(function () {
          // Keep the original file.
        });
    });
  });
})();
