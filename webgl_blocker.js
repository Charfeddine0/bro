(function () {
  const makeErr = (msg) => Object.assign(new Error(msg), { name: "NotAllowedError" });

  try {
    if (HTMLCanvasElement?.prototype?.getContext) {
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, attrs){
        const t = String(type || "").toLowerCase();
        if (t.includes("webgl")) return null;
        return origGetContext.call(this, type, attrs);
      };
    }
    const blockWebGL = () => { throw makeErr("WebGL blocked (Strong Anti-FP)."); };
    if (WebGLRenderingContext?.prototype?.getParameter) WebGLRenderingContext.prototype.getParameter = blockWebGL;
    if (WebGL2RenderingContext?.prototype?.getParameter) WebGL2RenderingContext.prototype.getParameter = blockWebGL;
  } catch {}

  try { Object.defineProperty(window, "__ANTI_FP_WEBGL__", { value: true, configurable: false }); } catch {}
  console.log("[ANTI-FP] WebGL blocked");
})();
