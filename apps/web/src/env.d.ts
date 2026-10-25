/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly DIRECTUS_URL?: string;
  readonly DIRECTUS_PUBLIC_READ_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

type CloudflareEnv = {
  DIRECTUS_URL?: string;
  DIRECTUS_PUBLIC_READ_TOKEN?: string;
};

type Runtime = import("@astrojs/cloudflare").Runtime<CloudflareEnv>;

declare namespace App {
  interface Locals extends Runtime {}
}
