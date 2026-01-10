const {
  DEFAULT_HARDENING_OPTIONS,
  normalizeHardeningOptions
} = require("./defaults");
const { applyHardening, rollbackHardening } = require("./index");

function parseArgs(argv) {
  const options = { ...DEFAULT_HARDENING_OPTIONS };
  let rollback = false;

  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [flag, value] = raw.replace(/^--/, "").split("=");

    switch (flag) {
      case "rollback":
        rollback = true;
        break;
      case "disable-ipv6":
        options.disableIPv6 = true;
        break;
      case "no-disable-ipv6":
        options.disableIPv6 = false;
        break;
      case "set-dns":
        options.setDns = true;
        break;
      case "no-set-dns":
        options.setDns = false;
        break;
      case "dns-servers":
        options.dnsServers = value || "";
        break;
      case "doh-template":
        options.dohTemplate = value || "";
        break;
      case "webrtc-policy":
        options.webRtcPolicy = value || "";
        break;
      case "disable-quic":
        options.disableQuic = true;
        break;
      case "no-disable-quic":
        options.disableQuic = false;
        break;
      case "force-proxy":
        options.forceProxy = true;
        break;
      case "no-force-proxy":
        options.forceProxy = false;
        break;
      case "proxy-server":
        options.proxyServer = value || "";
        break;
      case "proxy-bypass-list":
        options.proxyBypassList = value || "";
        break;
      default:
        break;
    }
  }

  return { rollback, options: normalizeHardeningOptions(options) };
}

function runCli(argv = process.argv.slice(2)) {
  const { rollback, options } = parseArgs(argv);
  if (rollback) {
    rollbackHardening();
    console.log("[OK] Rollback complete. Restart Chrome.");
    return;
  }

  applyHardening(options);
  console.log("[OK] Hardening applied. Restart Chrome and verify chrome://policy");
  console.log("Test: https://browserleaks.com/ip");
  console.log("Rollback: node scripts/chrome-hardening.js --rollback");
}

module.exports = {
  parseArgs,
  runCli
};
