import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["public/", "worker-configuration.d.ts", ".wrangler/", "node_modules/"] },
  ...tseslint.configs.recommended,
  {
    // Restaurant data must go through the tenant helper (Law 18).
    files: ["src/**/*.ts"],
    // accounts-db.ts holds the reviewed account queries that run before a restaurant is known.
    // public-menu-db.ts holds the reviewed public menu queries, which return public fields only (Law 17).
    ignores: ["src/shared/tenant-db.ts", "src/shared/accounts-db.ts", "src/shared/public-menu-db.ts", "src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='prepare']",
          message: "Use the tenant helper in src/shared/tenant-db.ts. Direct database queries are not allowed here (Law 18).",
        },
      ],
    },
  },
);
