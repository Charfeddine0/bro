(function () {
  const makeErr = (msg) => Object.assign(new Error(msg), { name: "NotAllowedError" });
  const throwNow = () => { throw makeErr("WebRTC blocked (Strong Anti-FP mode)."); };
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

  try { Object.defineProperty(window, "__ANTI_FP_WEBRTC__", { value: true, configurable: false }); } catch {}
  console.log("[ANTI-FP] WebRTC blocked");
})();
