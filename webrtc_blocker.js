(function () {
  const makeErr = (msg) => Object.assign(new Error(msg), { name: "NotAllowedError" });
  const rejectNow = () => Promise.reject(makeErr("Blocked by Strong Anti-FP mode."));

  const isValidIPv4 = (value) => {
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
    const parts = value.split(".");
    return parts.every((part) => {
      if (part.length > 1 && part.startsWith("0")) return false;
      const num = Number(part);
      return Number.isInteger(num) && num >= 0 && num <= 255;
    });
  };
  const isValidIPv6 = (value) => {
    if (!/^[0-9a-f:]+$/i.test(value) || !value.includes(":")) return false;
    if (value.includes(":::")) return false;
    return true;
  };
  const isLikelyHostname = (value) => /[a-z]/i.test(value) && /[.-]/.test(value);
  const LOCAL_HOSTNAME_RE = /\b[a-z0-9-]+\.(local|lan|home|internal)\b/gi;
  const maskBareAddressToken = (value) => {
    if (typeof value !== "string") return value;
    if (isValidIPv4(value) || isValidIPv6(value) || isLikelyHostname(value)) {
      return getInjectedIp();
    }
    return value;
  };
  const maskHostPortToken = (value) => {
    if (typeof value !== "string") return value;
    const bracketMatch = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketMatch) {
      const host = bracketMatch[1];
      const port = bracketMatch[2] ? `:${bracketMatch[2]}` : "";
      const maskedHost = maskBareAddressToken(host);
      return maskedHost === host ? value : `[${maskedHost}]${port}`;
    }
    const parts = value.split(":");
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      const maskedHost = maskBareAddressToken(parts[0]);
      return maskedHost === parts[0] ? value : `${maskedHost}:${parts[1]}`;
    }
    return value;
  };
  const maskAddressToken = (value) => {
    if (typeof value !== "string") return value;
    const hostPortMasked = maskHostPortToken(value);
    if (hostPortMasked !== value) return hostPortMasked;
    return maskBareAddressToken(value);
  };
  const maskSdpAttributeToken = (token) => {
    if (typeof token !== "string" || !token.includes(":")) return token;
    const [key, rawValue] = token.split(":", 2);
    if (!rawValue) return token;
    if (key === "cname" || key === "mslabel" || key === "label") {
      const masked = maskAddressToken(rawValue);
      if (masked !== rawValue) return `${key}:${masked}`;
      const hostnameMasked = rawValue.replace(LOCAL_HOSTNAME_RE, getInjectedIp());
      if (hostnameMasked !== rawValue) return `${key}:${hostnameMasked}`;
    }
    return token;
  };

  const getInjectedIp = () => {
    const ip = String(globalThis.__PUBLIC_IP__ || "").trim();
    if (ip && (isValidIPv4(ip) || isValidIPv6(ip))) return ip;
    if (globalThis.__PUBLIC_IP_FALLBACK__) return globalThis.__PUBLIC_IP_FALLBACK__;
    const fallback = "203.0.113.1";
    try {
      Object.defineProperty(globalThis, "__PUBLIC_IP_FALLBACK__", { value: fallback });
    } catch {
      globalThis.__PUBLIC_IP_FALLBACK__ = fallback;
    }
    return fallback;
  };

  const maskIpLiteral = (value) => {
    if (typeof value !== "string") return value;
    return maskCandidate(value);
  };

  const maskCandidateLine = (line) => {
    if (typeof line !== "string") return line;
    if (!line.includes("candidate:") && !line.includes("a=candidate:")) return line;
    const replacement = getInjectedIp();
    const parts = line.split(" ");
    if (parts.length > 4) {
      parts[4] = maskAddressToken(parts[4]);
    }
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (parts[i] === "raddr") {
        parts[i + 1] = replacement;
      }
    }
    return parts.join(" ");
  };

  const maskRemoteCandidatesLine = (line) => {
    if (typeof line !== "string") return line;
    if (!line.startsWith("a=remote-candidates:") && !line.startsWith("a=local-candidates:")) return line;
    const [prefix, rest] = line.split(":", 2);
    if (!rest) return line;
    const tokens = rest.trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i += 1) {
      tokens[i] = maskAddressToken(tokens[i]);
    }
    return `${prefix}:${tokens.join(" ")}`;
  };

  const maskIceServerUrl = (url) => {
    if (typeof url !== "string") return url;
    const lower = url.toLowerCase();
    if (!lower.startsWith("stun:") && !lower.startsWith("turn:") && !lower.startsWith("turns:")) {
      return maskCandidate(url);
    }
    const replacement = getInjectedIp();
    const hostAndRest = url.slice(url.indexOf(":") + 1);
    const atIndex = hostAndRest.indexOf("@");
    const hostPortAndParams = atIndex === -1 ? hostAndRest : hostAndRest.slice(atIndex + 1);
    const [hostPort, ...rest] = hostPortAndParams.split("?");
    let host = hostPort;
    let port = "";
    if (hostPort.startsWith("[")) {
      const end = hostPort.indexOf("]");
      if (end !== -1) {
        host = hostPort.slice(1, end);
        port = hostPort.slice(end + 1).replace(/^:/, "");
      }
    } else if (hostPort.includes(":")) {
      const pieces = hostPort.split(":");
      host = pieces[0];
      port = pieces.slice(1).join(":");
    }
    const maskedHost = host ? maskAddressToken(host) : host;
    const bracketedHost = hostPort.startsWith("[") ? `[${maskedHost}]` : maskedHost;
    const rebuiltHostPort = port ? `${bracketedHost}:${port}` : bracketedHost;
    const rebuilt = [rebuiltHostPort, ...rest].join("?");
    return `${url.slice(0, url.indexOf(":") + 1)}${atIndex === -1 ? "" : hostAndRest.slice(0, atIndex + 1)}${rebuilt}`;
  };

  const maskCandidate = (candidate) => {
    if (!candidate) return candidate;
    const replacement = getInjectedIp();
    return maskCandidateLine(candidate)
      .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, replacement)
      .replace(/\b([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, replacement)
      .replace(LOCAL_HOSTNAME_RE, replacement);
  };

  const maskSdpLines = (lines) => {
    const replacement = getInjectedIp();
    return lines.map((line) => {
      if (line.startsWith("a=candidate:") || line.startsWith("candidate:")) {
        return maskCandidateLine(line)
          .replace(LOCAL_HOSTNAME_RE, replacement)
          .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, replacement)
          .replace(/\b([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, replacement);
      }
      if (line.startsWith("a=remote-candidates:") || line.startsWith("a=local-candidates:")) {
        return maskRemoteCandidatesLine(line).replace(LOCAL_HOSTNAME_RE, replacement);
      }
      if (line.startsWith("a=ssrc:")) {
        const tokens = line.split(" ");
        const next = tokens.map((token, index) => (index === 0 ? token : maskSdpAttributeToken(token)));
        return next.join(" ").replace(LOCAL_HOSTNAME_RE, replacement);
      }
      if (line.startsWith("o=")) {
        const parts = line.split(" ");
        const addrIndex = parts.findIndex((part, idx) => idx > 0 && (part === "IP4" || part === "IP6"));
        if (addrIndex !== -1 && parts[addrIndex + 1]) {
          parts[addrIndex + 1] = maskAddressToken(parts[addrIndex + 1]);
          return parts.join(" ");
        }
      }
      if (line.startsWith("c=IN IP4 ") || line.startsWith("c=IN IP6 ")) {
        const parts = line.split(" ");
        if (parts.length >= 3) parts[parts.length - 1] = maskAddressToken(parts[parts.length - 1]);
        return parts.join(" ");
      }
      if (line.startsWith("a=rtcp:")) {
        const parts = line.split(" ");
        const addrIndex = parts.findIndex((part, idx) => idx > 0 && (part === "IP4" || part === "IP6"));
        if (addrIndex !== -1 && parts[addrIndex + 1]) {
          parts[addrIndex + 1] = maskAddressToken(parts[addrIndex + 1]);
          return parts.join(" ");
        }
      }
      return maskCandidate(line).replace(LOCAL_HOSTNAME_RE, replacement);
    });
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
        copy.urls = maskIceServerUrl(copy.urls);
      } else if (Array.isArray(copy.urls)) {
        copy.urls = copy.urls.map((url) => (typeof url === "string" ? maskIceServerUrl(url) : url));
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
    const lines = String(sdp).split(/\r?\n/);
    return maskSdpLines(lines).join("\r\n");
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
