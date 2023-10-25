import https from "https";
import { RspressPlugin } from "@rspress/shared";

function download(url: string): Promise<string | never> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const { statusCode } = res;
      let error;

      if (statusCode !== 200) {
        error = new Error("请求失败\n" + `状态码: ${statusCode}`);
      }
      if (error) {
        console.error(error.message);
        // 消耗响应数据以释放内存
        res.resume();
        reject(error)
      }

      res.setEncoding("utf8");
      let rawData = "";
      res.on("data", (chunk) => {
        rawData += chunk;
      });
      res.on("end", () => {
        resolve(rawData);
      });
      res.on("error", (error) => {
        reject(error);
      });
    });
  });
}

export function addSomePages(): RspressPlugin {
  let md: string;

  return {
    name: "add-pages",
    async beforeBuild(config, isProd) {
      md = await download(
        "https://raw.githubusercontent.com/ulivz/deep-dive-into-tla/master/README.md"
      );
    },
    addPages(config, isProd) {
      console.log(md);

      return [
        //  Support the absolute path of the real file (filepath), which will read the content of md(x) in the disk
        {
          routePath: "/tla",
          content: md,
        },
      ];
    },
  };
}
