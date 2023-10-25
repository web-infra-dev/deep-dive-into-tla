import * as path from 'path';
import { defineConfig } from 'rspress/config';
import { addSomePages } from './rspress-plugin-add-some-pages'

export default defineConfig({
  root: path.join(__dirname, 'docs'),
  title: 'Top-level await',
  description: 'Deep Dive into TLA',
  icon: "/rspress-icon.png",
  logo: {
    light: "/rspress-light-logo.png",
    dark: "/rspress-dark-logo.png",
  },
  markdown: {
    // Switch to the JS version of the compiler
    mdxRs: false,
  },
  themeConfig: {
    socialLinks: [
      { icon: 'github', mode: 'link', content: 'https://github.com/web-infra-dev/rspress' },
    ],
  },
  plugins: [
    addSomePages()
  ]
});
