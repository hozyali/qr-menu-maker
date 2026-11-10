import type { Context, Hono } from "hono";
import { html } from "hono/html";
import type { OwnerSession } from "../shared/accounts-db";
import { page } from "../shared/layout";
import { planLimit } from "../shared/plans";
import { type Item, type Price, tenantDb } from "../shared/tenant-db";
import { readText } from "../shared/validation";

export type OwnerEnv = { Bindings: Env; Variables: { owner: OwnerSession } };
type OwnerContext = Context<OwnerEnv>;

const PRICE_ROWS = 4;
const MAX_RUPEES = 9_999_999;

// The restaurant always comes from the login session (Law 18).
const menuDb = (c: OwnerContext) => tenantDb(c.env.DB, c.get("owner").restaurantId);

const money = (amountMinor: number) =>
  `Rs ${(amountMinor / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function notFound(c: OwnerContext) {
  return c.html(page("Not found", html`<h1>Not found</h1><p class="lead">This page does not exist. <a href="/">Back to your menu</a></p>`), 404);
}

interface DishForm {
  categoryId: string;
  name: string;
  description: string;
  prices: Price[];
  /** What the owner typed, shown again when there is an error. */
  rows: { label: string; amount: string }[];
  error: string;
}

/** Reads and checks the dish form on the server (Law 19). */
function readDishForm(form: FormData): DishForm {
  const labels = form.getAll("price_label").map((v) => (typeof v === "string" ? v.trim() : ""));
  const amounts = form.getAll("price_amount").map((v) => (typeof v === "string" ? v.trim() : ""));
  const rows = Array.from({ length: Math.min(Math.max(labels.length, amounts.length), PRICE_ROWS) }, (_, i) => ({
    label: labels[i] ?? "",
    amount: amounts[i] ?? "",
  }));
  const result: DishForm = {
    categoryId: readText(form, "category_id"),
    name: readText(form, "name"),
    description: readText(form, "description"),
    prices: [],
    rows,
    error: "",
  };
  if (result.name.length < 1 || result.name.length > 80) {
    result.error = "Enter a dish name of up to 80 characters.";
    return result;
  }
  if (result.description.length > 200) {
    result.error = "Keep the description to 200 characters.";
    return result;
  }
  for (const row of rows) {
    if (!row.amount && !row.label) continue;
    // Owners often type "2,400", so commas and spaces are allowed.
    const cleaned = row.amount.replace(/[,\s]/g, "");
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(cleaned) || Number(cleaned) > MAX_RUPEES) {
      result.error = "Each price must be a number in rupees, like 1300 or 2,400.";
      return result;
    }
    if (row.label.length > 20) {
      result.error = "Keep each price label, like Half or Full, to 20 characters.";
      return result;
    }
    result.prices.push({ label: row.label, amountMinor: Math.round(Number(cleaned) * 100) });
  }
  if (result.prices.length === 0) {
    result.error = "Add at least one price.";
  }
  return result;
}

function dishPage(
  title: string,
  action: string,
  categories: { id: string; name: string }[],
  values: { categoryId: string; name: string; description: string; rows: { label: string; amount: string }[] },
  error = "",
) {
  const rows = [...values.rows];
  while (rows.length < PRICE_ROWS) rows.push({ label: "", amount: "" });
  return page(
    title,
    html`<h1>${title}</h1>
<form class="card form" method="post" action="${action}" novalidate>
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<div class="field"><label for="category_id">Category</label>
<select id="category_id" name="category_id">${categories.map(
      (cat) => html`<option value="${cat.id}"${cat.id === values.categoryId ? html` selected` : ""}>${cat.name}</option>`,
    )}</select></div>
<div class="field"><label for="name">Dish name</label><input id="name" name="name" value="${values.name}" maxlength="80" required></div>
<div class="field"><label for="description">Description</label><input id="description" name="description" value="${values.description}" maxlength="200"><p class="hint">Optional, for example "Tomato, green chilli, fresh ginger".</p></div>
<fieldset class="prices"><legend>Prices</legend>
<p class="hint">Use one row for a single price. Use more rows for sizes like Half and Full.</p>
${rows.map(
  (row, i) => html`<div class="price-row">
<div class="field"><label for="price_label_${i}">Size</label><input id="price_label_${i}" name="price_label" value="${row.label}" maxlength="20"></div>
<div class="field"><label for="price_amount_${i}">Price in rupees</label><input id="price_amount_${i}" name="price_amount" value="${row.amount}" inputmode="decimal" maxlength="12"></div>
</div>`,
)}
</fieldset>
<button class="button" type="submit">Save dish</button>
<a class="button secondary" href="/?c=${values.categoryId}">Cancel</a>
</form>`,
  );
}

function confirmPage(title: string, message: string, action: string, back: string) {
  // A confirmation page instead of a browser popup (Law 27).
  return page(
    title,
    html`<h1>${title}</h1>
