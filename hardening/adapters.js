const { jsonFromPowerShell, runPowerShell } = require("./powershell");

function listUpAdapters() {
  const script = `
    Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq "Up" } |
    Select-Object Name, ifIndex | ConvertTo-Json
  `;
  const data = jsonFromPowerShell(script);
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function disableIPv6OnUpAdapters(options) {
  if (!options.disableIPv6) {
    return { skipped: true };
  }
  const adapters = listUpAdapters();
  const errors = [];

  for (const adapter of adapters) {
    const script = `
      Disable-NetAdapterBinding -Name "${adapter.Name}" -ComponentID ms_tcpip6 -ErrorAction Stop | Out-Null
    `;
    try {
      runPowerShell(script);
    } catch (error) {
      errors.push({ adapter: adapter.Name, error: error.message });
    }
  }

  return { skipped: false, errors };
}

function setDnsOnUpAdapters(options) {
  if (!options.setDns) {
    return { skipped: true };
  }
  if (!options.dnsServers.length) {
    return { skipped: true, warning: "DNS servers list is empty." };
  }
  const adapters = listUpAdapters();
  const errors = [];

  for (const adapter of adapters) {
    const dnsList = options.dnsServers.map((entry) => `"${entry}"`).join(", ");
    const script = `
      Set-DnsClientServerAddress -InterfaceIndex ${adapter.ifIndex} -ServerAddresses ${dnsList} -ErrorAction Stop
    `;
    try {
      runPowerShell(script);
    } catch (error) {
      errors.push({ adapter: adapter.Name, error: error.message });
    }
  }

  return { skipped: false, errors };
}

function restoreAdapters(adapters) {
  const errors = [];
  for (const adapter of adapters || []) {
    const ipv6Script = adapter.IPv6Enabled
      ? `Enable-NetAdapterBinding -Name "${adapter.Name}" -ComponentID ms_tcpip6 -ErrorAction Stop | Out-Null`
      : `Disable-NetAdapterBinding -Name "${adapter.Name}" -ComponentID ms_tcpip6 -ErrorAction Stop | Out-Null`;

    try {
      runPowerShell(ipv6Script);
    } catch (error) {
      errors.push({ adapter: adapter.Name, step: "ipv6", error: error.message });
    }

    try {
      if (adapter.DnsServers && adapter.DnsServers.length > 0) {
        const dnsList = adapter.DnsServers.map((entry) => `"${entry}"`).join(", ");
        runPowerShell(
          `Set-DnsClientServerAddress -InterfaceIndex ${adapter.IfIndex} -ServerAddresses ${dnsList} -ErrorAction Stop`
        );
      } else {
        runPowerShell(
          `Set-DnsClientServerAddress -InterfaceIndex ${adapter.IfIndex} -ResetServerAddresses -ErrorAction Stop`
        );
      }
    } catch (error) {
      errors.push({ adapter: adapter.Name, step: "dns", error: error.message });
    }
  }

  return errors;
}

module.exports = {
  listUpAdapters,
  disableIPv6OnUpAdapters,
  setDnsOnUpAdapters,
  restoreAdapters
};
