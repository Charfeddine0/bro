const DEFAULT_HARDENING_OPTIONS = {
  disableIPv6: true,
  setDns: true,
  dnsServers: ["1.1.1.1", "1.0.0.1"],
  dohTemplate: "https://cloudflare-dns.com/dns-query",
  webRtcPolicy: "default_public_interface_only",
  disableQuic: true,
  forceProxy: false,
  proxyServer: "http=127.0.0.1:8080;https=127.0.0.1:8080",
  proxyBypassList: ""
};

const ALLOWED_WEBRTC_POLICIES = new Set([
  "default_public_interface_only",
  "disable_non_proxied_udp"
]);

function normalizeHardeningOptions(input = {}) {
  const merged = { ...DEFAULT_HARDENING_OPTIONS, ...(input || {}) };
  return {
    disableIPv6: Boolean(merged.disableIPv6),
    setDns: Boolean(merged.setDns),
    dnsServers: Array.isArray(merged.dnsServers)
      ? merged.dnsServers.map((entry) => String(entry).trim()).filter(Boolean)
      : String(merged.dnsServers || "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
    dohTemplate: String(merged.dohTemplate || ""),
    webRtcPolicy: String(merged.webRtcPolicy || ""),
    disableQuic: Boolean(merged.disableQuic),
    forceProxy: Boolean(merged.forceProxy),
    proxyServer: String(merged.proxyServer || ""),
    proxyBypassList: String(merged.proxyBypassList || "")
  };
}

function validateHardeningOptions(options) {
  if (!ALLOWED_WEBRTC_POLICIES.has(options.webRtcPolicy)) {
    throw new Error(
      `Invalid webRtcPolicy. Use: ${Array.from(ALLOWED_WEBRTC_POLICIES).join(", ")}`
    );
  }
}

module.exports = {
  DEFAULT_HARDENING_OPTIONS,
  ALLOWED_WEBRTC_POLICIES,
  normalizeHardeningOptions,
  validateHardeningOptions
};
