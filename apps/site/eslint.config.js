import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["public/", "worker-configuration.d.ts", ".wrangler/", "node_modules/"] },
  ...tseslint.configs.recommended,
);
