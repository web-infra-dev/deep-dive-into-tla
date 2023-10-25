(() => {
  // webpackBootstrap
  "use strict";
  // 模块声明
  var __webpack_modules__ = {
    395: (module, __webpack_exports__, __webpack_require__) => {
      __webpack_require__.a(
        module,
        async (
          __webpack_handle_async_dependencies__,
          __webpack_async_result__
        ) => {
          // 处理了异步模块的加载失败的问题
          try {
            // 将 component 挂在到 __webpack_exports__ 上，对应 export function component 语义
            /* harmony export */ __webpack_require__.d(__webpack_exports__, {
              /* harmony export */ w: () => /* binding */ component,
              /* harmony export */
            });

            // 实际的模块 Body
            await 1000;

            function component() {
              const element = document.createElement("div");
              element.innerHTML = "Hello, Webpack!";
              return element;
            }

            __webpack_async_result__();
            // 如果加载失败会返回 Error
          } catch (e) {
            __webpack_async_result__(e);
          }
        },
        1
      );
    },

    138: (
      module,
      __unused_webpack___webpack_exports__,
      __webpack_require__
    ) => {
      // TLA 具有传染性，依赖 TLA 的模块也会被识别为 Async Module，即使它本身没有 TLA
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
  /************************************************************************/

  // The module cache
  var __webpack_module_cache__ = {};

  // The require function
  function __webpack_require__(moduleId) {
    // Check if module is in cache
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

    // Return the exports of the module
    return module.exports;
  }

  /************************************************************************/
  /* webpack/runtime/async module */
  (() => {
    var webpackQueues =
      typeof Symbol === "function"
        ? Symbol("webpack queues")
        : "__webpack_queues__";
    var webpackExports =
      typeof Symbol === "function"
        ? Symbol("webpack exports")
        : "__webpack_exports__";
    var webpackError =
      typeof Symbol === "function"
        ? Symbol("webpack error")
        : "__webpack_error__";
    var resolveQueue = (queue) => {
      if (queue && queue.d < 1) {
        // .d 为 1，意味着 queue 为
        queue.d = 1;
        queue.forEach((fn) => fn.r--);
        queue.forEach((fn) => (fn.r-- ? fn.r++ : fn()));
      }
    };
    // 包装了依赖，处理正在
    var wrapDeps = (deps) =>
      deps.map((dep) => {
        if (dep !== null && typeof dep === "object") {
          // 看起来 dep[webpackQueues] 一定存在，这里可能是为了处理什么特殊场景
          if (dep[webpackQueues]) return dep;
          if (dep.then) {
            var queue = [];
            queue.d = 0;
            dep.then(
              (r) => {
                obj[webpackExports] = r;
                resolveQueue(queue);
              },
              (e) => {
                obj[webpackError] = e;
                resolveQueue(queue);
              }
            );
            var obj = {};
            obj[webpackQueues] = (fn) => fn(queue);
            return obj;
          }
        }
        var ret = {};
        ret[webpackQueues] = (x) => {};
        ret[webpackExports] = dep;
        return ret;
      });

    // 定义异步模块的入口方法，body 是模块的加载函数
    __webpack_require__.a = (module, body, hasAwait) => {
      var queue;
      // -1 表示开始加载依赖
      hasAwait && ((queue = []).d = -1);
      // 存储依赖的队列
      var depQueues = new Set(); // Set >= iOS 8
      var exports = module.exports;
      var currentDeps;
      var outerResolve;
      var reject;
      // 将 Promise 的 resolve/reject 权利转移到外部（类似 PIA Runtime 中的 Controlled Microtask）
      var promise = new Promise((resolve, rej) => {
        reject = rej;
        outerResolve = resolve;
      });
      promise[webpackExports] = exports;

      // [webpackQueues] 会被当前模块的依赖所调用
      promise[webpackQueues] = (fn) => (
        queue && fn(queue), depQueues.forEach(fn), promise["catch"]((x) => {})
      );
      // 将模块的 exports 声明为一个 Promise，这很符合 TLA 诞生的 Motivation
      module.exports = promise;

      // 加载模块
      body(
        // 加载异步依赖，即前面的 __webpack_handle_async_dependencies__
        // 这里的 deps 是通过 __webpack_require__ 获取到的模块的 module.exports，即 Promise[]
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
            fn.r = 0;
            var fnQueue = (q) =>
              q !== queue &&
              // 如果 depQueues 没有包含 q，那么入列
              // 如果 depQueues 没有包含 q，那么入列
              !depQueues.has(q) &&
              (depQueues.add(q), q && !q.d && (fn.r++, q.push(fn)));

            // 会依赖调用依赖的 webpackQueues 方法
            // 即 index.js 会调用 component.js 定义时的 webpackQueues 方法
            currentDeps.map((dep) => dep[webpackQueues](fnQueue));
          });
          // fn.r d
          return fn.r ? promise : getResult();
        },
        // 模块加载结束的回调，即前面的 __webpack_async_result__()
        (err) => (
          err ? reject((promise[webpackError] = err)) : outerResolve(exports),
          resolveQueue(queue)
        )
      );

      // 0 表示依赖的 body 函数执行结束
      queue && queue.d < 0 && (queue.d = 0);
    };
  })();

  /* webpack/runtime/define property getters */
  (() => {
    // define getter functions for harmony exports
    __webpack_require__.d = (exports, definition) => {
      for (var key in definition) {
        if (
          __webpack_require__.o(definition, key) &&
          !__webpack_require__.o(exports, key)
        ) {
          Object.defineProperty(exports, key, {
            enumerable: true,
            get: definition[key],
          });
        }
      }
    };
  })();

  /* webpack/runtime/hasOwnProperty shorthand */
  (() => {
    __webpack_require__.o = (obj, prop) =>
      Object.prototype.hasOwnProperty.call(obj, prop);
  })();

  /************************************************************************/

  // startup
  // Load entry module and return exports
  // This entry module used 'module' so it can't be inlined
  var __webpack_exports__ = __webpack_require__(138);
})();
//# sourceMappingURL=main.js.map