<div class="card form">
<p>${message}</p>
<form method="post" action="${action}"><button class="button danger" type="submit">Yes, delete</button></form>
<a class="button secondary" href="${back}">Keep it</a>
</div>`,
  );
}

function dishRow(item: Item) {
  return html`<li class="dish">
<div class="dish-main"><strong>${item.name}</strong>
${item.description ? html`<span class="meta">${item.description}</span>` : ""}
<span class="price-list">${item.prices.map((p) => html`<span class="pill">${p.label ? `${p.label} ` : ""}${money(p.amountMinor)}</span>`)}</span></div>
<form method="post" action="/items/${item.id}/availability">
<input type="hidden" name="available" value="${item.isAvailable ? "0" : "1"}">
<button class="switch-button ${item.isAvailable ? "on" : "off"}" type="submit" aria-label="${item.name}: ${item.isAvailable ? "available, mark as not available today" : "not available today, mark as available"}">${item.isAvailable ? "Available" : "Not today"}</button>
</form>
<a class="button secondary small" href="/items/${item.id}/edit">Edit</a>
<a class="button secondary small" href="/items/${item.id}/delete">Delete</a>
</li>`;
}

export function registerMenuRoutes(app: Hono<OwnerEnv>) {
  app.get("/", async (c) => {
    const owner = c.get("owner");
    const db = menuDb(c);
    const categories = await db.listCategories();
    const requested = c.req.query("c");
    // Only a category from this restaurant can be shown. Anything else falls back to the first one.
    const current = categories.find((cat) => cat.id === requested) ?? categories[0];
    const items = current ? await db.listItems(current.id) : [];
    const used = await db.countItems();
    const limit = planLimit(owner.plan, "max_items");
    const notice = c.req.query("notice");

    return c.html(
      page(
        owner.restaurantName,
        html`<header class="top">
