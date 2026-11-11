import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { page } from "../shared/layout";
import { checkImageUpload, deletePhotos, newPhotoKey } from "../shared/media";
import { type Profile, tenantDb } from "../shared/tenant-db";
import { type FieldErrors, type ProfileInput, readText, validateProfile } from "../shared/validation";
import { type OwnerEnv, siteOrigin } from "./menu";

// Restaurant profile and logo (issue #28). The restaurant always comes from the login session (Law 18).

type OwnerContext = Context<OwnerEnv>;

const profileDb = (c: OwnerContext) => tenantDb(c.env.DB, c.get("owner").restaurantId);

interface FieldSpec {
  name: keyof ProfileInput;
  form: string;
  label: string;
  type: string;
  max: number;
  hint?: string;
  required?: boolean;
  extra?: string;
}

const FIELDS: FieldSpec[] = [
  { name: "name", form: "name", label: "Restaurant name", type: "text", max: 60, required: true, extra: "organization" },
  { name: "city", form: "city", label: "City", type: "text", max: 40, required: true, hint: "Your menu link stays the same even if you change the name or city." },
  { name: "address", form: "address", label: "Address", type: "text", max: 160, extra: "street-address" },
  { name: "phone", form: "phone", label: "Phone", type: "tel", max: 20, required: true, hint: "Customers can tap Call on your menu.", extra: "tel" },
  { name: "whatsapp", form: "whatsapp", label: "WhatsApp number", type: "tel", max: 20, hint: "Optional. Adds a WhatsApp button to your menu." },
  { name: "mapsUrl", form: "maps_url", label: "Google Maps link", type: "url", max: 500, hint: "Optional. In Google Maps, tap Share on your restaurant and paste the link here." },
  { name: "hours", form: "hours", label: "Opening hours", type: "text", max: 80, hint: 'Optional, for example "Daily 12 pm to 1 am".' },
  { name: "note", form: "note", label: "Note for customers", type: "text", max: 200, hint: 'Optional, for example "Prices include tax".' },
];

function field(spec: FieldSpec, value: string, errors: FieldErrors) {
  const error = errors[spec.form];
  const describedBy = [spec.hint ? `${spec.form}-hint` : "", error ? `${spec.form}-error` : ""].filter(Boolean).join(" ");
  return html`<div class="field">
<label for="${spec.form}">${spec.label}</label>
<input id="${spec.form}" name="${spec.form}" type="${spec.type}" value="${value}" maxlength="${spec.max}"${spec.required ? html` required` : ""}${spec.extra ? html` autocomplete="${spec.extra}"` : ""}${describedBy ? html` aria-describedby="${describedBy}"` : ""}${error ? html` aria-invalid="true"` : ""}>
${spec.hint ? html`<p class="hint" id="${spec.form}-hint">${spec.hint}</p>` : ""}
${error ? html`<p class="field-error" id="${spec.form}-error">${error}</p>` : ""}
</div>`;
}

function logoSection(profile: Profile, error = "") {
  return html`<section class="card form photo-section" aria-labelledby="logo-heading">
<h2 id="logo-heading">Logo</h2>
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
${profile.logoKey ? html`<img class="logo-preview" src="/media/${profile.logoKey}" alt="${profile.name} logo" width="120" height="120">` : html`<p class="empty">No logo yet. It shows at the top of your menu.</p>`}
<form method="post" action="/profile/logo" enctype="multipart/form-data" class="form" data-photo-form>
<div class="field"><label for="logo">${profile.logoKey ? "Change logo" : "Add logo"}</label>
<input id="logo" name="logo" type="file" accept="image/jpeg,image/png,image/webp" required aria-describedby="logo-hint">
<p class="hint" id="logo-hint">JPG, PNG, or WEBP. A square logo looks best.</p></div>
<button class="button" type="submit">Upload logo</button>
</form>
${profile.logoKey ? html`<form method="post" action="/profile/logo/delete"><button class="button secondary" type="submit">Remove logo</button></form>` : ""}
</section>
<script src="/photo.js" defer></script>`;
}

function profilePage(c: OwnerContext, profile: Profile, values: ProfileInput, errors: FieldErrors = {}, notice = "", logoError = "") {
  return page(
    "Profile",
    html`<h1>Restaurant profile</h1>
<p class="lead">These details show on your menu at <a href="${siteOrigin(c.req.url)}/r/${profile.slug}" target="_blank" rel="noopener">tomatofry.com/r/${profile.slug}</a>.</p>
<form class="card form" method="post" action="/profile" novalidate>
${Object.keys(errors).length > 0 ? html`<p class="error" role="alert">Please fix the fields below.</p>` : ""}
${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
${FIELDS.map((spec) => field(spec, values[spec.name], errors))}
<button class="button" type="submit">Save profile</button>
<a class="button secondary" href="/">Back to dashboard</a>
</form>
${logoSection(profile, logoError)}`,
  );
}

function readProfileForm(form: FormData): ProfileInput {
  return {
    name: readText(form, "name"),
    city: readText(form, "city"),
    address: readText(form, "address"),
    phone: readText(form, "phone"),
    whatsapp: readText(form, "whatsapp"),
    mapsUrl: readText(form, "maps_url"),
    hours: readText(form, "hours"),
    note: readText(form, "note"),
  };
}

export function registerProfileRoutes(app: Hono<OwnerEnv>) {
  app.get("/profile", async (c) => {
    const profile = await profileDb(c).getProfile();
    if (!profile) return c.redirect("/login", 303);
    return c.html(profilePage(c, profile, profile, {}, c.req.query("saved") ? "Profile saved." : ""));
  });

  app.post("/profile", async (c) => {
    const db = profileDb(c);
    const profile = await db.getProfile();
    if (!profile) return c.redirect("/login", 303);
    // Only these named fields are read. Anything else in the form, like a restaurant id, is ignored.
    const values = readProfileForm(await c.req.formData());
    const errors = validateProfile(values);
    if (Object.keys(errors).length > 0) {
      return c.html(profilePage(c, profile, values, errors), 400);
    }
    await db.updateProfile(values);
    return c.redirect("/profile?saved=1", 303);
  });

  app.post("/profile/logo", async (c) => {
    const db = profileDb(c);
    const profile = await db.getProfile();
    if (!profile) return c.redirect("/login", 303);
    const upload = await checkImageUpload((await c.req.formData()).get("logo"));
    if (!upload.ok) {
      return c.html(profilePage(c, profile, profile, {}, "", upload.error), 400);
    }
    // The key always uses the session's restaurant id, so the file can only land in its own folder.
    const key = newPhotoKey(c.get("owner").restaurantId, upload.type);
    await c.env.MEDIA.put(key, upload.bytes, { httpMetadata: { contentType: upload.type.contentType } });
    const previous = await db.setLogo(key);
    await deletePhotos(c.env.MEDIA, [previous]);
    return c.redirect("/profile", 303);
  });

  app.post("/profile/logo/delete", async (c) => {
    const previous = await profileDb(c).setLogo(null);
    await deletePhotos(c.env.MEDIA, [previous]);
    return c.redirect("/profile", 303);
  });
}
