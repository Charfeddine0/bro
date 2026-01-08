(function () {
  const makeErr = (msg) => Object.assign(new Error(msg), { name: "NotAllowedError" });

  try {
    const blockCanvas = () => { throw makeErr("Canvas blocked (Strong Anti-FP)." ); };

    if (HTMLCanvasElement?.prototype?.toDataURL) HTMLCanvasElement.prototype.toDataURL = blockCanvas;
    if (HTMLCanvasElement?.prototype?.toBlob) HTMLCanvasElement.prototype.toBlob = blockCanvas;
    if (CanvasRenderingContext2D?.prototype?.getImageData) CanvasRenderingContext2D.prototype.getImageData = blockCanvas;
    if (CanvasRenderingContext2D?.prototype?.measureText) {
      CanvasRenderingContext2D.prototype.measureText = function(){ throw makeErr("Canvas text metrics blocked."); };
    }
  } catch {}

  try { Object.defineProperty(window, "__ANTI_FP_CANVAS__", { value: true, configurable: false }); } catch {}
  console.log("[ANTI-FP] Canvas blocked");
})();
