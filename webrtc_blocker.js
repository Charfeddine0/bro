(function () {
  const makeErr = (msg) => Object.assign(new Error(msg), { name: "NotAllowedError" });
  const rejectNow = () => Promise.reject(makeErr("Blocked by Strong Anti-FP mode."));

  const getInjectedIp = () => {
    const ip = String(window.__PUBLIC_IP__ || "").trim();
    return ip || "0.0.0.0";
  };

  const maskCandidate = (candidate) => {
    if (!candidate) return candidate;
    const replacement = getInjectedIp();
    return candidate
      .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, replacement)
      .replace(/\b([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, replacement);
  };

  const wrapIceCandidate = (candidate) => {
    if (!candidate || !candidate.candidate) return candidate;
    const masked = maskCandidate(candidate.candidate);
    if (masked === candidate.candidate) return candidate;
    try {
      return new RTCIceCandidate({ ...candidate, candidate: masked });
    } catch {
      candidate.candidate = masked;
      return candidate;
    }
  };

  try {
    const OriginalPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (OriginalPeerConnection) {
      const WrappedPeerConnection = function (config, ...rest) {
        const safeConfig = { ...(config || {}) };
        safeConfig.iceServers = Array.isArray(safeConfig.iceServers) ? safeConfig.iceServers : [];
        safeConfig.iceTransportPolicy = "relay";
        const pc = new OriginalPeerConnection(safeConfig, ...rest);

        const originalAddIceCandidate = pc.addIceCandidate?.bind(pc);
        if (originalAddIceCandidate) {
          pc.addIceCandidate = (candidate, ...args) =>
            originalAddIceCandidate(wrapIceCandidate(candidate), ...args);
        }

        const originalDispatch = pc.dispatchEvent?.bind(pc);
        if (originalDispatch) {
          pc.dispatchEvent = (event) => {
            if (event?.type === "icecandidate" && event.candidate) {
              event.candidate = wrapIceCandidate(event.candidate);
            }
            return originalDispatch(event);
          };
        }

        const originalAddEventListener = pc.addEventListener?.bind(pc);
        if (originalAddEventListener) {
          pc.addEventListener = (type, listener, options) => {
            if (type === "icecandidate" && typeof listener === "function") {
              const wrappedListener = (event) => {
                if (event?.candidate) {
                  event.candidate = wrapIceCandidate(event.candidate);
                }
                return listener(event);
              };
              return originalAddEventListener(type, wrappedListener, options);
            }
            return originalAddEventListener(type, listener, options);
          };
        }

        return pc;
      };

      WrappedPeerConnection.prototype = OriginalPeerConnection.prototype;
      window.RTCPeerConnection = WrappedPeerConnection;
      window.webkitRTCPeerConnection = WrappedPeerConnection;
    }

    if (window.RTCIceCandidate) {
      const OriginalIceCandidate = window.RTCIceCandidate;
      window.RTCIceCandidate = function (init) {
        if (init && init.candidate) {
          init = { ...init, candidate: maskCandidate(init.candidate) };
        }
        return new OriginalIceCandidate(init);
      };
      window.RTCIceCandidate.prototype = OriginalIceCandidate.prototype;
    }
  } catch {}

  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia = function () { return rejectNow(); };
    }
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices = function () { return rejectNow(); };
    }
    if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
      navigator.mediaDevices.getDisplayMedia = function () { return rejectNow(); };
    }
  } catch {}

  try {
    Object.defineProperty(window, "__ANTI_FP_WEBRTC__", {
      value: true,
      configurable: false
    });
  } catch {}
  console.log("[ANTI-FP] WebRTC masked public IP");
})();
