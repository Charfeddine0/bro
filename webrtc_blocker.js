(function () {
  const makeErr = (msg) => Object.assign(new Error(msg), { name: "NotAllowedError" });
  const rejectNow = () => Promise.reject(makeErr("Blocked by Strong Anti-FP mode."));

  const getInjectedIp = () => {
    const ip = String(globalThis.__PUBLIC_IP__ || "").trim();
    return ip || "0.0.0.0";
  };

  const maskIpLiteral = (value) => {
    if (typeof value !== "string") return value;
    return maskCandidate(value);
  };

  const maskCandidate = (candidate) => {
    if (!candidate) return candidate;
    const replacement = getInjectedIp();
    return candidate
      .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, replacement)
      .replace(/\b([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, replacement);
  };

  const maskIpInObject = (obj) => {
    const seen = new WeakSet();
    const walk = (value) => {
      if (!value || typeof value !== "object") return value;
      if (seen.has(value)) return value;
      seen.add(value);
      for (const key of Object.keys(value)) {
        const entry = value[key];
        if (typeof entry === "string") {
          value[key] = maskCandidate(entry);
        } else if (Array.isArray(entry)) {
          value[key] = entry.map((item) => {
            if (typeof item === "string") return maskCandidate(item);
            if (item && typeof item === "object") return walk(item);
            return item;
          });
        } else if (entry && typeof entry === "object") {
          walk(entry);
        }
      }
      return value;
    };
    return walk(obj);
  };

  const scrubIceServers = (servers) => {
    if (!Array.isArray(servers)) return [];
    return servers.map((server) => {
      if (!server || typeof server !== "object") return server;
      const copy = { ...server };
      if (typeof copy.urls === "string") {
        copy.urls = maskCandidate(copy.urls);
      } else if (Array.isArray(copy.urls)) {
        copy.urls = copy.urls.map((url) => (typeof url === "string" ? maskCandidate(url) : url));
      }
      if (typeof copy.username === "string") {
        copy.username = maskCandidate(copy.username);
      }
      if (typeof copy.credential === "string") {
        copy.credential = maskCandidate(copy.credential);
      }
      return copy;
    });
  };

  const patchStatsReport = (report) => {
    if (!report || typeof report !== "object") return report;
    if (report.__ANTI_FP_PATCHED_STATS__) return report;
    try {
      Object.defineProperty(report, "__ANTI_FP_PATCHED_STATS__", { value: true });
    } catch {
      report.__ANTI_FP_PATCHED_STATS__ = true;
    }
    if (typeof report.get === "function") {
      const originalGet = report.get.bind(report);
      report.get = (key) => maskIpInObject(originalGet(key));
    }
    if (typeof report.forEach === "function") {
      const originalForEach = report.forEach.bind(report);
      report.forEach = (callback, thisArg) =>
        originalForEach((stat, key) => callback.call(thisArg, maskIpInObject(stat), key), thisArg);
    }
    if (typeof report.values === "function") {
      const originalValues = report.values.bind(report);
      report.values = function* () {
        for (const stat of originalValues()) {
          yield maskIpInObject(stat);
        }
      };
    }
    if (typeof report.entries === "function") {
      const originalEntries = report.entries.bind(report);
      report.entries = function* () {
        for (const [key, stat] of originalEntries()) {
          yield [key, maskIpInObject(stat)];
        }
      };
    }
    return report;
  };

  const wrapIceCandidate = (candidate) => {
    if (!candidate || !candidate.candidate) return candidate;
    const masked = maskCandidate(candidate.candidate);
    if (masked === candidate.candidate) return candidate;
    try {
      return new RTCIceCandidate({
        ...candidate,
        candidate: masked,
        address: maskIpLiteral(candidate.address),
        relatedAddress: maskIpLiteral(candidate.relatedAddress)
      });
    } catch {
      candidate.candidate = masked;
      if (candidate.address) candidate.address = maskIpLiteral(candidate.address);
      if (candidate.relatedAddress) candidate.relatedAddress = maskIpLiteral(candidate.relatedAddress);
      return candidate;
    }
  };

  const maskSdp = (sdp) => {
    if (!sdp) return sdp;
    return maskCandidate(sdp);
  };

  const wrapSessionDescription = (desc) => {
    if (!desc || !desc.sdp) return desc;
    const maskedSdp = maskSdp(desc.sdp);
    if (maskedSdp === desc.sdp) return desc;
    try {
      return new RTCSessionDescription({ ...desc, sdp: maskedSdp });
    } catch {
      desc.sdp = maskedSdp;
      return desc;
    }
  };

  try {
    const OriginalPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (OriginalPeerConnection) {
      const WrappedPeerConnection = function (config, ...rest) {
        const safeConfig = { ...(config || {}) };
        safeConfig.iceServers = scrubIceServers(safeConfig.iceServers);
        safeConfig.iceTransportPolicy = "relay";
        const pc = new OriginalPeerConnection(safeConfig, ...rest);

        const originalAddIceCandidate = pc.addIceCandidate?.bind(pc);
        if (originalAddIceCandidate) {
          pc.addIceCandidate = (candidate, ...args) =>
            originalAddIceCandidate(wrapIceCandidate(candidate), ...args);
        }

        const originalCreateOffer = pc.createOffer?.bind(pc);
        if (originalCreateOffer) {
          pc.createOffer = async (...args) => {
            const offer = await originalCreateOffer(...args);
            if (offer?.sdp) offer.sdp = maskSdp(offer.sdp);
            return offer;
          };
        }

        const originalCreateAnswer = pc.createAnswer?.bind(pc);
        if (originalCreateAnswer) {
          pc.createAnswer = async (...args) => {
            const answer = await originalCreateAnswer(...args);
            if (answer?.sdp) answer.sdp = maskSdp(answer.sdp);
            return answer;
          };
        }

        const originalSetLocalDescription = pc.setLocalDescription?.bind(pc);
        if (originalSetLocalDescription) {
          pc.setLocalDescription = (desc, ...args) =>
            originalSetLocalDescription(wrapSessionDescription(desc), ...args);
        }

        const originalSetRemoteDescription = pc.setRemoteDescription?.bind(pc);
        if (originalSetRemoteDescription) {
          pc.setRemoteDescription = (desc, ...args) =>
            originalSetRemoteDescription(wrapSessionDescription(desc), ...args);
        }

        const originalDispatch = pc.dispatchEvent?.bind(pc);
        if (originalDispatch) {
          pc.dispatchEvent = (event) => {
            if (event?.type === "icecandidate" && event.candidate) {
              event.candidate = wrapIceCandidate(event.candidate);
            }
            if (event?.type === "icecandidateerror") {
              if (event.address) event.address = maskIpLiteral(event.address);
              if (event.url) event.url = maskCandidate(event.url);
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
            if (type === "icecandidateerror" && typeof listener === "function") {
              const wrappedListener = (event) => {
                if (event) {
                  event.address = maskIpLiteral(event.address);
                  event.url = maskCandidate(event.url);
                }
                return listener(event);
              };
              return originalAddEventListener(type, wrappedListener, options);
            }
            return originalAddEventListener(type, listener, options);
          };
        }

        let iceCandidateHandler = null;
        Object.defineProperty(pc, "onicecandidate", {
          configurable: true,
          get() {
            return iceCandidateHandler;
          },
          set(handler) {
            if (typeof handler !== "function") {
              iceCandidateHandler = handler;
              return;
            }
            iceCandidateHandler = (event) => {
              if (event?.candidate) {
                event.candidate = wrapIceCandidate(event.candidate);
              }
              return handler(event);
            };
          }
        });

        let iceCandidateErrorHandler = null;
        Object.defineProperty(pc, "onicecandidateerror", {
          configurable: true,
          get() {
            return iceCandidateErrorHandler;
          },
          set(handler) {
            if (typeof handler !== "function") {
              iceCandidateErrorHandler = handler;
              return;
            }
            iceCandidateErrorHandler = (event) => {
              if (event) {
                event.address = maskIpLiteral(event.address);
                event.url = maskCandidate(event.url);
              }
              return handler(event);
            };
          }
        });

        const originalSetConfiguration = pc.setConfiguration?.bind(pc);
        if (originalSetConfiguration) {
          pc.setConfiguration = (config) => {
            const safeConfig = { ...(config || {}) };
            safeConfig.iceServers = scrubIceServers(safeConfig.iceServers);
            safeConfig.iceTransportPolicy = "relay";
            return originalSetConfiguration(safeConfig);
          };
        }

        const originalGetConfiguration = pc.getConfiguration?.bind(pc);
        if (originalGetConfiguration) {
          pc.getConfiguration = () => {
            const cfg = originalGetConfiguration();
            if (!cfg || typeof cfg !== "object") return cfg;
            return {
              ...cfg,
              iceServers: scrubIceServers(cfg.iceServers)
            };
          };
        }

        const originalGetStats = pc.getStats?.bind(pc);
        if (originalGetStats) {
          pc.getStats = (...args) => {
            if (typeof args[0] === "function") {
              const success = args[0];
              const failure = args[1];
              return originalGetStats(
                (report) => {
                  try {
                    patchStatsReport(report);
                  } catch {}
                  return success(report);
                },
                failure
              );
            }
            const promise = originalGetStats(...args);
            if (promise && typeof promise.then === "function") {
              return promise.then((report) => {
                try {
                  patchStatsReport(report);
                } catch {}
                return report;
              });
            }
            return promise;
          };
        }

        ["localDescription", "remoteDescription", "currentLocalDescription", "currentRemoteDescription"].forEach((prop) => {
          const desc = Object.getOwnPropertyDescriptor(OriginalPeerConnection.prototype, prop);
          if (!desc || typeof desc.get !== "function") return;
          Object.defineProperty(pc, prop, {
            configurable: true,
            get() {
              const value = desc.get.call(pc);
              return wrapSessionDescription(value);
            }
          });
        });

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
        if (init && init.address) {
          init = { ...init, address: maskIpLiteral(init.address) };
        }
        if (init && init.relatedAddress) {
          init = { ...init, relatedAddress: maskIpLiteral(init.relatedAddress) };
        }
        return new OriginalIceCandidate(init);
      };
      window.RTCIceCandidate.prototype = OriginalIceCandidate.prototype;
      if (OriginalIceCandidate.prototype?.toJSON) {
        const originalToJSON = OriginalIceCandidate.prototype.toJSON;
        OriginalIceCandidate.prototype.toJSON = function (...args) {
          const data = originalToJSON.apply(this, args);
          return maskIpInObject(data);
        };
      }
    }

    if (window.RTCSessionDescription) {
      const OriginalSessionDescription = window.RTCSessionDescription;
      window.RTCSessionDescription = function (init) {
        if (init && init.sdp) {
          init = { ...init, sdp: maskSdp(init.sdp) };
        }
        return new OriginalSessionDescription(init);
      };
      window.RTCSessionDescription.prototype = OriginalSessionDescription.prototype;
      if (OriginalSessionDescription.prototype?.toJSON) {
        const originalToJSON = OriginalSessionDescription.prototype.toJSON;
        OriginalSessionDescription.prototype.toJSON = function (...args) {
          const data = originalToJSON.apply(this, args);
          return maskIpInObject(data);
        };
      }
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
