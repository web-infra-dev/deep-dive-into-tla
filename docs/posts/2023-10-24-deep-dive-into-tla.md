# Deep Dive into `Top-Level-Await (TLA)`

<p align="center">
  <img
    width="200"
    src="https://github.com/ulivz/tla-website/blob/master/docs/public/promise.gif?raw=true"
  />
</p>

## Introduction

在 ByteDance 内，我们基于 [Rsbuild](https://github.com/web-infra-dev/rsbuild) 建设的 Mobile Web Framework 的用户遇到了 [Syntax Checker](https://github.com/web-infra-dev/rsbuild/blob/main/packages/document/docs/en/shared/config/security/checkSyntax.md#enable-detection) 问题:

```bash {6-7}
error   [Syntax Checker] Find some syntax errors after production build:

  ERROR#1:
  source - /node_modules/pia-app/esm/utils.js:6:7
  output - /pia/example/kit/dist/resource/js/vendor.505d4345.js:1:32501
  reason - Unexpected token (1:32501)
  code   - async(e,r)=>{try{var t=o(326)

Error: [Syntax Checker] The current build fails due to an incompatible syntax, which can be fixed in the following ways:
```

针对这类问题，我们首先想到的是此问题可能是三方依赖引入的，这是因为 **“构建器出于编译性能的考虑，默认情况下，Builder 不会编译 `node_modules` 下的 `*.js|ts` 文件”**，用户此时可能依赖了一个产物中包含 `async/await` 的三方依赖，导致最终编译错误。于是，我们建议开发者使用 [source.include](https://modernjs.dev/builder/en/api/config-source.html#sourceinclude) 来 [Downgrade third-party dependencies](https://modernjs.dev/builder/en/guide/advanced/browser-compatibility.html#downgrade-third-party-dependencies):

```ts
export default {
  source: {
    include: [/\/node_modules\/query-string\//],
  },
};
```

有意思的是，**这一次的问题和我们想象的并不相同**，当我们使用 [Source Map Visualization](https://evanw.github.io/source-map-visualization/) 来定位问题时，我们发现，`async` 的位置是白色的 —— **没有源码与之映射**:

![](https://github.com/ulivz/tla-website/blob/master/docs/public/source-map-missing.png?raw=true)

随着进一步分析，我们发现这个 `async` 是由 Webpack 编译 [TLA (Top-level await)](https://github.com/tc39/proposal-top-level-await) 注入的 Runtime 引入的。在这样的背景下，我们开始继续研究 TLA。

在本文中，我们将进一步对 TLA 的 [Specification](specification)、[Toolchain Support](#toolchain-support)、[Webpack Runtime](#webpack-tla-runtime)、Availability、[Profiling](#profiling) 等进行了更为深入和全面的分析。

## Specification

我们可以在 [ECMAScript proposal: Top-level await](https://github.com/tc39/proposal-top-level-await) 了解到 **TLA** 的最新的标准定义。TLA 的设计初衷来源于 `await` 仅在 `async function` 内可用，这带来了以下问题：

1.  一个模块如果存在 `IIAFE` (_Immediately Invoked Async Function Expression_) ，可能会导致 `exports` 在该 `IIAFE` 的初始化完成之前就被访问，如下所示：

```ts {4-6}
// awaiting.mjs
let output;

(async () => {
  output = await fetch(url);
})();

export { output }; // output 被消费时，上述 IIAFE 还没执行结束
```

2. 为了解决 1 中的问题，我们可能需要导出一个 Promise 给上游消费，但导出 Promise 显然会导致使用也需要感知这一类型：

```ts {4}
// awaiting.mjs
let output;

export default (async () => {
  output = fetch(url); // await 被移除了，output 是一个 promise
})();

export { output };
```

接着，我们可以这样消费：

```ts
// usage.mjs
import promise, { output } from "./awaiting.mjs";
export function outputPlusValue(value) {
  return output + value;
}

promise.then(() => {
  console.log(output);
});
```

这带来了以下问题：

1. 每个依赖方都必须了解该模块的协议才能正确的使用该模块；
2. 如果你忘记了这一协议，有时代码可能能够正常 Work（由于 `race` 获胜），有时则不能；
3. 在多层依赖的情况下，Promise 需要贯穿在每个模块中（_“链式污染”？_）。


<p align="center">
  <img
    width="200"
    src="https://github.com/ulivz/tla-website/blob/master/docs/public/promise.gif?raw=true"
  />
</p>

为此，引入 `Top-level await`，模块的写法将可以变成这样：​

```ts
const output = await fetch(url);
export { output };
```

一个典型的用例，就是解决 **“动态依赖路径”** 的问题，这对于**国际化、基于环境拆分依赖**等场景非常有用：​

```ts
const strings = await import(`/i18n/${navigator.language}`);
```

更多的用例见[这里](https://github.com/tc39/proposal-top-level-await#use-cases)。​

## Compatibility

根据 [Can I Use](https://caniuse.com/?search=top%20level%20await)，我们可以在 **Chrome 89**，以及 **Safari 15** 上使用 TLA，**Node.js** 在 [v14.8.0](https://nodejs.org/en/blog/release/v14.8.0) 也正式支持了 TLA。

<p align="center">
  <img
    width="500"
    src="https://github.com/ulivz/tla-website/blob/master/docs/public/compatibility.png?raw=true"
  />
</p>

你可以快速复制这段代码到你的 Chrome Devtools Console 面板或 Node.js 命令行中执行：

```ts
function sleep(t) {
  return new Promise((resolve) => {
    setTimeout(resolve, t);
  });
}

await sleep(1000);

console.log("Hello, TLA!");
```

<p align="center">
  <img
    width="300"
    src="https://github.com/ulivz/tla-website/blob/master/docs/public/tla-result.png?raw=true"
  />
</p>

这是原生支持的 TLA 的效果，但是由于这是一个较新的 ECMAScript 特性，我们目前（2023 年）很难直接在前端 UI 代码中使用它。如果目前想要在 UI 代码中使用它，还是需要借助编译工具。下一节，我们将会介绍常见的工具链的 “**编译行为**” 和 “**产物的兼容性**”。

## Toolchain Support

### Prerequisites

<p align="center">
  <img
    width="200"
    src="https://github.com/ulivz/tla-website/blob/master/docs/public/promise.gif?raw=true"
  />
</p>

为了统一测试编译行为的基准，我们约定测试的 Minimal Example 如下：

<p align="center">
  <img width="300" src="https://github.com/ulivz/tla-website/blob/master/docs/public/minimal-example.png?raw=true">
</p>

<details>
  <summary>展开原始代码</summary>
  <p>
    
  ```ts
  // a.ts
  import { B } from "./b";
  import { C } from "./c";

  console.log("Hello", B, C);

  ```

  ```ts
  // b.ts
  import { sleep } from "./d";

  await sleep(1000);
  export const B = "TLA (b)";
  ```

  ```ts
  // c.ts
  import { sleep } from "./d";

  await sleep(500);
  export const C = "TLA (c)";
  ```

  ```ts
  // d.ts
  export function sleep(t: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, t);
    });
  }
  ```

  </p>
</details>

各 Tooling 的最小仓库见 [TypeScript (tsc)](https://github.com/ulivz/tsc-top-level-import) | [esbuild](https://github.com/ulivz/esbuild-top-level-import) | [Rollup](https://github.com/ulivz/rollup-top-level-import) | [Webpack](https://github.com/ulivz/webpack-top-level-import)。这里没有为 bun 创建 example，bun 只需要在任意仓库下运行 `bun build src/a.ts --outdir ./build --format esm`。

### TypeScript (tsc)

在 `tsc` 中，仅在 `module` 为 `es2022`、`esnext`、`system`、`node16`、`nodenext`，且 `target >= es2017` 时才能成功编译 TLA，否则会遇到如下报错：

```ts
src/top-level-await.ts:3:1 - error TS1378: Top-level 'await' expressions are only allowed when the 'module' option is set to 'es2022', 'esnext', 'system', 'node16', or 'nodenext', and the 'target' option is set to 'es2017' or higher.

3 await sleep(100);
  ~~~~~
```

编译成功后，可以看到发现产物和源码几乎一样：

```ts
// esm/a.js
import { B } from "./b";
import { C } from "./c";
console.log("Hello", B, C);
```

```ts
// esm/b.js
import { sleep } from "./d";
await sleep(1000);
export const B = "TLA (b)";
```

```ts
// esm/c.js
import { sleep } from "./d";
await sleep(500);
export const C = "TLA (c)";
```

```ts
// esm/d.js
export function sleep(t) {
  return new Promise((resolve) => {
    setTimeout(resolve, t);
  });
}
```

由于 tsc 是一个 transpiler，不存在 bundle 行为，因此 tsc 下不会为 TLA 引入额外的 Runtime，也就是说，**tsc 没有考虑 TLA 的兼容性**。可移步 [Profiling](#profiling) 一节，了解如何去运行这段产物。

### esbuild

esbuild 目前只能在 `format` 为 `esm`，且 `target >= es2022` 时（这一点和 tsc 的 `module` 对齐，而不是 `target`）才能成功编译 TLA，也就是说，esbuild 本身只处理了成功编译，不会对 TLA 的兼容性负责：

| <img width="500" src="https://github.com/ulivz/tla-website/blob/master/docs/public/tsc-tla-errpr-1.png?raw=true" /> | <img width="500" src="https://github.com/ulivz/tla-website/blob/master/docs/public/tsc-tla-errpr-2.png?raw=true" /> |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |

编译成功后，产物如下：

```ts
// src/d.ts
function sleep(t) {
  return new Promise((resolve) => {
    setTimeout(resolve, t);
  });
}

// src/b.ts
await sleep(1e3);
var B = "TLA (b)";

// src/c.ts
await sleep(500);
var C = "TLA (c)";

// src/a.ts
console.log("Hello", B, C);
```

可以看到，这里的产出直接平铺了所有的 `module`，这似乎改变了代码原始的语义！这一点我们可以在 [Profiling](#profiling) 一节中得到验证。

对于 TLA 在 esbuild 中的支持，我们可以在 https://github.com/evanw/esbuild/issues/253 中找到一些信息，evanw 的对此的回复是：

> Sorry, top-level await is not supported. It messes with a lot of things and adding support for it is quite complicated. It likely won't be supported for a long time.

### Rollup

Rollup 只能在 format 为 es 或 system 的场景下支持成功编译 TLA:

![](https://github.com/ulivz/tla-website/blob/master/docs/public/rollup-tla.png?raw=true)

`es` 这里和 `esbuild` 的行为一样修改了语义，这里不再赘述。对于 `system`，通过阅读 [SystemJS 文档](https://github.com/systemjs/systemjs/blob/main/docs/system-register.md#format-definition)，SystemJS 支持模块被定义为一个 Async Module：

> `execute: AsyncFunction` - If using an asynchronous function for execute, top-level await execution support semantics are provided following [variant B of the specification](https://github.com/tc39/proposal-top-level-await#variant-b-top-level-await-does-not-block-sibling-execution).

因此，Rollup 这里也不会有特殊的行为，只是将 TLA 包裹在 execute 函数中，因此 Rollup 本身对 TLA 没有更多的 Runtime 层面的处理。关于 Rollup 在 iife 下支持 TLA 有一条 issue，可移步了解更多：https://github.com/rollup/rollup/issues/3623 。

### Webpack

TLA 最早于 [Webpack 5](https://webpack.js.org/blog/2020-10-10-webpack-5-release/#async-modules) 中开始支持 ，但需要通过在 Webpack 配置中增加 [experiments.topLevelAwait](https://webpack.js.org/configuration/experiments/#experimentstoplevelawait) 开启：

```ts
module.exports = {
  // ...
  experiments: {
    topLevelAwait: true,
  },
};
```

从 [5.83.0](https://webpack.js.org/configuration/experiments/#experimentstoplevelawait) 开始，Webpack 默认开启了此选项，但如果你只是简单地书写一段 TLA 测试代码在 Webpack 中进行编译：

```ts
await 1;
```

你会发现，你遇到如下编译错误：

```bash {7-9}
> webpack

assets by status 2.3 KiB [cached] 1 asset
./src/index.js 286 bytes [built] [code generated] [1 error]

ERROR in ./src/index.js
Module parse failed: Top-level-await is only supported in EcmaScript Modules
You may need an appropriate loader to handle this file type, currently no loaders are configured to process this file. See https://webpack.js.org/concepts#loaders
Error: Top-level-await is only supported in EcmaScript Modules
    at ./node_modules/webpack/lib/dependencies/HarmonyDetectionParserPlugin.js:72:11
    at Hook.eval [as call] (eval at create (./node_modules/tapable/lib/HookCodeFactory.js:19:10), <anonymous>:7:16)
    at Hook.CALL_DELEGATE [as _call] (./node_modules/tapable/lib/Hook.js:14:14)
    at JavascriptParser.walkAwaitExpression (./node_modules/webpack/lib/javascript/JavascriptParser.js:2807:29)
    at JavascriptParser.walkExpression (./node_modules/webpack/lib/javascript/JavascriptParser.js:2734:10)
    at JavascriptParser.walkExpressionStatement (./node_modules/webpack/lib/javascript/JavascriptParser.js:1903:8)
    at JavascriptParser.walkStatement (./node_modules/webpack/lib/javascript/JavascriptParser.js:1821:10)
    at JavascriptParser.walkStatements (./node_modules/webpack/lib/javascript/JavascriptParser.js:1702:9)
    at JavascriptParser.parse (./node_modules/webpack/lib/javascript/JavascriptParser.js:3995:9)
    at ./node_modules/webpack/lib/NormalModule.js:1093:26

webpack 5.88.2 compiled with 1 error in 120 ms
```

通过搜寻相关 Issue ([webpack/#15869 · Top Level await parsing failes](https://github.com/webpack/webpack/issues/15869))，我们可以看到，Webpack 默认情况下，会认为那些没有 import / export 的模块是 CommonJS 模块，这一逻辑的实现位于 `lib/dependencies/HarmonyDetectionParserPlugin.js​`:

```ts {4-12,28-32}
parser.hooks.program.tap("HarmonyDetectionParserPlugin", (ast) => {
  const isStrictHarmony =
    parser.state.module.type === JAVASCRIPT_MODULE_TYPE_ESM;
  const isHarmony =
    isStrictHarmony ||
    ast.body.some(
      (statement) =>
        statement.type === "ImportDeclaration" ||
        statement.type === "ExportDefaultDeclaration" ||
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportAllDeclaration"
    );
  if (isHarmony) {
    // ...
    HarmonyExports.enable(parser.state, isStrictHarmony);
    parser.scope.isStrict = true;
    // ...
  }
});

parser.hooks.topLevelAwait.tap("HarmonyDetectionParserPlugin", () => {
  const module = parser.state.module;
  if (!this.topLevelAwait) {
    throw new Error(
      "The top-level-await experiment is not enabled (set experiments.topLevelAwait: true to enabled it)"
    );
  }
  if (!HarmonyExports.isEnabled(parser.state)) {
    throw new Error("Top-level-await is only supported in EcmaScript Modules");
  }
  /** @type {BuildMeta} */
  module.buildMeta.async = true;
});
```

综上，在 Webpack 中，成功编译 TLA 的条件如下：​

1. 保证 [experiments.topLevelAwait](https://webpack.js.org/configuration/experiments/#experimentstoplevelawait) 为 `true`；

2. 确保使用了 TLA 的 module 存在 `export`，能够被识别为一个 ES Module （HarmonyModules）​

对于 Webpack 处理 TLA 的 Runtime 流程可以移步 [Webpack TLA Runtime](#webpack-tla-runtime) 一节。

### bun

[bun build](https://bun.sh/docs/bundler#format) 目前只支持 esm，也就是说，bun 也会原封不动的将 TLA 编译到产物中去，同样也没有考虑兼容性，只考虑了现代浏览器的运行：

<p align="center">
  <img width="600" src="https://github.com/ulivz/tla-website/blob/master/docs/public/bun.png?raw=true" />
</p>

## Profiling

这一节中，我们会首先讲述如何运行各类工具链的产物，接着结合 Profiling 来讲述运行情况。

### In Node.js

首先，依赖了 TLA 的 module 必然是一个 ES module，如果我们使用 Node.js 来运行，那么就会遇到使用 Node.js 执行 TLA 的各种问题。考虑到 tsc 场景的产物是多个 ES module 模块，而不是单个 ES module，场景最为复杂。因此本节将使用 Node.js 执行 tsc 中生成的产物来进行讲述。

#### Question: `.mjs` or `type: module`?

直接运行 node esm/a.js 来运行 [Toolchain Support > tsc](xxxn/docx/NhjXdniyao9W5axA1VRcZcpRnJe#TFEWdT99tokanmx6nA2c0M6CnUf) 中生成的产物，会依次遇到如下问题：

```bash
(node:76392) Warning: To load an ES module, set "type": "module" in the package.json or use the .mjs extension.
```

根据 [https://nodejs.org/api/esm.html#enabling](https://nodejs.org/api/esm.html#enabling:)[:](https://nodejs.org/api/esm.html#enabling:)：

> Node.js has two module systems: CommonJS modules and ECMAScript modules.
> **Authors can tell Node.js to use the ECMAScript modules loader via the .mjs file extension, the package.json "type" field, or the --input-type flag**. Outside of those cases, Node.js will use the CommonJS module loader.

我们，这里没有选择修改产物为 `.mjs`，选择了在 `package.json` 中增加 `"type": "module"`：

```json {3}
{
  "name": "tsc-top-level-import",
  "type": "module"
}
```

#### Question: missing `.js` extension in `tsc` out code

解决了上一个问题后，我们又遇到下述问题：

```bash
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/esm/b' imported from /esm/a.js
  code: 'ERR_MODULE_NOT_FOUND'
```

根据 [https://nodejs.org/api/esm.html#import-specifiers](https://nodejs.org/api/esm.html#import-specifiers):​

> Relative specifiers like `'./startup.js'` or `'../config.mjs'`. They refer to a path relative to the location of the importing file. **The file extension is always necessary for these.​**

也就是说，Node.js 里加载 ES Module 必须带上 extension，但是 tsc 的产物默认没有 `.js` extension。根据 [TypeScript 文档](https://www.typescriptlang.org/docs/handbook/modules/reference.html#node16-nodenext)所述，进行如下修改：​

1. 将 `compilerOptions.module` 修改为 `NodeNext`，这是另一个很长很长的故事，这里不再展开；​
2. 将所有的 `import "./foo"` 修改为 `import "./foo.js"`；

> js extension 的问题还有一个解法，就是在 node 执行时带上 `--experimental-specifier-resolution=node`，但这一 Flag 在最新的 Node.js 20 中已经从文档中被移除，不建议使用。
> ​
> 最终，上述代码能够成功运行，最终修复的 Commit 见[这里](https://github.com/ulivz/tsc-top-level-import/commit/e2fbf6957ab8524f9984e0a51c75ac03932ce32b)。

#### Performance

使用 `time node esm/a.js` 运行的输入如下:

```
Hello TLA (b) TLA (c)
node esm/a.js  0.03s user 0.01s system 4% cpu 1.047 total
```

可以看到，整个程序只用了 `1.047s` 来运行，这意味着 `b.js（sleep 1000ms）` 和 `c.js （sleep 500ms）` 的执行是并发的。

### In Chrome

Chrome 从 89 开始支持 TLA，你可以像本文[开头](#compatibility)一样快速去运行一段 TLA 示例代码，但为了测试包含如同示例中 “互相引用” 的原生行为，我们决定像上一节一样，在浏览器中运行 [Toolchain Support > tsc](#typescript-tsc) 中生成的产物。首先，创建一个 `.html`：

```html {9}
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Document</title>
  </head>
  <body>
    <script type="module" src="./esm/a.js"></script>
  </body>
</html>
```

为了更好的观测运行行为，我们在代码中使用 `console.time` 来进行了打点，可以看到运行时序如下：

<p align="center">
  <img width="600" src="/tracing-chrome-tsc.png" />
</p>

可以看到，**`b.js` 与 `c.js` 的 load 与 execution 都是并发的！**

### Result

如不考虑资源加载耗时， `b.js（sleep 1000ms）` 和 `c.js （sleep 500ms）` 串行的执行耗时是 `1.5s`，并行执行的耗时是 `1s`。基于前面的测试技巧，我们对以下几种场景的产物进行了测试，得到报告如下：

| Toolchain        | Environment | Timing                                                           | Summary                 |
| ---------------- | ----------- | ---------------------------------------------------------------- | ----------------------- |
| `tsc`            | Node.js     | node esm/a.js 0.03s user 0.01s system 4% cpu **1.047 total**     | b、c 的执行是**并行**的 |
| `tsc`            | Chrome      | ![](/tracing-chrome-tsc.png)                                     | b、c 的执行是**并行**的 |
| `es bundle`      | Node.js     | node out.js 0.03s user 0.01s system 2% cpu **1.546 total**       | b、c 的执行是**串行**的 |
| `es bundle`      | Chrome      | ![](/tracing-chrome-esbundle.png)                                | b、c 的执行是**串行**的 |
| `Webpack (iife)` | Chrome      | node dist/main.js 0.03s user 0.01s system 3% cpu **1.034 total** | b、c 的执行是**并行**的 |
| `Webpack (iife)` | Chrome      | ![](/tracing-chrome-webpack.png)                                 | b、c 的执行是**并行**的 |

总结一下，虽然 Rollup / esbuild / bun 等工具可以将包含 TLA 的模块成功编译成 es bundle，但是其语义是不符合原生的 TLA 语义的，会导致原本可以**并行**执行的模块变成了**同步**执行。只有 Webpack 通过编译到 iife，再加上复杂的 [Webpack TLA Runtime](#webpack-tla-runtime)，来模拟了符合 TLA 原生的语义，也就是说，在打包这件事上，Webpack 看起来是唯一一个能够正确模拟 TLA 语义的 Bundler。

### TLA Fuzzer

在上一节中，我们通过比较初级的方式来验证了各种工具链对 TLA 语义的支持情况。实际上，[@evanw](https://github.com/evanw) 此前为了测试 TLA 的语义正确性，开放了一个仓库 [tla-fuzzer](https://github.com/evanw/tla-fuzzer)，来测试各种打包器对 TLA 预期的正确性，也进一步验证了我们的结论：

<p align="center">
  <img width="600" src="/tla-fuzzer.png" />
</p>

有兴趣的同学可以研究 fuzzer 的实现，这里不再展开。

## Webpack TLA Runtime

由于只有 Webpack 正确地处理了 TLA 打包后的语义，本节将对 Webpack 的 TLA Runtime 进行分析。

### 基本例子

首先，我们回顾一下，在 Entry 没有任何 Dependency 的场景下，Webpack 的构建产物会相当简单：

**Input**

```js
function component() {
  const element = document.createElement("div");
  element.innerHTML = "Hello, Webpack!";
  return element;
}

document.body.appendChild(component());
```

**Output**

```js
/******/ (() => { // webpackBootstrap
var __webpack_exports__ = {};
function component() {
  const element = document.createElement("div");
  element.innerHTML = "Hello, Webpack!";
  return element;
}

document.body.appendChild(component());

/******/ })()
;
```

当我们使用了 Top-level await：

**Input:**

```js
// component.js
await 1000;

export function component() {
  const element = document.createElement("div");
  element.innerHTML = "Hello, Webpack!";
  return element;
}
```

```js
// index.js
import { component } from './component';
document.body.appendChild(component());
```

**Output**

<!-- Update Link -->

由于篇幅有限，产物太长，这里将 Output 进行了 external，请移步 [TLA Output](https://bytedance.feishu.cn/wiki/Ti2jwLM7ciW6bqk20rYcgXDOnzh)。

可以看到使用了 Top-level await 后**构建产物会变得较为复杂**，后续会进一步分析 **：**



Webpack 的编译产物看起来就是在 Bundler 层面，把 JS Runtime 原本该做的事情 Polyfill 了一遍！



### 整体流程

  


整体上来说，会以 **Entry** 为入口，通过 **`__webpack_require__()`** 执行 **Entry** 模块，接着，首先会通过 **`__webpack_handle_async_dependencies__()`** 加载依赖，依赖的加载和 **Entry** 是完全一样的，依赖若存在依赖，也需要首先加载自身的依赖，依赖加载结束后，获取到依赖的 exports 方能执行当前 Module，执行结束后，会调用 **`__webpack_async_result__()`** 进行回调，让被依赖的模块继续向前执行：

这里运行时的本质和依赖关系完全一致，**首先依赖开始加载本身是同步的**，最末端的依赖加载结束后，返回 `exports` 给上层依赖，上层依赖也才能开始执行，继续向上返回 exports，最终当 Entry 的所有依赖加载结束后，entry 本身的代码开始执行：

暂时无法在飞书文档外展示此内容

暂时无法在飞书文档外展示此内容

  


可以看到，在没有 TLA 之前，这一流程会相当简单，就是一个同步的 DFS，但是一旦 Dep 的加载是异步的，那么这里就是一个异步加载的 DFS，涉及到复杂的异步任务处理。接下来，我们将详细讲述 Webpack TLA Runtime 的运行流程。

  


### 基本概念

#### 模块依赖关系

本例子中，会对一个最小的 Example 进行分析，为了便于描述，我们明确一些基本概念，并给本例子中的模块起一个别名：

暂时无法在飞书文档外展示此内容

| 文件           | 使用了 TLA？ | 别名      | 备注                                                                                |
| -------------- | ------------ | --------- | ----------------------------------------------------------------------------------- |
| `index.js`     | No           | **Entry** | `index.js` 是 `component.js` 的 Dependent`component.js` 是 `index.js` 的 Dependency |
| `component.js` | No           | **Dep**   |                                                                                     |

  


#### Webpack Runtime Globals

在 [Syntax Checker errors introduced by TLA](https://bytedance.feishu.cn/wiki/G1IqwZtiGirVWWkq2PpcWCArntc) 中，我们也提到了，Webpack Compile 在 Seal 阶段，会基于 Chunk 中的 `runtimeRequirements` 信息，使用 Template 拼接生成最终的结果代码，其中，Template 会依赖一些全局变量，在 Webpack 中，这些变量定义在 `lib/RuntimeGlobals.js` 中:

```
/**
 * the internal require function
 */
exports.require = "__webpack_require__";

// ....

/**
 * Creates an async module. The body function must be a async function.
 * "module.exports" will be decorated with an AsyncModulePromise.
 * The body function will be called.
 * To handle async dependencies correctly do this: "([a, b, c] = await handleDependencies([a, b, c]));".
 * If "hasAwaitAfterDependencies" is truthy, "handleDependencies()" must be called at the end of the body function.
 * Signature: function(
 * module: Module,
 * body: (handleDependencies: (deps: AsyncModulePromise[]) => Promise<any[]> & () => void,
 * hasAwaitAfterDependencies?: boolean
 * ) => void
 */
exports.asyncModule = "__webpack_require__.a";
```

  


  


### 主要流程

#### 加载入口

执行的入口如下：

```
var __webpack_exports__ = __webpack_require__(138);  // 138 是 index.js 的 moduleId
```

`__webpack_require__` 定义如下：

```
  // lib/javascript/JavascriptModulesPlugin.js
  // 这一段代码也是按需引入的

  // The module cache
  var __webpack_module_cache__ = {};

  // The require function
  function __webpack_require__ (moduleId) {
    // 模块只会被 require 一次，也就是说，一个异步模块即使被多次依赖，其异步行为只会执行一次
    var cachedModule = __webpack_module_cache__[moduleId]; 
    if (cachedModule !== undefined) {
      return cachedModule.exports;
    }
    // Create a new module (and put it into the cache)
    var module = (__webpack_module_cache__[moduleId] = {
      // no module.id needed
      // no module.loaded needed
      exports: {},
    });

    // 执行模块函数
    __webpack_modules__[moduleId](module, module.exports, __webpack_require__); 

    // 返回模块的 exports
    return module.exports; 
  }
```

可以看到：

  


1.  `__webpack_require__` 是完全同步的过程；
1.  Async Dependency 的加载发生在 Module 的加载执行阶段；

  


#### 入口的执行

```
    138: (  // index.js
      module,
      __unused_webpack___webpack_exports__,
      __webpack_require__
    ) => {
      __webpack_require__.a(
        module,
        async (
          __webpack_handle_async_dependencies__,
          __webpack_async_result__
        ) => {
          try {
            // 395 则是上述 component 模块
            /* harmony import */ var _component__WEBPACK_IMPORTED_MODULE_0__ =
              __webpack_require__(395);
            var __webpack_async_dependencies__ =
              __webpack_handle_async_dependencies__([
                _component__WEBPACK_IMPORTED_MODULE_0__,
              ]);
            // 获取异步依赖的 exports
            // 这里考虑了一个异步依赖仍然没有返回 Promise 的情况
            _component__WEBPACK_IMPORTED_MODULE_0__ = (
              __webpack_async_dependencies__.then
                ? (await __webpack_async_dependencies__)()
                : __webpack_async_dependencies__
            )[0];

            // 消费异步依赖的导出
            document.body.appendChild(
              (0, _component__WEBPACK_IMPORTED_MODULE_0__ /* .component */.w)()
            );

            __webpack_async_result__();
          } catch (e) {
            __webpack_async_result__(e);
          }
        }
      );
    },
  };
```

可以看到：

  


1.  由于 Entry 依赖了使用 TLA 的 Dep，Entry 也会被定义为异步模块，这里使用了 `__webpack_require__.a`来定义异步模块。
1.  TLA 具有传染性，依赖 TLA 的模块也会被识别为 Async Module，即使它本身没有 TLA；

  


因此，核心的依赖如下：

  


1.  **`__webpack_require__.a`**：定义 Async Module；
1.  **`__webpack_handle_async_dependencies__`** ：加载异步依赖；
1.  **`__webpack_async_result__`** 的作用：Async Module 加载结束的回调；

  


  


  


  


  


  


#### Async Module（ **`__webpack_require__.a`** ）

```
 __webpack_require__. a = ( module , body, hasAwait ) => {
      // 闭包准备阶段
      var queue;
      hasAwait && ((queue = []).d = -1);
      var depQueues = new Set();
      var exports = module.exports;
      var currentDeps;
      var outerResolve;
      var reject;
      // 用于控制模块的异步加载流程
      var promise = new Promise((resolve, rej) => {
        reject = rej;
        outerResolve = resolve;
      });
      promise[webpackExports] = exports;
       // fn (fnQueue) 是 Entry 传入的，因此 Dep 的 queue 会被传递给 Entry
      promise[webpackQueues] = (fn) => (
         // Dep 的 queue 传递给 Entry 的 fn (fnQueue) 执行
        queue && fn(queue), 
         // Dep 的 depQueues 传递给 Entry 的 fn (fnQueue) 执行
        depQueues.forEach(fn), 
        promise["catch"]((x) => {})
      );
      module.exports = promise;
      
      // 执行 Module 的 Body
      body(
        // 即 __webpack_handle_async_dependencies__
        (deps) => {
          currentDeps = wrapDeps(deps);
          var fn;
          var getResult = () =>
            currentDeps.map((d) => {
              if (d[webpackError]) throw d[webpackError];
              return d[webpackExports];
            });
            
          var promise = new Promise((resolve) => {
            fn = () => resolve(getResult);
            // 初始值为 0，如果存在依赖，那么在 promise 初始化结束后，
            // fn.r 本质表达了 “正在加载中的 Dep 的数量”
            fn.r = 0;
            var fnQueue = (q) => {
              // q 是 Dep 传入的
              return (
                // q !== queue，即在非 “自循环引用” 的场景下
                // 会将 Dep 的 queue 保存到 Entry 的 depQueues 中
                q !== queue &&
                !depQueues.has(q) &&
                (
                    depQueues.add(q),
                    // q.d 为 -1/0 时，意味着 queue 没有加载结束
                    // 此时会将 fn.r 自增 1，意味多一个依赖
                    // 最终用于在模块执行结束时 resolveQueue 时使用
                    q && !q.d && (
                        fn.r++,
                        // Dep 的 queue 中会持有控制 Entry 中加载依赖
                        // 的 Promise 是否 resolve 的函数
                        q.push(fn)
                    )
                 )
              );
            };

            // 将 fnQueue 传入所有 Dep 的 webpackQueues 方法
            // 这里的本质是建立 Entry 到所有 Dep 的联系
            // - Entry <— Dep：标记依赖数量（fn.r）
            // - Entry —> Dep：将加载 async module 的 promise 的
            // resolve 权转移到 Dep 上去
            currentDeps.map((dep) => dep[webpackQueues](fnQueue));
          });
          
          return fn.r ? promise : getResult();
        },
        // 即 __webpack_async_result__，模块 body 执行完后触发
        (err) => (
          err ? reject((promise[webpackError] = err)) : outerResolve(exports),
          resolveQueue(queue)
        )
      );
      queue && queue.d < 0 && (queue.d = 0);
    };
```

***Closure Variables***

  


在 **`__webpack_require__.a`** ****被执行时，首先定义了如下几个变量：

| 变量              | 类型      | 作用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ***`queue`***     | `array`   | 当当前模块存在 `await` 时，***`queue`*** 会被初始化为 `[d: -1]`，因此本例子中 **Dep** 会存在 ***`queue`***，**Entry** 不会存在。有关 **queue 的** **状态机** **详见** **[后文](https://bytedance.feishu.cn/docx/NhjXdniyao9W5axA1VRcZcpRnJe#PyuVdTg9toYZoHxCTEzcecghn4d)** **。**                                                                                                                                                                                                      |
| ***`depQueues`*** | `Set`     | 用于存储 Dependency 的 ***`queue`*** *。*                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ***`promise`***   | `Promise` | 用于控制模块的异步加载流程，并赋值给 ***`module.exports`*** ***，** *并将 resolve / reject 权利转移到外部（PIA Runtime 中的 [Controlled Microtask](https://bytedance.feishu.cn/docx/doxcnYsP1BObi5II59EHoUMWDvf) 亦是如此），用于控制模块加载结束的时机。当 ***`promise`*** 被 resolve 后，上层模块将能获取到当前 module 的 exports，**有关** **`promise`** **的细节详见** **[后文](https://bytedance.feishu.cn/docx/NhjXdniyao9W5axA1VRcZcpRnJe#MsY9dCBQloBJIDxGdbMcOcC9njh)** **。** |

当完成一些基础的定义后，会开始 执行 Module 的 Body（`body()`），并传递：

-   **`__webpack_handle_async_dependencies__`**
-   **`__webpack_async_result__`**

这两个核心方法给 body 函数，注意，body 函数内部的执行是异步的，当 body 函数开始执行后，如果 `queue` 存在（即在 TLA 模块内）且 `queue.d < 0`，那么将 `queue.d` 赋值为 `0`。

  


***`queue`*** *********状态机***

  


-   一个包含 TLA 模块被定义时，`queue.d` 会被赋值为 `-1`
-   当 TLA 模块的 body 执行结束后，`queue.d` 会被赋值为 `0`
-   当 TLA 模块完全加载结束后，`resolveQueue` 方法中会将 `queue.d` 赋值为 `1`

  


  


***`promise`***

  


上述 ***`promise`*** 上还挂载了 2 个额外的变量需要提及：

| **`[webpackExports]`**                                                                                                                                                                                                                       | 反向引用了 `module.exports` *，* 因此 ****Entry** 可以通过 `promise` 来获取到 **Dep** 的 exports。 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **`[webpackQueues]`**                                                                                                                                                                                                                        | 1.  **Entry** 和 **Dep** 会互相持有彼此的状态；                                                    |
| 1.  在 **Entry** 加载依赖（此处是 **[** **Dep** **]** ）时，会传递一个 resolve 函数给 **Dep**，当 **Dep** 完全加载结束时，会调用 **Entry** 的 resolve 函数，将 Dep 的 `exports` 传递给 **Entry**，此时，**Entry** 的 **body** 才能开始执行。 |

  


***`resolveQueue`***

  


**`resolveQueue`** **绝对是这段 Runtime 中的精华之一**，在模块的 body 执行完，会调用 `resolveQueue` 函数，实现如下：

```
var resolveQueue = (queue) => {
  // queue.d 的检测，用于确认 resolveQueue 没有被调用过
  // 如果 queue.d = 1，那么意味着这个 queue 已经被 resolve 结束
  if (queue && queue.d < 1) {
    queue.d = 1;
    // fn.r 首先自减 1，标记 “仍在加载中的依赖” 少了一个
    queue.forEach((fn) => fn.r--);
    // 注意，queue 中存放的 fn，是 Dep 持有的通知 Entry 异步依赖加载完成的函数
    // 也就是 resolve 掉 __webpack_handle_async_dependencies__ 返回的 Promise
    // 如果 fn.r > 0，那么意味着还有没有加载完成的 Dep
    // 此时不能通知 Entry，因此通过 fn.r++ Revert 掉这一步的更改
    // 如果 fn.r 等于 0，那么意味着所有的 Dep 均已被加载，此时可以通知 Entry 了！
    queue.forEach((fn) => (fn.r-- ? fn.r++ : fn()));
  }
};
```

  


### 复杂例子

暂时无法在飞书文档外展示此内容

若左图依赖关系所示，其中 d、b 两个模块是包含了 TLA 的模块，那么：

1.  a、c 会由于 TLA 的传染问题同样变成 Async Module；

1.  **Module 开始 Require 的时机：** 即调用 `__webpack_require__` 的时机，这里会基于 import 的顺序进行 DFS，假设 a 中 import 如下所示：

    1.  ```
        import { b } from "./b";
        import { c } from "./c";
        import { sleep } from "./e";
        ```
    1.    那么，Require 的顺序为 `a —> b —> e —> c —> d`

1.  **Module 加载结束的时机：**

    1.  若加载时长 `d > b`，那么Module 加载结束的时机为 `b —> d —> c —> a`
    1.  若加载时长 `d < b`，那么Module 加载结束的时机为 `d —> c —> b —> a`
    1.  这里忽视 Sync Module `a`，因为 `a` 在 Require 的时候就结束了
    1.  在存在 TLA 的模块图中，Entry 一定是一个 Async Module

  


  


### 复杂的根源

如果我们完全阅读 [ECMAScript proposal: Top-level await](https://github.com/tc39/proposal-top-level-await)，我们可以看到一个更简单的例子来描述这一行为：

```
import { a } from './a.mjs';
import { b } from './b.mjs';
import { c } from './c.mjs';

console.log(a, b, c);
```

```
import { promise as aPromise, a } from "./a.mjs";
import { promise as bPromise, b } from "./b.mjs";
import { promise as cPromise, c } from "./c.mjs";

export const promise = Promise.all([
    aPromise, 
    bPromise, 
    cPromise
]).then(() => {
  console.log(a, b, c);
});
```

在 Bundler 层面支持 TLA 编译到 iife 而不是 es 的复杂度主要来源于：我们需要合并所有模块到一个文件，还要保持上述语义。

  


### 现在能用 TLA 吗？

在聊这个问题之前，我们先通过 Webpack 的整体流程，来复习上述的 Runtime 是在哪个阶段被生成的。我们可以参考@王令宇 此前对 Webpack 构建流程的剖析文档 [Webpack 构建流程剖析](https://bytedance.feishu.cn/docx/LQkcdMudlorPmNxjT1Oc9HhAnbI)，一次 `Compiler.compile` 的流程主要如下：

  


> -   `newCompilationParams`：创建Compilation实例参数，核心功能是初始化用于在后续的构建流程中创建模块实例的工厂方法`ModuleFactory`
> -   `newCompilation`：真正创建Compilation实例，并挂载一些编译文件信息
> -   `compiler.hooks.make`：**执行真正的模块编译流程**，这个部分会对入口和模块进行构建，运行loader、解析依赖、递归构建等等；
> -   `compilation.finish`：模块构建的收尾阶段，主要是对模块间依赖关系和一些依赖元数据做进一步的整理，为后续代码拼接做好准备
> -   `compilation.seal`：模块冻结，开始拼接模块生成chunk和chunkGroup，生成产物代码，这个后面会专门开章节介绍

  


而上一节中的 Runtime，则发生在 **Seal** 阶段。由于 **Seal** 已经是模块编译的最后环节，不可能在经历 **Make** 阶段（不会运行 Loader），因此此处拼接的模板代码必须要考虑兼容性。实际上也是如此，Webpack 内部的 Template 均是会考虑兼容性的，如：

```
 // lib/dependencies/HarmonyExportImportedSpecifierDependency.js

const modern = runtimeTemplate.supportsConst() && runtimeTemplate.supportsArrowFunction();
// ...
if (modern) {
    content += `() => ${importVar}[__WEBPACK_IMPORT_KEY__]`;
} else {
    content += `function(key) { return ${importVar}[key]; }.bind(0, __WEBPACK_IMPORT_KEY__)`;
}
```

```
 // lib/RuntimeTemplate.js

returningFunction(returnValue, args = "") {
    return this.supportsArrowFunction()
        ? `(${args}) => (${returnValue})`
        : `function(${args}) { return ${returnValue}; }`;
}

basicFunction(args, body) {
    return this.supportsArrowFunction()
        ? `(${args}) => {\n${Template.indent(body)}\n}`
        : `function(${args}) {\n${Template.indent(body)}\n}`;
}
```

  


当我们修改 `target` 在 `es5` 或 `es6` 之间切换，你会看到产物有明显的变化：

  


左侧 `target: ['web', 'es6']`；右侧 `target: ['web', 'es5']`

![](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/655a93096c90442f9f4050d082604c42~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=2774&h=1770&s=857364&e=png&b=232222)![](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/92cb50ff488d48ca926050fd1475fa54~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1980&h=1046&s=275006&e=png&a=1&b=fdfcfc)

但是偏偏，Top-level await 没有遵守这一原则（感谢@杨健 提供这个 MR）：

https://github.com/webpack/webpack/pull/12529

可以看到，Alex 曾经对 Template 中的 ` async  `` /  ``await` 的兼容性提出过质疑，但是 Tobias 以非常 difficult 去修复进行了回应：

因此这一实现一直被保留在了 Webpack 中，**TLA 也成为会导致 Runtime Template 带来兼容性问题的少数派特性**。

  


实际上，这里也可以理解，如果 Template 中依赖了 ` async  `` /  ``await`，那么如果要考虑兼容性，那么要考虑引入 [regenerator-runtime](https://www.npmjs.com/package/regenerator-runtime) 或者类似 tsc 中更优雅的基于状态机的实现（See: [TypeScript#1664](https://github.com/microsoft/TypeScript/issues/1664)），Web Infra 曾经的一个实习生也尝试实现过（See: [babel-plugin-lite-regenerator](https://github.com/konicyQWQ/babel-plugin-lite-regenerator)）：

  


也就是说，Webpack 对 TLA 的编译，由于产物中仍然会包含 async await，这导致了只能在 iOS11 / Chrome 55 的机器上跑：

| [Top-level await](https://caniuse.com/?search=Top%20level%20await)'s Compatibility                                                                                                   | Expected Compatibility（Compiled to [ES5](https://caniuse.com/?search=ES5)）                                                                                                          | Actual Compatibility（i.e. [async / await](https://caniuse.com/?search=async)） |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| ![](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/69b3be806fbe4529bb6d8186d9052369~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1314&h=716&s=143729&e=png&b=f0e6d1)-   Chrome 89 |
| -   Safari 16                                                                                                                                                                        | ![](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/3d3ef67c38cb46d390237d4e32462a1c~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1308&h=1016&s=200469&e=png&b=f0e6d3)-   Chrome 23 |
| -   Safari 6                                                                                                                                                                         | ![](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/2ac38e40b15445ffbae0b3dfa7421e0d~tplv-k3u1fbpfcp-jj-mark:0:0:0:0:q75.image#?w=1308&h=830&s=166585&e=png&b=f0e6d1)-   Chrome 55  |
| -   Safari 11                                                                                                                                                                        |
|                                                                                                                                                                                      |                                                                                                                                                                                       |                                                                                 |

  


## 总结

1.  TLA 的诞生之初，是为了尝试解决 ES Module 的异步初始化问题；
1.  TLA 属于 es2022 的特性，在 [v14.8.0](https://nodejs.org/en/blog/release/v14.8.0) 以上的版本中可以用，如需在 UI 代码中使用，需要借助 Bundler 打包；除非你会在前端项目中直接使用 [es module](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)，一般来说，你需要打包成 **`iife`**；
1.  大多数 Bundler 都能够在 target format 为 **`esm`** 时成功编译 TLA，**但是只有** **Webpack** **能够支持将 TLA 编译到** **`iife`** **，同时，** **[Webpack 是唯一一个能够正确模拟 TLA 语义的 Bundler](https://bytedance.feishu.cn/docx/NhjXdniyao9W5axA1VRcZcpRnJe#J0YjdFCWSoYP1MxfzuicTzMenJf)** **。**
1.  虽然 Webpack 可以将 TLA 打包成 `iife`，但是由于产物中仍然包含 async await（虽然不是 TLA），这导致了只能在 iOS11 / Chrome 55 的机器上运行，目前，公司内的 C 端业务，要求兼容性设置（即 [Browserslist](https://pia.bytedance.net/cn/guide/compilation/browserslist.html)）为 **iOS 9 / Android 4.4**（部分项目可能能到 iOS 10），因此，出于稳定性考虑，你不应该在 C 端项目中使用 TLA。未来，如果你的业务要求最低兼容性为 iOS 11，那么你可以在你的 Webpack 项目中尝试 TLA；
1.  在 Webpack 实现细节上，和 await 要求在 async function 使用一样具备传染性，TLA 会导致 Dependent 同样被处理为 Async Module，但这对开发者是无感的；

  


## 下一步

看到这里，还是有一些附加问题，值得进一步研究：

1.  JS Runtime 或 JS 虚拟机如何实现 Top-level await；
1.  由 JS Runtime 或 JS 虚拟机原生支持的 TLA，在 Async Module 加载失败时，会发生什么？如何调试？

  


## 写在最后

  


Rollup 作者 [Rich Harris](https://github.com/Rich-Harris) 在此前一篇 Gist **[Top-level await is a footgun 👣🔫](https://gist.github.com/Rich-Harris/0b6f317657f5167663b493c722647221#top-level-await-is-a-footgun-)** ****提到：

  


> At first, my reaction was that it's such a self-evidently bad idea that I must have just misunderstood something. But I'm no longer sure that's the case, so I'm sticking my oar in: **Top-level** **`await`** **, as far as I can tell, is a mistake and it should not become part of the language.**
>
> 起初，我的反应是，这是一个不言而喻的坏主意，我一定是误解了什么。 但我不再确定情况是这样，所以我坚持下去：据我所知，TLA 是一个错误，它不应该成为语言的一部分。

  


但后来，他又提到：

  


> TC39 is currently moving forward with a slightly different version of TLA, referred to as 'variant B', **in which a module with TLA doesn't block** ***sibling*** **execution**. This vastly reduces the danger of parallelizable work happening in serial and thereby delaying startup, which was the concern that motivated me to write this gist
>
> TC39 目前正在推进 TLA 的一个略有不同的版本，称为“变体 B”，其中 “**具有 TLA 的模块不会阻止同级执行”， 这极大地降低了并行工作串行发生并因此延迟启动的危险**，这正是促使我写下这篇文章的原因。

  


因此，他开始完全支持此提案：

  


> Therefore, a version of TLA that solves the original issue is a valuable addition to the language, and I'm in full support of the current proposal, [which you can read here](https://github.com/tc39/proposal-top-level-await).

  


那么这里我们也可以在 [ECMAScript proposal: Top-level await](https://github.com/tc39/proposal-top-level-await) 关于 TLA 的历史，可以概括如下：

  


-   [2014 年 1 月](https://github.com/tc39/notes/blob/main/meetings/2014-01/jan-30.md#asyncawait)，`async / await proposal` 被提交给委员会；
-   [2014 年 4 月](https://github.com/tc39/tc39-notes/blob/master/meetings/2014-04/apr-10.md#preview-of-asnycawait)，讨论了应该在模块中保留关键字await，以用于 TLA；
-   [2015 年 7 月](https://github.com/tc39/tc39-notes/blob/master/meetings/2015-07/july-30.md#64-advance-async-functions-to-stage-2)， `async / await proposal` 推进到 Stage 2，在这次会议中决定推迟 TLA，以避免阻塞当前提案；很多委员会的人已经开始讨论，主要是为了确保它在语言中仍然是可能的；
-   2018 年 5 月，TLA 提案进入 TC39 流程的第二阶段，许多设计决策（**特别是是否阻止“同级”执行**）在第二阶段进行讨论。

  


你怎么看待 TLA 的未来呢？

  


  


  


*谢谢* *@杨健* *以及其他所有读者在我书写本文中给到的所有输入和建议！*

  


  


## 参考

-   https://github.com/tc39/proposal-top-level-await
-   https://v8.dev/features/top-level-await
-   https://gist.github.com/Rich-Harris/0b6f317657f5167663b493c722647221
-   https://nodejs.org/en/blog/release/v14.8.0
-   https://github.com/evanw/esbuild/issues/253
-   https://github.com/rollup/rollup/issues/3623
-   https://www.typescriptlang.org/docs/handbook/esm-node.html