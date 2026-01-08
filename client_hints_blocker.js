(function () {
  const makeErr = (msg) => Object.assign(new Error(msg), { name: "NotAllowedError" });
  const rejectNow = () => Promise.reject(makeErr("Blocked by Strong Anti-FP mode."));

  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      navigator.userAgentData.getHighEntropyValues = () => rejectNow();
    }
  } catch {}

  try { Object.defineProperty(window, "__ANTI_FP_CLIENT_HINTS__", { value: true, configurable: false }); } catch {}
  console.log("[ANTI-FP] Client hints blocked");
})();
