import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// eslint-config-next 16 ships flat configs, so they are spread directly rather
// than adapted through FlatCompat.
const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "next-env.d.ts",
      "prisma/migrations/**",
      "fixtures/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["error", { allow: ["warn", "error", "info"] }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    // Scripts and tests are operator tools: printing to stdout is the point.
    files: ["scripts/**/*.ts", "tests/**/*.ts", "vitest.config.*"],
    rules: { "no-console": "off" },
  },
];

export default config;
