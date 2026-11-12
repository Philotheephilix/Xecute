import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  extensionEntrypoints: {},
  manifest: {
    name: 'Floors',
    description: 'Buy crypto from X posts',
    permissions: ['storage', 'scripting'],
    // http://localhost:* is included for E2E smoke tests (fixture server).
    // Production content scripts only match x.com/twitter.com.
    host_permissions: ['https://x.com/*', 'https://twitter.com/*', 'http://localhost/*'],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