<h1>${owner.restaurantName}</h1>
<form method="post" action="/logout"><button class="button secondary small" type="submit">Log out</button></form>
</header>
${notice === "limit" ? html`<p class="error" role="alert">You have used all ${limit} dishes on the Free plan. Upgrade to Pro to add more.</p>` : ""}
<div class="stats">
<div class="stat"><span class="meta">Plan</span><strong>${owner.plan === "pro" ? "Pro" : "Free"}</strong></div>
<div class="stat"><span class="meta">Dishes</span><strong>${limit === null ? `${used}` : `${used} of ${limit}`}</strong></div>
<div class="stat"><span class="meta">Menu link</span><strong class="link">tomatofry.com/r/${owner.slug}</strong></div>
</div>
<nav class="tabs" aria-label="Categories">
${categories.map(
  (cat) => html`<a class="tab${cat.id === current?.id ? " on" : ""}" href="/?c=${cat.id}"${cat.id === current?.id ? html` aria-current="page"` : ""}>${cat.name}</a>`,
)}
</nav>
<form class="inline-form" method="post" action="/categories">
<label class="sr-only" for="new-category">New category name</label>
<input id="new-category" name="name" maxlength="40" placeholder="New category, like Karahi" required>
<button class="button secondary small" type="submit">Add category</button>
</form>
${
  current
    ? html`<section class="card">
<div class="section-head"><h2>${current.name}</h2>
<div class="actions">
<form method="post" action="/categories/${current.id}/move"><input type="hidden" name="direction" value="up"><button class="button secondary small" type="submit" aria-label="Move ${current.name} up">Move up</button></form>
<form method="post" action="/categories/${current.id}/move"><input type="hidden" name="direction" value="down"><button class="button secondary small" type="submit" aria-label="Move ${current.name} down">Move down</button></form>
<a class="button secondary small" href="/categories/${current.id}/delete">Delete category</a>
</div></div>
<form class="inline-form" method="post" action="/categories/${current.id}/rename">
<label class="sr-only" for="rename">Rename ${current.name}</label>
<input id="rename" name="name" maxlength="40" value="${current.name}" required>
<button class="button secondary small" type="submit">Rename</button>
</form>
${items.length > 0 ? html`<ul class="dishes">${items.map(dishRow)}</ul>` : html`<p class="empty">No dishes in ${current.name} yet. Add the first one.</p>`}
<a class="button" href="/items/new?c=${current.id}">Add dish</a>
</section>`
    : html`<div class="card empty"><h2>Start with a category</h2><p>Add one like Karahi, BBQ, or Drinks above. Then add dishes to it.</p></div>`
}`,
        "",
        "wide",
      ),
    );
  });

  app.post("/categories", async (c) => {
    const name = readText(await c.req.formData(), "name");
    if (name.length < 1 || name.length > 40) {
      return c.html(page("Category", html`<h1>Category not added</h1><p class="error" role="alert">Enter a category name of up to 40 characters.</p><p><a href="/">Back to your menu</a></p>`), 400);
    }
    const { id } = await menuDb(c).createCategory(name);
    return c.redirect(`/?c=${id}`, 303);
  });

  app.post("/categories/:id/rename", async (c) => {
    const id = c.req.param("id");
    const name = readText(await c.req.formData(), "name");
    if (name.length >= 1 && name.length <= 40) {
      await menuDb(c).renameCategory(id, name);
    }
    return c.redirect(`/?c=${encodeURIComponent(id)}`, 303);
  });

  app.post("/categories/:id/move", async (c) => {
    const id = c.req.param("id");
    const direction = readText(await c.req.formData(), "direction") === "down" ? "down" : "up";
    await menuDb(c).moveCategory(id, direction);
    return c.redirect(`/?c=${encodeURIComponent(id)}`, 303);
  });

  app.get("/categories/:id/delete", async (c) => {
    const category = await menuDb(c).getCategory(c.req.param("id"));
    if (!category) return notFound(c);
    return c.html(
      confirmPage(
        "Delete category",
        `Delete "${category.name}" and its ${category.itemCount} dishes? This cannot be undone.`,
        `/categories/${category.id}/delete`,
        `/?c=${category.id}`,
      ),
    );
  });

  app.post("/categories/:id/delete", async (c) => {
    await menuDb(c).deleteCategory(c.req.param("id"));
    return c.redirect("/", 303);
  });

  app.get("/items/new", async (c) => {
    const categories = await menuDb(c).listCategories();
    if (categories.length === 0) return c.redirect("/", 303);
    const requested = c.req.query("c");
    const categoryId = categories.some((cat) => cat.id === requested) ? (requested ?? "") : (categories[0]?.id ?? "");
    return c.html(dishPage("Add dish", "/items", categories, { categoryId, name: "", description: "", rows: [] }));
  });

  app.post("/items", async (c) => {
    const owner = c.get("owner");
    const db = menuDb(c);
    const dish = readDishForm(await c.req.formData());
    const categories = await db.listCategories();
    if (!categories.some((cat) => cat.id === dish.categoryId)) return notFound(c);
    if (dish.error) {
      return c.html(dishPage("Add dish", "/items", categories, dish, dish.error), 400);
    }
    // The plan limit is checked on the server, so it cannot be skipped from the browser.
    const limit = planLimit(owner.plan, "max_items");
    if (limit !== null && (await db.countItems()) >= limit) {
      return c.html(
        dishPage("Add dish", "/items", categories, dish, `The Free plan allows ${limit} dishes. Upgrade to Pro to add more.`),
        403,
      );
    }
    await db.createItem(dish);
    return c.redirect(`/?c=${encodeURIComponent(dish.categoryId)}`, 303);
  });

  app.get("/items/:id/edit", async (c) => {
    const db = menuDb(c);
    const item = await db.getItem(c.req.param("id"));
    if (!item) return notFound(c);
    return c.html(
      dishPage("Edit dish", `/items/${item.id}`, await db.listCategories(), {
        categoryId: item.categoryId,
        name: item.name,
        description: item.description ?? "",
        rows: item.prices.map((p) => ({ label: p.label, amount: String(p.amountMinor / 100) })),
      }),
    );
  });

  app.post("/items/:id", async (c) => {
    const db = menuDb(c);
    const id = c.req.param("id");
    const dish = readDishForm(await c.req.formData());
    if (dish.error) {
      return c.html(dishPage("Edit dish", `/items/${id}`, await db.listCategories(), dish, dish.error), 400);
    }
    if (!(await db.updateItem(id, dish))) return notFound(c);
    return c.redirect(`/?c=${encodeURIComponent(dish.categoryId)}`, 303);
  });

  app.post("/items/:id/availability", async (c) => {
    const db = menuDb(c);
    const id = c.req.param("id");
    const available = readText(await c.req.formData(), "available") === "1";
    const item = await db.getItem(id);
    if (!item) return notFound(c);
    await db.setItemAvailable(id, available);
    return c.redirect(`/?c=${encodeURIComponent(item.categoryId)}`, 303);
  });

  app.get("/items/:id/delete", async (c) => {
    const item = await menuDb(c).getItem(c.req.param("id"));
    if (!item) return notFound(c);
    return c.html(
      confirmPage("Delete dish", `Delete "${item.name}"? This cannot be undone.`, `/items/${item.id}/delete`, `/?c=${item.categoryId}`),
    );
  });

  app.post("/items/:id/delete", async (c) => {
    const db = menuDb(c);
    const item = await db.getItem(c.req.param("id"));
    if (!item) return notFound(c);
    await db.deleteItem(item.id);
    return c.redirect(`/?c=${encodeURIComponent(item.categoryId)}`, 303);
  });
}
