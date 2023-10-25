import * as path from 'path';
import { defineConfig } from 'rspress/config';
import { addSomePages } from './rspress-plugin-add-some-pages'

export default defineConfig({
  root: path.join(__dirname, 'docs'),
  title: 'Web Infra',
  description: 'Deep Dive into Top-level await',
  themeConfig: {
    socialLinks: [
      { icon: 'github', mode: 'link', content: 'https://github.com/web-infra-dev/rspress' },
    ],
  },
  plugins: [
    addSomePages()
  ]
});
