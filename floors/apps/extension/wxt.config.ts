import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  extensionEntrypoints: {},
  manifest: {
    name: 'Floors',
    description: 'Buy crypto from X posts',
    permissions: ['storage', 'scripting'],
    host_permissions: ['https://x.com/*', 'https://twitter.com/*'],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
