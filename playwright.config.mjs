import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/desktop', timeout: 90000, workers: 1, retries: 0, reporter: 'list' });
