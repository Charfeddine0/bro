(function () {
  const makeErr = (msg) => Object.assign(new Error(msg), { name: "NotAllowedError" });
  const rejectNow = () => Promise.reject(makeErr("Blocked by Strong Anti-FP mode."));

  try { if (navigator.getBattery) navigator.getBattery = () => rejectNow(); } catch {}

  try { Object.defineProperty(window, "__ANTI_FP_BATTERY__", { value: true, configurable: false }); } catch {}
  console.log("[ANTI-FP] Battery blocked");
})();
