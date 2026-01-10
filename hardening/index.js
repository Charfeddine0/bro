const {
  DEFAULT_HARDENING_OPTIONS,
  normalizeHardeningOptions,
  validateHardeningOptions
} = require("./defaults");
const { ensureWindows, assertAdmin } = require("./powershell");
const { backupState, readState } = require("./state");
const {
  disableIPv6OnUpAdapters,
  setDnsOnUpAdapters,
  restoreAdapters
} = require("./adapters");
const {
  applyChromePolicies,
  clearChromePolicies,
  restoreChromePolicies
} = require("./chromePolicies");

function applyHardening(rawOptions = {}) {
  ensureWindows();
  assertAdmin();
  const options = normalizeHardeningOptions(rawOptions);
  validateHardeningOptions(options);

  const stateFile = backupState();
  const ipv6Result = disableIPv6OnUpAdapters(options);
  const dnsResult = setDnsOnUpAdapters(options);
  applyChromePolicies(options);

  return {
    ok: true,
    stateFile,
    ipv6Result,
    dnsResult
  };
}

function rollbackHardening() {
  ensureWindows();
  assertAdmin();
  const state = readState();
  if (!state) {
    throw new Error("No backup found. Run apply first to create a backup.");
  }

  const adapterErrors = restoreAdapters(state.Adapters);
  const policyErrors = clearChromePolicies();
  const restoreErrors = restoreChromePolicies(state.Chrome?.Values || {});

  return {
    ok: true,
    adapterErrors,
    policyErrors,
    restoreErrors
  };
}

module.exports = {
  DEFAULT_HARDENING_OPTIONS,
  normalizeHardeningOptions,
  applyHardening,
  rollbackHardening
};
