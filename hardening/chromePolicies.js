const { runPowerShell } = require("./powershell");

function ensureChromePolicyKey() {
  const script = `
    $path = "HKLM:\\SOFTWARE\\Policies\\Google\\Chrome"
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
  `;
  runPowerShell(script);
  return "HKLM:\\SOFTWARE\\Policies\\Google\\Chrome";
}

function setChromePolicyString(name, value) {
  const script = `
    New-ItemProperty -Path "${ensureChromePolicyKey()}" -Name "${name}" -Value "${value}" -PropertyType String -Force | Out-Null
  `;
  runPowerShell(script);
}

function setChromePolicyDword(name, value) {
  const script = `
    New-ItemProperty -Path "${ensureChromePolicyKey()}" -Name "${name}" -Value ${Number(value)} -PropertyType DWord -Force | Out-Null
  `;
  runPowerShell(script);
}

function removeChromePolicy(name) {
  const script = `
    Remove-ItemProperty -Path "${ensureChromePolicyKey()}" -Name "${name}" -ErrorAction SilentlyContinue
  `;
  runPowerShell(script);
}

function applyChromePolicies(options) {
  setChromePolicyString("DnsOverHttpsMode", "secure");
  setChromePolicyString("DnsOverHttpsTemplates", options.dohTemplate);

  setChromePolicyString("WebRtcIPHandlingPolicy", options.webRtcPolicy);
  removeChromePolicy("WebRtcLocalIpsAllowedUrls");

  if (options.disableQuic) {
    setChromePolicyDword("QuicAllowed", 0);
  }

  setChromePolicyDword("DefaultCameraSetting", 2);
  setChromePolicyDword("DefaultMicrophoneSetting", 2);
  setChromePolicyDword("DefaultGeolocationSetting", 2);
  setChromePolicyDword("DefaultNotificationsSetting", 2);
  setChromePolicyDword("DefaultPopupsSetting", 2);
  setChromePolicyDword("DefaultSensorsSetting", 2);

  setChromePolicyDword("DefaultWebBluetoothGuardSetting", 2);
  setChromePolicyDword("DefaultUsbGuardSetting", 2);
  setChromePolicyDword("DefaultSerialGuardSetting", 2);
  setChromePolicyDword("DefaultHidGuardSetting", 2);

  setChromePolicyDword("DefaultFileSystemReadGuardSetting", 2);
  setChromePolicyDword("DefaultFileSystemWriteGuardSetting", 2);

  setChromePolicyDword("BackgroundModeEnabled", 0);

  if (options.forceProxy) {
    setChromePolicyString("ProxyMode", "fixed_servers");
    setChromePolicyString("ProxyServer", options.proxyServer);
    setChromePolicyString("ProxyBypassList", options.proxyBypassList || "");
  } else {
    removeChromePolicy("ProxyMode");
    removeChromePolicy("ProxyServer");
    removeChromePolicy("ProxyBypassList");
  }
}

function clearChromePolicies() {
  const namesToClear = [
    "DnsOverHttpsMode",
    "DnsOverHttpsTemplates",
    "WebRtcIPHandlingPolicy",
    "WebRtcLocalIpsAllowedUrls",
    "QuicAllowed",
    "DefaultCameraSetting",
    "DefaultMicrophoneSetting",
    "DefaultGeolocationSetting",
    "DefaultNotificationsSetting",
    "DefaultPopupsSetting",
    "DefaultSensorsSetting",
    "DefaultWebBluetoothGuardSetting",
    "DefaultUsbGuardSetting",
    "DefaultSerialGuardSetting",
    "DefaultHidGuardSetting",
    "DefaultFileSystemReadGuardSetting",
    "DefaultFileSystemWriteGuardSetting",
    "BackgroundModeEnabled",
    "ProxyMode",
    "ProxyServer",
    "ProxyBypassList"
  ];

  const errors = [];
  for (const name of namesToClear) {
    try {
      removeChromePolicy(name);
    } catch (error) {
      errors.push({ name, error: error.message });
    }
  }

  return errors;
}

function restoreChromePolicies(values) {
  const errors = [];
  for (const [name, value] of Object.entries(values || {})) {
    try {
      if (Number.isInteger(value)) {
        setChromePolicyDword(name, value);
      } else {
        setChromePolicyString(name, String(value));
      }
    } catch (error) {
      errors.push({ name, error: error.message });
    }
  }

  return errors;
}

module.exports = {
  applyChromePolicies,
  clearChromePolicies,
  restoreChromePolicies
};
