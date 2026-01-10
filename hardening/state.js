const fs = require("fs");
const path = require("path");
const { jsonFromPowerShell } = require("./powershell");

function getStateFile() {
  const base = process.env.ProgramData || "C:\\ProgramData";
  return path.join(base, "ChromeHardeningBackup", "state.json");
}

function ensureStateDir() {
  const stateFile = getStateFile();
  const stateDir = path.dirname(stateFile);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  return stateFile;
}

function backupState() {
  const stateFile = ensureStateDir();
  const script = `
    $adapters = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq "Up" }
    $snapAdapters = @()
    foreach ($a in $adapters) {
      $ipv6Binding = Get-NetAdapterBinding -Name $a.Name -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue
      $dns = Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
      $snapAdapters += [pscustomobject]@{
        Name = $a.Name
        IfIndex = $a.ifIndex
        IPv6Enabled = [bool]($ipv6Binding.Enabled)
        DnsServers = @($dns.ServerAddresses)
      }
    }
    $chromePolicyPath = "HKLM:\\SOFTWARE\\Policies\\Google\\Chrome"
    $chromeSnap = [ordered]@{ Exists = (Test-Path $chromePolicyPath); Values = @{} }
    if (Test-Path $chromePolicyPath) {
      $props = (Get-ItemProperty -Path $chromePolicyPath -ErrorAction SilentlyContinue).PSObject.Properties
      foreach ($p in $props) {
        if ($p.Name -in "PSPath","PSParentPath","PSChildName","PSDrive","PSProvider") { continue }
        $chromeSnap.Values[$p.Name] = $p.Value
      }
    }
    $full = [pscustomobject]@{
      Timestamp = (Get-Date).ToString("o")
      Adapters = $snapAdapters
      Chrome = $chromeSnap
    }
    $full | ConvertTo-Json -Depth 10
  `;

  const state = jsonFromPowerShell(script);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

function readState() {
  const stateFile = getStateFile();
  if (!fs.existsSync(stateFile)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

module.exports = {
  getStateFile,
  backupState,
  readState
};
