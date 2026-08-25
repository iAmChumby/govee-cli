import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // .next-verify is scripts/verify_ui.py's throwaway build, kept out of
    // .next so it cannot clobber the deployed one.
    ignores: ["node_modules/**", ".next/**", ".next-verify/**", "out/**", "next-env.d.ts"],
  },
];

export default eslintConfig;
