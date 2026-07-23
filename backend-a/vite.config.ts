import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

// flue() must come before cloudflare(): it scans the 'use agent' modules and
// generates the Worker entry plus per-agent Durable Object bindings, which
// the config customizer hands to the Cloudflare plugin.
export default defineConfig({
  plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
