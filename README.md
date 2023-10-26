![](https://github.com/ulivz/deep-dive-into-tla/blob/master/public/main.png?raw=true)

[![CC0](http://mirrors.creativecommons.org/presskit/buttons/88x31/svg/cc-zero.svg)](https://creativecommons.org/publicdomain/zero/1.0/)

> Participate in discussions: https://github.com/orgs/web-infra-dev/discussions/9

> 中文版本：https://github.com/web-infra-dev/deep-dive-into-tla/blob/master/README-zh-CN.md

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Introduction](#introduction)
- [Specification](#specification)
- [Compatibility](#compatibility)
- [Toolchain Support](#toolchain-support)
  - [Prerequisites](#prerequisites)
  - [TypeScript (tsc)](#typescript-tsc)
  - [esbuild](#esbuild)
  - [Rollup](#rollup)
  - [Webpack](#webpack)
  - [bun](#bun)
- [Profiling](#profiling)
  - [In Node.js](#in-nodejs)
    - [Question: `.mjs` or `type: module`?](#question-mjs-or-type-module)
    - [Question: Missing `.js` extension in `tsc` output code](#question-missing-js-extension-in-tsc-output-code)
    - [Performance](#performance)
  - [In Chrome](#in-chrome)
  - [Result](#result)
  - [TLA Fuzzer](#tla-fuzzer)
- [Webpack TLA Runtime](#webpack-tla-runtime)
  - [Basic Example](#basic-example)
  - [Overall Process](#overall-process)
  - [Basic Concepts](#basic-concepts)
    - [Prerequisites](#prerequisites-1)
    - [The Compilation Process of Webpack](#the-compilation-process-of-webpack)
    - [Webpack Runtime Globals](#webpack-runtime-globals)
  - [Artifact Analysis](#artifact-analysis)
    - [Loading Entry](#loading-entry)
    - [Execution of Entry](#execution-of-entry)
    - [`__webpack_require__.a`](#__webpack_require__a)
      - [`queue`](#queue)
      - [`promise`](#promise)
      - [`resolveQueue`](#resolvequeue)
  - [Complex Example](#complex-example)
  - [Source of Complexity](#source-of-complexity)
- [Can We Use TLA Now?](#can-we-use-tla-now)
- [Summary](#summary)
- [Next Steps](#next-steps)
- [In Conclusion](#in-conclusion)
- [Further Updates](#further-updates)
  - [Rspack officially backs TLA from v0.3.8, verified using Fuzzer.](#rspack-officially-backs-tla-from-v038-verified-using-fuzzer)
- [Refs](#refs)

## Introduction

In ByteDance, users of the Mobile Web Framework we built based on [Rsbuild](https://github.com/web-infra-dev/rsbuild) have encountered issues with the [Syntax Checker](https://rsbuild.dev/config/options/security.html#securitychecksyntax):

```bash {6-7}
error   [Syntax Checker] Find some syntax errors after production build:

  ERROR#1:
  source - /node_modules/pia-app/esm/utils.js:6:7
  output - /pia/example/kit/dist/resource/js/vendor.505d4345.js:1:32501
  reason - Unexpected token (1:32501)
  code   - async(e,r)=>{try{var t=o(326)

Error: [Syntax Checker] The current build fails due to an incompatible syntax...
```

In response to such problems, our first thought is that it might be caused by third-party dependencies. This is because **the builder does not compile `*.js|ts` files under `node_modules` by default for performance reasons<sup>[1]</sup>**. Users may depend on third-party dependencies containing `async/await`, leading to a final compilation error. Consequently, we suggest developers use [source.include](https://rsbuild.dev/config/options/source.html#sourceinclude) to [Downgrade third-party dependencies](https://rsbuild.dev/guide/advanced/browser-compatibility.html#downgrade-third-party-dependencies):

```ts
export default {
  source: {
    include: [/\/node_modules\/query-string\//],
  },
};
```

Interestingly, **this problem is not what we initially imagined**. When we used [Source Map Visualization](https://evanw.github.io/source-map-visualization/) to locate the issue, we found that the position of `async` was white —— **there was no source code mapped to it**:

![](https://github.com/ulivz/deep-dive-into-tla/blob/master/public/source-map-missing.png?raw=true)

Upon further analysis, we discovered that this `async` was introduced by the Webpack compilation [TLA (Top-level await)](https://github.com/tc39/proposal-top-level-await) injected Runtime. Under such circumstances, we continued to investigate TLA.

In this article, we will conduct a more in-depth and comprehensive analysis of TLA's [Specification](specification), [Toolchain Support](#toolchain-support), [Webpack Runtime](#webpack-tla-runtime), [Profiling](#profiling), [Availability]((#现在能用-tla-吗)) and so on.

## Specification

We can learn about the latest standard definition of **TLA** from [ECMAScript proposal: Top-level await](https://github.com/tc39/proposal-top-level-await). The original intention of TLA design comes from `await` being only available within `async function`, which brings the following problems:

1. If a module has an `IIAFE` (_Immediately Invoked Async Function Expression_), it may cause `exports` to be accessed before the initialization of this `IIAFE` is complete, as shown below:
    ```ts {4-6}
    // awaiting.mjs
    let output;
    
    (async () => {
      output = await fetch(url);
    })();
    
    export { output }; // output is consumed before the above IIAFE finishes execution
    ```

2. To solve the problem in 1, we might need to export a Promise for upper stream consumption, but exporting a Promise will obviously require the user to be aware of this type:
    ```ts {4}
    // awaiting.mjs
    let output;
    
    export default (async () => {
      output = fetch(url); // await is removed, output is a promise
    })();
    
    export { output };
    ```

    Then, we can consume like this:
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

    This raises the following issues<sup>[2]</sup>:

    1. Every dependent must understand the protocol of this module to use it correctly;
    2. If you forget this protocol, sometimes the code might work (due to `race` win), and sometimes it won't;
    3. In the case of multi-layer dependencies, Promise needs to run through each module (_"Chain pollution?"_).

  <p align="center">
    <img
      width="200"
      src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/promise.gif?raw=true"
    />
  </p>

For this reason, `Top-level await` is introduced. The way modules are written can be changed to:

```ts
const output = await fetch(url);
export { output };
```

A typical use case is to solve the problem of **"Dynamic dependency pathing"**, which is very useful for scenarios such as **Internationalization and Environment-based Dependency Splitting**:

```ts
const strings = await import(`/i18n/${navigator.language}`);
```

More use cases can be found [here](https://github.com/tc39/proposal-top-level-await#use-cases).

## Compatibility

According to [Can I Use](https://caniuse.com/?search=top%20level%20await), we can use TLA in **Chrome 89** and **Safari 15**, and **Node.js** also officially supports TLA from [v14.8.0](https://nodejs.org/en/blog/release/v14.8.0):

<p align="center">
  <img
    width="600"
    src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/compatibility.png?raw=true"
  />
</p>

You can quickly copy this code into your Chrome Devtools Console panel or Node.js command line for execution:

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
    src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tla-result.png?raw=true"
  />
</p>

This is the effect of native support for TLA. However, since this is a newer ECMAScript feature, it is currently difficult (as of 2023) to use it directly in mobile UI code. If you want to use it in UI code at present, you still need to rely on compilation tools. In the next section, we will introduce the "**compilation behavior**" and "**compatibility of the produced artifacts**" of common toolchains.

## Toolchain Support

### Prerequisites

In order to standardize the benchmark for testing compilation behavior, we agree on the following Minimal Example for testing:

<p align="center">
  <img width="100%" src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/minimal-example.png?raw=true"/>
</p>

<details>
  <summary>Unfold the original code</summary>
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

The minimum repositories for each tooling are available at [TypeScript (tsc)](https://github.com/ulivz/tsc-top-level-import) | [esbuild](https://github.com/ulivz/esbuild-top-level-import) | [Rollup](https://github.com/ulivz/rollup-top-level-import) | [Webpack](https://github.com/ulivz/webpack-top-level-import) There is no example created for `bun` here because `bun` does not need any configuration and can be tested for packaging by running `bun build src/a.ts --outdir ./build --format esm` in any repository.

### TypeScript (tsc)

In [tsc](https://www.typescriptlang.org/docs/handbook/compiler-options.html), TLA can only be successfully compiled when the `module` is `es2022`, `esnext`, `system`, `node16`, `nodenext`, and the `target >= es2017`, otherwise, the following error will occur:

```ts
src/top-level-await.ts:3:1 - error TS1378: Top-level 'await' expressions are only allowed when the 'module' option is set to 'es2022', 'esnext', 'system', 'node16', or 'nodenext', and the 'target' option is set to 'es2017' or higher.

3 await sleep(100);
  ~~~~~
```

After successful compilation, you can see that the output and the source code are almost identical:

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

Since tsc is a transpiler and does not have bundle behavior, no additional Runtime will be introduced for TLA under tsc. In other words, **tsc does not consider the compatibility of TLA**. You can go to the [Profiling](#profiling) section to understand how to run this output.

### esbuild

[esbuild](https://esbuild.github.io/) currently can only successfully compile TLA when `format` is `esm`, and `target >= es2022` (this aligns with `tsc`'s `module` rather than `target`). This means that esbuild itself only handles successful compilation and is not responsible for the compatibility of TLA:

| <img width="500" src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tsc-tla-errpr-1.png?raw=true" /> | <img width="500" src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tsc-tla-errpr-2.png?raw=true" /> |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |

After successful compilation, the products are as follows:

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
As we can see, **the output here directly tiles all the `modules` —— this seems to have changed the original semantics of the code!** This can be confirmed in the [Profiling](#profiling) section.

Regarding TLA support in esbuild, the response from esbuild author [@evanw](https://github.com/evanw) is<sup>[4]</sup>:

> Sorry, top-level await is not supported. It messes with a lot of things and adding support for it is quite complicated. It likely won't be supported for a long time.
> Sorry, TLA is not supported. It affects many things and adding support for it is quite complicated. It may not be supported for a long time.

### Rollup


[Rollup](https://rollupjs.org/) can only successfully compile TLA when `format` is `es` or `system`, otherwise the following error will occur:

![](https://github.com/ulivz/deep-dive-into-tla/blob/master/public/rollup-tla.png?raw=true)

The term `es` here changes the semantics just like `esbuild` does when generating es bundles, which will not be elaborated here. For `system`, by reading the [SystemJS document](https://github.com/systemjs/systemjs/blob/main/docs/system-register.md#format-definition), SystemJS supports modules being defined as an Async Module:

> `execute: AsyncFunction` - If using an asynchronous function for execute, top-level await execution support semantics are provided following [variant B of the specification](https://github.com/tc39/proposal-top-level-await#variant-b-top-level-await-does-not-block-sibling-execution).

Therefore, there will be no special behavior in Rollup, it just wraps TLA in the `execute` function, so Rollup itself does not have more Runtime level processing on TLA. There is an issue<sup>[4]</sup> about Rollup supporting TLA under iife, you can go to https://github.com/rollup/rollup/issues/3623 for more information.

### Webpack

TLA began to be supported in [Webpack 5](https://webpack.js.org/blog/2020-10-10-webpack-5-release/#async-modules) earliest, but it needs to be enabled by adding [experiments.topLevelAwait](https://webpack.js.org/configuration/experiments/#experimentstoplevelawait) in the Webpack configuration:

```ts
module.exports = {
  // ...
  experiments: {
    topLevelAwait: true,
  },
};
```

Starting with [5.83.0](https://webpack.js.org/configuration/experiments/#experimentstoplevelawait), Webpack turns on this option by default. However, if you simply write a piece of TLA test code in Webpack for compilation:

```ts
await 1;
```

You'll find that you encounter the following compilation error:

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

By searching for related Issue ([webpack/#15869 · Top Level await parsing failes](https://github.com/webpack/webpack/issues/15869)), we can see that, under default conditions, Webpack will consider those modules without import / export as CommonJS modules. This logic is implemented in [HarmonyDetectionParserPlugin.js​](https://github.com/webpack/webpack/blob/main/lib/dependencies/HarmonyDetectionParserPlugin.js):

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
In summary, the conditions for successful TLA compilation in Webpack are as follows:

1. Ensure [experiments.topLevelAwait](https://webpack.js.org/configuration/experiments/#experimentstoplevelawait) is set to `true`;
2. Make sure that a module using TLA has an `export` statement and can be recognized as an ES Module (`HarmonyModules`).

For more on how Webpack handles TLA's runtime process, refer to the [Webpack TLA Runtime](#webpack-tla-runtime) section.

### bun

[bun build](https://bun.sh/docs/bundler#format) currently supports esm only, which means that bun will also compile TLA into the generated files without any modifications. It does not consider compatibility and only focuses on running in modern browsers.

<p align="center">
  <img width="600" src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/bun.png?raw=true" />
</p>

## Profiling

In this section, we will first explain how to run products from various toolchains, then discuss their execution behavior in conjunction with profiling.

### In Node.js

Firstly, a module that relies on TLA must be an ES module. If we use Node.js to run it, we will encounter various problems with executing ES modules in Node.js. Considering the output of `tsc` scenarios consists of multiple ES module modules rather than a single one, this case is the most complex. Therefore, this section will use Node.js to execute the products generated by `tsc`.

#### Question: `.mjs` or `type: module`?

If you try to run the product generated by [tsc](#typescript-tsc) directly using the command `node esm/a.js`, you'll encounter the following problem:

```bash
(node:76392) Warning: To load an ES module, set "type": "module" in the package.json or use the .mjs extension.
```

According to [https://nodejs.org/api/esm.html#enabling](https://nodejs.org/api/esm.html#enabling):

> Node.js has two module systems: CommonJS modules and ECMAScript modules.
> **Authors can tell Node.js to use the ECMAScript modules loader via the `.mjs` file extension, the package.json `"type"` field, or the `--input-type` flag**. Outside of those cases, Node.js will use the CommonJS module loader.

Here, we choose not to modify the product to `.mjs`, but to add `"type": "module"` in `package.json`:

```json {3}
{
  "name": "tsc-top-level-import",
  "type": "module"
}
```
#### Question: Missing `.js` extension in `tsc` output code

After solving the previous issue, we encountered the following problem:

```bash
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/esm/b' imported from /esm/a.js
  code: 'ERR_MODULE_NOT_FOUND'
```

According to [https://nodejs.org/api/esm.html#import-specifiers](https://nodejs.org/api/esm.html#import-specifiers):

> Relative specifiers like `'./startup.js'` or `'../config.mjs'`. They refer to a path relative to the location of the importing file. **The file extension is always necessary for these.**

That is to say, when loading ES Module in Node.js, it's necessary to include the extension. However, the output of `tsc` doesn't include the `.js` extension by default. According to [TypeScript documentation](https://www.typescriptlang.org/docs/handbook/modules/reference.html#node16-nodenext) and related guides<sup>[5]</sup>, we made the following modifications:

1. Change `compilerOptions.module` to `NodeNext`. This is another long story, which we won't expand on here.
2. Modify all `import "./foo"` to `import "./foo.js"`.

> There's another solution for the `.js` extension issue: running node with `--experimental-specifier-resolution=node`. But this flag has been removed from the documentation in the latest Node.js 20, hence its use is not recommended.

Finally, the above code can run successfully. The final fix commit can be found [here](https://github.com/ulivz/tsc-top-level-import/commit/e2fbf6957ab8524f9984e0a51c75ac03932ce32b).

#### Performance

The output when running `time node esm/a.js` is as follows:

```
Hello TLA (b) TLA (c)
node esm/a.js  0.03s user 0.01s system 4% cpu 1.047 total
```

As you can see, the entire program only took `1.047s` to run, which means that the execution of `b.js (sleep 1000ms)` and `c.js (sleep 500ms)` is **concurrent**.

### In Chrome

Starting from version 89, Chrome supports TLA. You can quickly run a snippet of TLA example code as demonstrated at the [beginning](#compatibility) of this document. However, to test the native behavior of "mutual references" as shown in the example, we decided to execute the output generated in the browser as in the previous section [`Toolchain Support > tsc`](#typescript-tsc). First, create an `.html` file:

```html {9}
<!DOCTYPE html>
<html lang="en">
  <head></head>
  <body>
    <script type="module" src="./esm/a.js"></script>
  </body>
</html>
```

In order to better observe the runtime behavior, we have used `console.time` for marking in the code, and you can see the runtime sequence as follows:

<p align="center">
  <img width="600" src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tracing-chrome-tsc.png?raw=true" />
</p>

As you can see, **the load and execution of `b.js` and `c.js` are concurrent!**

### Result

Ignoring the time consumed by resource loading, the synchronous execution time of `b.js (sleep 1000ms)` and `c.js (sleep 500ms)` is `1.5s`, while the parallel execution time is `1s`. Based on the previous testing techniques, we tested the products of several scenarios and the report is as follows:

| Toolchain        | Environment | Timing                                                                                                   | Summary                 |
| ---------------- | ----------- | -------------------------------------------------------------------------------------------------------- | ----------------------- |
| `tsc`            | Node.js     | node esm/a.js 0.03s user 0.01s system 4% cpu **1.047 total**                                             | Execution of b and c is **concurrent** |
| `tsc`            | Chrome      | ![](https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tracing-chrome-tsc.png?raw=true)      | Execution of b and c is **concurrent** |
| `es bundle`      | Node.js     | node out.js 0.03s user 0.01s system 2% cpu **1.546 total**                                               | Execution of b and c is **synchronous** |
| `es bundle`      | Chrome      | ![](https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tracing-chrome-esbundle.png?raw=true) | Execution of b and c is **synchronous** |
| `Webpack (iife)` | Chrome      | node dist/main.js 0.03s user 0.01s system 3% cpu **1.034 total**                                         | Execution of b and c is **concurrent** |
| `Webpack (iife)` | Chrome      | ![](https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tracing-chrome-webpack.png?raw=true)  | Execution of b and c is **concurrent** |

To sum up, although tools like Rollup/esbuild/bun can successfully compile modules containing TLA into es bundle, their semantics do not comply with the semantics of TLA specification. The existing simple packaging methods will turn the originally **concurrent execution** module into **synchronous execution**. Only Webpack simulates the semantics of TLA by compiling to iife and then adding the complex [Webpack TLA Runtime](#webpack-tla-runtime), which means that in terms of packaging, Webpack appears to be the only Bundler that can correctly simulate TLA semantics.

### TLA Fuzzer

In the previous section, we verified the support for TLA semantics from various toolchains in a relatively primary way. In fact, [@evanw](https://github.com/evanw), the author of esbuild, created a repository [tla-fuzzer](https://github.com/evanw/tla-fuzzer) to test the correctness of TLA semantics for various packagers, which further validates our conclusion:

<p align="center">
  <img width="600" src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tla-fuzzer.png?raw=true" />
</p>

Fuzzing is done by randomly generating module graphs and comparing the evaluation order of the bundled code with V8<sup>[6]</sup>'s native module evaluation order.<sup>[7]</sup>。


## Webpack TLA Runtime

As only Webpack handles the semantics of TLA packaging correctly, this section will analyze Webpack's TLA Runtime.

### Basic Example

First, we recall that in case of an Entry without any Dependency, the build product of Webpack will be quite simple:

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

When we use Top-level await：

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

Due to space limitations and the lengthy output, you can visit [TLA Output](https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tla-output.js) as the output has been externalized. As we can see, using TLA will **make the build product more complex**, further analysis will follow.

**Here we can boldly guess that the compiled product of Webpack looks like a Polyfill of the original JS Runtime at the Bundler level.**

### Overall Process

<p align="center">
  <img width="300" src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/whole-process.png?raw=true" />
</p>

Overall, the process starts with **Entry** as the entry point, executes the **Entry** module through **`__webpack_require__()`**, then loads dependencies through **`__webpack_handle_async_dependencies__()`**. The loading of dependencies is exactly the same as that of **Entry**. If a dependency has its own dependencies, these need to be loaded first. After the dependencies are loaded and their exports are obtained, the current Module can be executed. After execution, **`__webpack_async_result__()`** will be called for callback, allowing the dependent modules to continue execution.

The essence of runtime here is completely consistent with the dependency relationship, **the initial loading of dependencies is synchronous**. When the loading of the end dependencies is finished, it returns `exports` to the upper layer dependencies. Only then can the upper layer dependencies start executing, continue to return exports upwards, and eventually when all dependencies of Entry are loaded, the code of entry itself begins to execute:

<p align="center">
  <img width="400" src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/whole-process-2.png?raw=true" />
</p>
As you can see, without TLA, the process would be quite simple, just a synchronous DFS. However, once the loading of Dep is asynchronous, it becomes an asynchronous DFS, involving complex asynchronous task processing. Next, we will detail the operation process of Webpack TLA Runtime.

### Basic Concepts

#### Prerequisites

In order to explain the running process of Webpack TLA Runtime, we have re-created a smaller Example for analysis:

<p align="center">
  <img width="300" src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/minimal-example-2.png?raw=true" />
</p>

Let's clarify some basic concepts and give aliases to the modules in this example:

| File           | Uses TLA?   | Alias      | Notes                                                                                           |
| -------------- | ----------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `index.js`     | No          | **Entry**  | `index.js` is a **Dependent** of `component.js`; `component.js` is a **Dependency** of `index.js` |
| `component.js` | Yes         | **Dep**    |                                                                                                |


#### The Compilation Process of Webpack

In order to better understand the internal principles of TLA, we also need to briefly understand the main compilation process of a single Webpack:

- `newCompilationParams`: Create `Compilation` instance parameters, the core function is to initialize the factory method `ModuleFactory` used to create module instances in subsequent build processes;
- `newCompilation`: Truly create a `Compilation` instance and mount some compiled file information;
- `compiler.hooks.make`: **Execute the real module compilation process (Make)**, this part will build entries and modules, run `loader`, parse dependencies, recursive build, etc.;
- `compilation.finish`: The final stage of module construction, mainly for further sorting of the inter-module dependency relationship and some dependency metadata, to prepare for subsequent code stitching;
- `compilation.seal`: **Module freezing stage (Seal)**, start to stitch modules to generate `chunk` and `chunkGroup`, to generate product code.

#### Webpack Runtime Globals

During the `Seal` phase, final resulting code is generated by concatenating templates based on the `runtimeRequirements` information in Chunk. These templates rely on certain global variables which are defined in [lib/RuntimeGlobals.js](https://github.com/webpack/webpack/blob/main/lib/RuntimeGlobals.js) in Webpack:

```js
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

### Artifact Analysis

Next, let's start analyzing the previously generated [artifact](https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tla-output.js).

#### Loading Entry

Firstly, the executed entry point is as follows:

```js
var __webpack_exports__ = __webpack_require__(138);  // 138 is the moduleId of index.js
```

`__webpack_require__` is defined as follows:

```js
  // lib/javascript/JavascriptModulesPlugin.js
  // This block of code is also imported as needed

  // The module cache
  var __webpack_module_cache__ = {};

  // The require function
  function __webpack_require__ (moduleId) {
    // A module will only be required once, in other words, even if an asynchronous module is depended on multiple times, its asynchronous behavior will only execute once
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

    // Execute the module function
    __webpack_modules__[moduleId](module, module.exports, __webpack_require__); 

    // Return the module's exports
    return module.exports; 
  }
```

We can see that:

1. `__webpack_require__` is a completely synchronous process;
2. Loading of `Async Dependency` occurs during the Module loading execution phase;

#### Execution of Entry

```js
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
            // Here, 395 refers to the aforementioned component module
            /* harmony import */ var _component__WEBPACK_IMPORTED_MODULE_0__ =
              __webpack_require__(395);
            var __webpack_async_dependencies__ =
              __webpack_handle_async_dependencies__([
                _component__WEBPACK_IMPORTED_MODULE_0__,
              ]);
            // Getting the asynchronous dependency's exports
            // This part takes into account the scenario where an asynchronous dependency still does not return a Promise
            _component__WEBPACK_IMPORTED_MODULE_0__ = (
              __webpack_async_dependencies__.then
                ? (await __webpack_async_dependencies__)()
                : __webpack_async_dependencies__
            )[0];

            // Consuming the asynchronous dependency's exports
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

As you can see:

1. Since Entry depends on a Dep using TLA, Entry will also be defined as an asynchronous module, here `__webpack_require__.a` is used to define the asynchronous module.
2. TLA is contagious, modules dependent on TLA would be recognized as `Async Module`, even if they don't have TLA themselves.

Therefore, the core dependencies are as follows:

1. `__webpack_require__.a`: Defines `Async Module`.
2. `__webpack_handle_async_dependencies__`: Loads asynchronous dependencies.
3. `__webpack_async_result__`: Callback when `Async Module` loading ends.

Among these, `__webpack_require__.a` deserves special mention.

#### `__webpack_require__.a`

`__webpack_require__.a` is used to define an `Async Module`. The related code analysis is as follows:

```js
 __webpack_require__.a = (module, body, hasAwait) => {
      // Closure preparation phase
      var queue;
      hasAwait && ((queue = []).d = -1);
      var depQueues = new Set();
      var exports = module.exports;
      var currentDeps;
      var outerResolve;
      var reject;
      // Used to control the asynchronous loading process of the module
      var promise = new Promise((resolve, rej) => {
        reject = rej;
        outerResolve = resolve;
      });
      promise[webpackExports] = exports;
       // fn (fnQueue) is passed in by Entry, so Dep's queue will be passed to Entry
      promise[webpackQueues] = (fn) => (
         // Dep's queue is passed to Entry's fn (fnQueue) for execution
        queue && fn(queue), 
         // Dep's depQueues are passed to Entry's fn (fnQueue) for execution
        depQueues.forEach(fn), 
        promise["catch"]((x) => {})
      );
      module.exports = promise;
      
      // Execute the Body of the Module
      body(
        // which means __webpack_handle_async_dependencies__
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
            // The initial value is 0. If there are dependencies, then after the promise initialization ends,
            // fn.r essentially expresses the "number of Deps being loaded"
            fn.r = 0;
            var fnQueue = (q) => {
              // q is passed in by Dep
              return (
                // q !== queue, that is, in a non-"self-circular reference" scenario,
                // Dep's queue will be saved in Entry's depQueues
                q !== queue &&
                !depQueues.has(q) &&
                (
                    depQueues.add(q),
                    // When q.d is -1/0, it means that the queue has not finished loading
                    // At this time, fn.r will be incremented by 1, meaning one more dependency,
                    // It will eventually be used when the module execution ends and resolveQueue is used
                    q && !q.d && (
                        fn.r++,
                        // Dep's queue will hold the function to control whether the Promise that loads the dependency in Entry is resolved
                        q.push(fn)
                    )
                 )
              );
            };

            // Pass fnQueue into the webpackQueues method of all Deps
            // The essence here is to establish a connection between Entry and all Deps
            // - Entry <— Dep: Mark the number of dependencies (fn.r)
            // - Entry -> Dep: Transfer the right to resolve the promise of loading async module to Dep
            currentDeps.map((dep) => dep[webpackQueues](fnQueue));
          });
          
          return fn.r ? promise : getResult();
        },
        // which means __webpack_async_result__, triggered after the module body is executed
        (err) => (
          err ? reject((promise[webpackError] = err)) : outerResolve(exports),
          resolveQueue(queue)
        )
      );
      queue && queue.d < 0 && (queue.d = 0);
    };
```

When **`__webpack_require__.a`** is executed, the following variables are defined:

| Variable           | Type      | Description                                                                                                                                                                                                                                                             |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ***`queue`***      | `array`   | When the current module contains an `await`, ***`queue`*** will be initialized to `[d: -1]`. Therefore, in this example, **Dep** will have a ***`queue`*** and **Entry** will not. For more details about the **state machine of queue**, see [queue](#queue).               |
| ***`depQueues`***  | `Set`     | Used to store the ***`queue`*** of Dependency.                                                                                                                                                                                                                          |
| ***`promise`***    | `Promise` | Used to control the asynchronous loading process of the module, and is assigned to ***`module.exports`***. It also transfers the power of resolve/reject to the outside to control when the module loading ends. After the ***`promise`*** is resolved, the upper layer module will be able to obtain the exports of the current module. For more details about **`promise`**, see [promise](#promise). |

After completing some basic definitions, it will start executing the body of the Module (`body()`), passing:

-   **`__webpack_handle_async_dependencies__`**
-   **`__webpack_async_result__`

These two core methods are given to the body function. Note that the execution within the body function is asynchronous. When the body function starts to execute, if `queue` exists (i.e., inside the TLA module) and `queue.d < 0`, then `queue.d` is set to `0`.

##### `queue`

This is a state machine:

- When a TLA module is defined, `queue.d` is set to `-1`.
- After the body of the TLA module has finished executing, `queue.d` is set to `0`.
- When the TLA module has completely finished loading, the `resolveQueue` method will set `queue.d` to `1`.

##### `promise`

The above ***`promise`*** also mounts 2 additional variables that should be mentioned:

| **`[webpackExports]`** | It indirectly references `module.exports`, so ****Entry** can get **Dep**'s exports through `promise`.                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`[webpackQueues]`**  | 1.  **Entry** and **Dep** hold each other's states;<br/>    2. When **Entry** loads the dependency (**\[Dep\]**), it passes a `resolve` function to **Dep**. When **Dep** completely finishes loading, it calls **Entry**'s `resolve` function, passing Dep's `exports` to **Entry**. Only then can **Entry**'s **body** begin execution. |

##### `resolveQueue`
**`resolveQueue` is absolutely one of the highlights in this Runtime**. After the execution of a module's body, the `resolveQueue` function will be called, with implementation as follows:

```js
var resolveQueue = (queue) => {
  // Check for queue.d to affirm that resolveQueue has not been previously called.
  // If queue.d = 1, it means that this queue has already been 'resolve' completed.
  if (queue && queue.d < 1) {
    queue.d = 1;
    // fn.r first decreases by 1, marking "one less dependency still loading".
    queue.forEach((fn) => fn.r--);
    // Note that, the fn stored in the queue is the notification function held by Dep to notify Entry that asynchronous dependencies have loaded.
    // That is, resolving the Promise returned by __webpack_handle_async_dependencies__.
    // If fn.r > 0, it means there are dependencies that haven't finished loading yet.
    // At this point, we can't notify Entry, so we use fn.r++ to revert this change.
    // If fn.r equals 0, it signifies all dependencies have been loaded, and now we can notify Entry!
    queue.forEach((fn) => (fn.r-- ? fn.r++ : fn()));
  }
};
```

### Complex Example

<p align="center">
  <img
    width="400"
    src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/complicated-example.png?raw=true"
  />
</p>

If the dependency relationship shown in the left figure, where modules `d` and `b` include TLA(Top-Level Await), then:

1. `a` and `c` will also become Async Modules due to the propagation issue of TLA.
2. **The Moment When a Module Starts to Load:** That is when `__webpack_require__` is called, here DFS(Depth-First Search) will be performed based on the order of import.
   Suppose imports in `a` are as follows:
    ```js
    import { b } from "./b";
    import { c } from "./c";
    import { sleep } from "./e";
    ```
   Then, the loading sequence is `a —> b —> e —> c —> d`.
3. **The Moment When a Module Finishes Loading:**
   1. If load time `d > b`, then the moment when modules finish loading is `b —> d —> c —> a`.
   2. If load time `d < b`, then the moment when modules finish loading is `d —> c —> b —> a`.
   3. Sync Module `a` is not considered here because `a` has finished loading at the time of loading.
   4. In a module graph with TLA, Entry will always be an `Async Module`.

### Source of Complexity

If we carefully read the [ECMAScript proposal: Top-level await](https://github.com/tc39/proposal-top-level-await), we can see a simpler example to describe this behavior:

```js
import { a } from './a.mjs';
import { b } from './b.mjs';
import { c } from './c.mjs';

console.log(a, b, c);
```

Which roughly equals to:

```js
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

This example has inspired the construction of some bundleless toolchains, such as [vite-plugin-top-level-await](https://github.com/Menci/vite-plugin-top-level-await). The complexity of supporting TLA compilation to iife at the Bundler level mainly comes from: **We need to merge all modules into one file while maintaining the aforementioned semantics**.

## Can We Use TLA Now?

The Runtime mentioned previously is injected by inline scripts in the **Seal** phase. Since **Seal** is the final stage of module compilation and can no longer undergo the **Make** phase (won't run loaders), the concatenated template code must take compatibility into account. In fact, this is the case, Webpack internal Templates consider compatibility, for instance:

```js
 // lib/dependencies/HarmonyExportImportedSpecifierDependency.js

const modern = runtimeTemplate.supportsConst() && runtimeTemplate.supportsArrowFunction();
// ...
if (modern) {
    content += `() => ${importVar}[__WEBPACK_IMPORT_KEY__]`;
} else {
    content += `function(key) { return ${importVar}[key]; }.bind(0, __WEBPACK_IMPORT_KEY__)`;
}
```

```js
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

When we switch the `target` between `es5` or `es6`, you will see a noticeable difference in the output:

> Left side `target: ['web', 'es6']`; right side `target: ['web', 'es5']`

<p align="center">
  <img
    width="100%"
    src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/webpack-target-diff.png?raw=true"
  />
</p>

However, `Top-level await` does not follow this principle. In [webpack#12529](https://github.com/webpack/webpack/pull/12529), we can see that [Alexander Akait](https://github.com/alexander-akait) once questioned the compatibility of `async/await` in Template, but [Tobias Koppers](https://github.com/sokra) responded that it was very difficult to fix:

<p align="center">
  <img
    width="600"
    src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tobias-code-review.png?raw=true"
  />
</p>

Therefore, this implementation has been retained in Webpack, and **TLA has become one of the few features that cause compatibility issues with Runtime Template in Webpack**.

In fact, it can be understood here that if the Template depends on `async/await`, then if you want to consider compatibility, you need to consider introducing [regenerator-runtime](https://www.npmjs.com/package/regenerator-runtime) or a more elegant state machine-based implementation like in tsc (See: [TypeScript#1664](https://github.com/microsoft/TypeScript/issues/1664)). A former intern from Web Infra has also attempted to implement this (See: [babel-plugin-lite-regenerator](https://github.com/konicyQWQ/babel-plugin-lite-regenerator)).

That is to say, the compilation of TLA by Webpack, due to the fact that the output still contains `async/await`, leads to it only being runnable on **iOS 11** and **Chrome 55** machines:
| [Top-level await](https://caniuse.com/?search=Top%20level%20await)'s Compatibility   | - Chrome 89 <br/>- Safari 16  | ![](https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tla-compatibility.png?raw=true)                  |
| ------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Expected Compatibility（Compiled to [ES5](https://caniuse.com/?search=ES5)）         | - Chrome 23 <br/>- Safari 6   | ![](https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tla-compatibility-webpack-expected.png?raw=true) |
| Actual Compatibility <br/>（i.e. [async / await](https://caniuse.com/?search=async)） | - Chrome 55  <br/>- Safari 11 | ![](https://github.com/ulivz/deep-dive-into-tla/blob/master/public/tla-compatibility-webpack-actual.png?raw=true)   |

## Summary

1. The inception of TLA was intended to try to solve the async initialization problem of ES Module;
2. TLA is a feature of `es2022`, it can be used in versions above [v14.8.0](https://nodejs.org/en/blog/release/v14.8.0). If you need to use it in UI code, you need to pack with Bundler; unless you will directly use [es module](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules) in frontend projects, generally, you need to package into **`iife`**;

3. Most Bundlers can successfully compile TLA when the target format is **`esm`**, but **only Webpack supports TLA compilation into `iife`**. Also, Webpack is the only Bundler that can correctly simulate the semantics of TLA.
   
4. Although Webpack can package TLA into `iife`, because the product still contains `async/await` (although not TLA), it can only run on machines with `iOS11 / Chrome 55`. At present, for some large companies' Mobile Web C-end businesses, compatibility may be required to be set to **iOS 9 / Android 4.4**. Therefore, for stability considerations, you should not use TLA in C-end projects. In the future, you should try TLA based on business needs;
   
5. In terms of Webpack implementation details, just as `await` requires being used in an `async function`, TLA will cause Dependent to also be treated as an Async Module, but this is imperceptible to developers.

## Next Steps

Having read this far, there are still some additional questions worth further research:

1. How does JS Runtime or JS virtual machine implement TLA; 
2. What happens when an Async Module fails to load in a TLA supported natively by the JS Runtime or JS virtual machine? How to debug?


## In Conclusion

The author of Rollup, [Rich Harris](https://github.com/Rich-Harris), previously mentioned in a Gist **[Top-level await is a footgun 👣🔫](https://gist.github.com/Rich-Harris/0b6f317657f5167663b493c722647221#top-level-await-is-a-footgun-)**:

> At first, my reaction was that it's such a self-evidently bad idea that I must have just misunderstood something. But I'm no longer sure that's the case, so I'm sticking my oar in: **Top-level** **`await`**, as far as I can tell, is a mistake and it should not become part of the language.

However, he later mentioned:

> TC39 is currently moving forward with a slightly different version of TLA, referred to as 'variant B', **in which a module with TLA doesn't block** ***sibling*** **execution**. This vastly reduces the danger of parallelizable work happening in serial and thereby delaying startup, which was the concern that motivated me to write this gist.

Therefore, he began to fully support this proposal:

> Therefore, a version of TLA that solves the original issue is a valuable addition to the language, and I'm in full support of the current proposal, [which you can read here](https://github.com/tc39/proposal-top-level-await).

Here we can also take a look at the history of TLA in the [ECMAScript proposal: Top-level await](https://github.com/tc39/proposal-top-level-await):

- In [January 2014](https://github.com/tc39/notes/blob/main/meetings/2014-01/jan-30.md#asyncawait), the `async / await proposal` was submitted to the committee;
- In [April 2014](https://github.com/tc39/tc39-notes/blob/master/meetings/2014-04/apr-10.md#preview-of-asnycawait), the discussion was about reserving the keyword await in modules for TLA;
- In [July 2015](https://github.com/tc39/tc39-notes/blob/master/meetings/2015-07/july-30.md#64-advance-async-functions-to-stage-2), `async / await proposal` advanced to Stage 2, during which it was decided to postpone TLA to avoid blocking the current proposal; many committee members had already started discussing, mainly to ensure that it is still possible in the language;
- In May 2018, the TLA proposal entered the second phase of the TC39 process, and many design decisions (**especially whether to block "sibling" execution**) were discussed during this stage.

How do you see the future of TLA?

## Further Updates

### Rspack officially backs TLA from v0.3.8, verified using Fuzzer.

[Rspack](https://www.rspack.dev/) is a high-performance JavaScript bundler based on Rust, boasting powerful interoperability with the [webpack](https://webpack.js.org/) ecosystem. Recently, Rspack incorporated `TLA (Top Level Await)` into [v0.3.8](https://github.com/web-infra-dev/rspack/releases/tag/v0.3.8).

It's worth mentioning that Rspack achieved consistent results with Webpack in TLA Fuzzer testing<sup>[9]</sup>:

<p align="center">
  <img
    width="400"
    src="https://github.com/ulivz/deep-dive-into-tla/blob/master/public/rspack-tla-fuzzer-report.png?raw=true"
  />
</p>

With this in mind, we can add Rspack to the list of Bundlers that can correctly simulate TLA semantics!


## Refs

<sup>[1]: https://rsbuild.dev/config/options/source.html#sourceinclude</sup><br/>
<sup>[2]: https://github.com/tc39/proposal-top-level-await</sup><br/>
<sup>[3]: https://github.com/evanw/esbuild/issues/253</sup><br/>
<sup>[4]: https://github.com/rollup/rollup/issues/3623</sup><br/>
<sup>[5]: https://www.typescriptlang.org/docs/handbook/esm-node.html</sup><br/>
<sup>[6]: https://v8.dev/features/top-level-await</sup><br/>
<sup>[7]: https://github.com/evanw/tla-fuzzer</sup><br/>
<sup>[8]: https://gist.github.com/Rich-Harris/0b6f317657f5167663b493c722647221</sup><br/>
<sup>[9]: https://github.com/ulivz/tla-fuzzer/tree/feat/rspack</sup>

