(function () {
  const makeErr = (msg) => Object.assign(new Error(msg), { name: "NotAllowedError" });
  const throwNow = () => { throw makeErr("Blocked by Strong Anti-FP mode."); };
  const rejectNow = () => Promise.reject(makeErr("Blocked by Strong Anti-FP mode."));

  // WebRTC OFF
  try {
    if (window.RTCPeerConnection) window.RTCPeerConnection = function(){ throwNow(); };
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = function(){ throwNow(); };
    if (window.RTCDataChannel) window.RTCDataChannel = function(){ throwNow(); };
    if (window.RTCSessionDescription) window.RTCSessionDescription = function(){ throwNow(); };
    if (window.RTCIceCandidate) window.RTCIceCandidate = function(){ throwNow(); };
  } catch {}

  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia = function(){ return rejectNow(); };
    }
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices = function(){ return rejectNow(); };
    }
    if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
      navigator.mediaDevices.getDisplayMedia = function(){ return rejectNow(); };
    }
  } catch {}

  // Canvas OFF
  try {
    const blockCanvas = () => { throw makeErr("Canvas blocked (Strong Anti-FP)."); };

    if (HTMLCanvasElement?.prototype?.toDataURL) HTMLCanvasElement.prototype.toDataURL = blockCanvas;
    if (HTMLCanvasElement?.prototype?.toBlob) HTMLCanvasElement.prototype.toBlob = blockCanvas;
    if (CanvasRenderingContext2D?.prototype?.getImageData) CanvasRenderingContext2D.prototype.getImageData = blockCanvas;
    if (CanvasRenderingContext2D?.prototype?.measureText) {
      CanvasRenderingContext2D.prototype.measureText = function(){ throw makeErr("Canvas text metrics blocked."); };
    }
  } catch {}

  // WebGL OFF
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

  // Audio OFF
  try {
    if (window.AudioContext) window.AudioContext = function(){ throw makeErr("AudioContext blocked."); };
    if (window.webkitAudioContext) window.webkitAudioContext = function(){ throw makeErr("AudioContext blocked."); };
    if (window.OfflineAudioContext) window.OfflineAudioContext = function(){ throw makeErr("OfflineAudioContext blocked."); };
    if (window.webkitOfflineAudioContext) window.webkitOfflineAudioContext = function(){ throw makeErr("OfflineAudioContext blocked."); };
  } catch {}

  // Battery OFF
  try { if (navigator.getBattery) navigator.getBattery = () => rejectNow(); } catch {}

  // High entropy client hints OFF
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      navigator.userAgentData.getHighEntropyValues = () => rejectNow();
    }
  } catch {}

  try { Object.defineProperty(window, "__ANTI_FP_STRONG__", { value: true, configurable: false }); } catch {}
  console.log("[ANTI-FP] STRONG mode enabled (WebRTC/Canvas/WebGL/Audio blocked)");
})();
