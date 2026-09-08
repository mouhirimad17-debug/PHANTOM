import { defineConfig } from 'vite';

// GitHub Pages serves project sites from https://<user>.github.io/<repo>/,
// so production asset URLs must be rooted at that subpath. Dev/preview stay
// at "/" so `npm run dev` and `npm run preview` are unaffected.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/PHANTOM/' : '/',
}));
