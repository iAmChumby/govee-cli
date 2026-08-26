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
    // Every Next build output, whatever it is called. `.next-verify` is
    // scripts/verify_ui.py's throwaway build, kept out of `.next` so it cannot
    // clobber the deployed one — but GOVEE_WEBUI_DIST_DIR takes any name, and
    // naming one anything else made `npm run lint` report hundreds of errors in
    // generated bundles. Matching the whole family means the next person to
    // build into a scratch dir does not have to discover that.
    ignores: ["node_modules/**", ".next*/**", "out/**", "next-env.d.ts"],
  },
];

export default eslintConfig;
