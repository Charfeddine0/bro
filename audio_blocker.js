(function () {
  const makeErr = (msg) => Object.assign(new Error(msg), { name: "NotAllowedError" });

  try {
    if (window.AudioContext) window.AudioContext = function(){ throw makeErr("AudioContext blocked."); };
    if (window.webkitAudioContext) window.webkitAudioContext = function(){ throw makeErr("AudioContext blocked."); };
    if (window.OfflineAudioContext) window.OfflineAudioContext = function(){ throw makeErr("OfflineAudioContext blocked."); };
    if (window.webkitOfflineAudioContext) window.webkitOfflineAudioContext = function(){ throw makeErr("OfflineAudioContext blocked."); };
  } catch {}

  try { Object.defineProperty(window, "__ANTI_FP_AUDIO__", { value: true, configurable: false }); } catch {}
  console.log("[ANTI-FP] Audio blocked");
})();
