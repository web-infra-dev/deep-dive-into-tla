import * as path from 'path';
import { defineConfig } from 'rspress/config';
import { loadReadme } from 'rspress-plugin-load-readme';

export default defineConfig({
  root: path.join(__dirname, 'docs'),
  title: 'Web Infra',
  description: 'Deep Dive into Top-level await',
  themeConfig: {
    socialLinks: [
      { icon: 'github', mode: 'link', content: 'https://github.com/ulivz/deep-dive-into-tla' },
    ],
  },
  plugins: [
    loadReadme({
      repo: 'ulivz/deep-dive-into-tla',
      route: '/post'
    })
  ]
});
