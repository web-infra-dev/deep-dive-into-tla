import * as path from "path";
import { defineConfig } from "rspress/config";
import { remotePage } from "rspress-plugin-remote-page";

export default defineConfig({
  root: path.join(__dirname, "docs"),
  title: "Web Infra",
  description: "Deep Dive into Top-level await",
  lang: 'en',
  locales: [
    {
      lang: 'en',
      // The label in nav bar to switch language
      label: 'English',
      title: 'Web Infra',
      description: 'Deep Dive into Top-level await',
    },
    {
      lang: 'zh',
      // The label in nav bar to switch language
      label: '简体中文',
      title: 'Web Infra',
      description: 'Deep Dive into Top-level await',
    },
  ],
  themeConfig: {
    socialLinks: [
      {
        icon: "github",
        mode: "link",
        content: "https://github.com/ulivz/deep-dive-into-tla",
      },
    ],
  },
  plugins: [
    remotePage({
      pages: [
        {
          remotePath: "https://github.com/web-infra-dev/deep-dive-into-tla/blob/master/README.md",
          routePath: "/en/post",
        },
        {
          remotePath: "https://github.com/web-infra-dev/deep-dive-into-tla/blob/master/README-zh-CN.md",
          routePath: "/zh/post",
        },
      ],
    }),
  ],
});
