# Maintainer-only first-artifact controller. Run in an independently owned,
# resource-limited Windows host. Job enforcement starts before Node resumes;
# PowerShell/.NET controller preparation still needs the host's outer deadline.
param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or [IntPtr]::Size -ne 8) {
  throw 'Bootstrap controller requires Windows64'
}
$helper = Join-Path $PSScriptRoot 'Brc38WindowsBootstrapDirectory.ps1'
$toolbox = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$held = [System.Collections.Generic.List[System.IO.FileStream]]::new()
$failures = [System.Collections.Generic.List[string]]::new()
$result = $null
$root = $null
function Assert-LocalCoordinate([string]$Name) {
  if ($Name.Length -gt 2048 -or $Name -notmatch '^[A-Za-z]:\\' -or
      $Name -match '[\x00-\x1f"<>|?*]' -or
      -not [String]::Equals([System.IO.Path]::GetFullPath($Name), $Name, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Bootstrap controller coordinate differs'
  }
  foreach ($part in $Name.Substring(3).Split('\')) {
    if ($part.Length -eq 0 -or $part -match '[. ]$' -or $part.Contains(':') -or
        $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
      throw 'Bootstrap coordinate has a Windows alias'
    }
  }
  $item = [System.IO.FileInfo]::new($Name)
  if (-not $item.Exists -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Bootstrap input is absent or reparsed'
  }
  for ($ancestor = $item.Directory; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    if (($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Bootstrap input has a reparse ancestor'
    }
  }
}
function Open-FrozenInput([string]$Name, [long]$Maximum, $Expected) {
  Assert-LocalCoordinate $Name
  # Exclude mutation/deletion while original configuration/source/Node is used.
  $file = [System.IO.FileStream]::new($Name, [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  $held.Add($file)
  if ($file.Length -lt 1 -or $file.Length -gt $Maximum) { throw 'Bootstrap input extent differs' }
  $hash = Get-InputHash $file
  if ($null -ne $Expected -and ($Expected.bytes -ne $file.Length -or
      $Expected.sha256 -notmatch '^[0-9a-f]{64}$' -or $Expected.sha256 -cne $hash)) {
    throw 'Bootstrap frozen input differs'
  }
  return $file
}
function Get-InputHash([System.IO.FileStream]$File) {
  $File.Position = 0
  $digest = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($digest.ComputeHash($File)).Replace('-', '').ToLowerInvariant() }
  finally { $digest.Dispose(); $File.Position = 0 }
  return $hash
}
function Read-InputText([System.IO.FileStream]$File) {
  $File.Position = 0
  $bytes = [byte[]]::new([int]$File.Length)
  $at = 0
  while ($at -lt $bytes.Length) {
    $read = $File.Read($bytes, $at, $bytes.Length - $at)
    if ($read -eq 0) { throw 'Bootstrap input truncated' }
    $at += $read
  }
  $File.Position = 0
  return [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
}
function Assert-PE([System.IO.FileStream]$File, [string]$Architecture, [bool]$DLL) {
  if ($File.Length -lt 328) { throw 'Bootstrap image extent differs' }
  $bytes = [byte[]]::new(64)
  if ($File.Read($bytes, 0, 64) -ne 64 -or $bytes[0] -ne 77 -or $bytes[1] -ne 90) {
    throw 'Bootstrap image DOS header differs'
  }
  $offset = [BitConverter]::ToUInt32($bytes, 60)
  if ($offset -lt 64 -or $offset -gt $File.Length - 264) { throw 'Bootstrap image PE offset differs' }
  $File.Position = $offset
  $bytes = [byte[]]::new(264)
  if ($File.Read($bytes, 0, 264) -ne 264 -or [BitConverter]::ToUInt32($bytes, 0) -ne 17744 -or
      [BitConverter]::ToUInt16($bytes, 24) -ne 523) { throw 'Bootstrap image PE32+ header differs' }
  $machine = if ($Architecture -eq 'arm64') { 43620 } else { 34404 }
  $characteristics = [BitConverter]::ToUInt16($bytes, 22)
  if ([BitConverter]::ToUInt16($bytes, 4) -ne $machine -or
      [BitConverter]::ToUInt16($bytes, 20) -lt 112 -or
      $offset + 24 + [BitConverter]::ToUInt16($bytes, 20) -gt $File.Length -or
      ($characteristics -band 2) -eq 0 -or (($characteristics -band 8192) -ne 0) -ne $DLL) {
    throw 'Bootstrap image target or executable kind differs'
  }
  $File.Position = 0
}
function Write-NewRecord([string]$Name, $Value) {
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 32 -Compress) + "`n")
  if ($bytes.Length -gt 1048576) { throw 'Bootstrap record extent differs' }
  $file = [System.IO.FileStream]::new($Name, [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $writeFailure = $null
  try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) }
  catch { $writeFailure = $_.Exception }
  try { $file.Dispose() }
  catch {
    if ($null -ne $writeFailure) { $failures.Add($writeFailure.Message) }
    throw
  }
  if ($null -ne $writeFailure) { throw $writeFailure }
}
try {
  Assert-LocalCoordinate $Configuration
  $parent = [System.IO.Path]::GetDirectoryName($Configuration)
  $privacy = (& $helper -Mode Inspect -Directory $parent) | ConvertFrom-Json
  if ($privacy.protectedActorOnly -ne $true) { throw 'Bootstrap configuration parent is not private' }
  $configurationFile = Open-FrozenInput $Configuration 1048576 $null
  $configurationHash = Get-InputHash $configurationFile
  $options = (Read-InputText $configurationFile) | ConvertFrom-Json
  if ($options.architecture -notin @('arm64','x64') -or $options.bootstrap.architecture -cne $options.architecture -or
      $options.bootstrap.outputDirectory -cne $parent) { throw 'Bootstrap configuration target or parent differs' }
  $expectedPaths = @('tools/Brc38WindowsBootstrapWorker.cjs','tools/Brc38WindowsBootstrapController.ps1',
    'tools/Brc38WindowsBootstrapJob.cs','tools/Brc38WindowsBootstrapBuild.cjs',
    'tools/Brc38WindowsBootstrapDirectory.ps1','tools/Brc38WindowsCandidateBuild.cjs',
    'tools/Brc38NativeCandidateBuild.cjs','src/storage/portable/native/prepare_source.cjs',
    'src/storage/portable/native/source_recipe.cjs')
  if ($options.controllerInputs.Count -ne $expectedPaths.Count) { throw 'Bootstrap controller cohort differs' }
  $sourceFiles = [System.Collections.Generic.List[System.IO.FileStream]]::new()
  for ($i = 0; $i -lt $expectedPaths.Count; $i++) {
    $controllerInput = $options.controllerInputs[$i]
    if ($controllerInput.path -cne $expectedPaths[$i]) { throw 'Bootstrap controller cohort path differs' }
    $sourceFiles.Add((Open-FrozenInput (Join-Path $toolbox $controllerInput.path) 1048576 $controllerInput))
  }
  if ([System.IO.Path]::GetFileName($options.nodeExecutable.filename) -ine 'node.exe') {
    throw 'Bootstrap Node executable differs'
  }
  $nodeFile = Open-FrozenInput $options.nodeExecutable.filename 134217728 $options.nodeExecutable
  Assert-PE $nodeFile $options.architecture $false
  $root = ((& $helper -Mode Create -Directory $parent) | ConvertFrom-Json).directory
  $options.bootstrap.outputDirectory = $root
  $workerOptions = Join-Path $root 'worker-options.json'
  Write-NewRecord $workerOptions $options
  $optionsFile = Open-FrozenInput $workerOptions 1048576 $null
  # Compile only authored managed controller code, never candidate native bytes.
  # The independent host owns this preparation's deadline/resources as well.
  Add-Type -TypeDefinition (Read-InputText $sourceFiles[2]) -ErrorAction Stop
  if ($env:SystemRoot -notmatch '^[A-Za-z]:\\Windows$') { throw 'Bootstrap system directory differs' }
  $job = [Brc38WindowsBootstrapJob]::Run($options.nodeExecutable.filename,
    (Join-Path $PSScriptRoot 'Brc38WindowsBootstrapWorker.cjs'), $workerOptions, $root, $env:SystemRoot)
  $result = [ordered]@{protocol='brc38-windows-bootstrap-controller/v1';configurationSha256=$configurationHash;
    job=$job;worker=$null;candidates=@();sourceInputs=$options.controllerInputs;
    qualified=$false;runtimePinChanged=$false;engineOrAddonExecuted=$false;VMShutdownObserved=$false}
  # Actual original Job observations precede every result/artifact readback.
  if ($job.OriginalProcessWorkerStopped) {
    for ($i = 0; $i -lt $sourceFiles.Count; $i++) {
      if ((Get-InputHash $sourceFiles[$i]) -cne $options.controllerInputs[$i].sha256) {
        throw 'Bootstrap controller source postimage differs'
      }
    }
    if ((Get-InputHash $configurationFile) -cne $configurationHash -or
        (Get-InputHash $nodeFile) -cne $options.nodeExecutable.sha256) { throw 'Bootstrap original input postimage differs' }
    $workerFile = Open-FrozenInput (Join-Path $root 'worker-result.json') 1048576 $null
    $worker = (Read-InputText $workerFile) | ConvertFrom-Json
    $result.worker = $worker
    if ($job.Success -and $worker.protocol -ceq 'brc38-windows-bootstrap-worker/v1' -and $worker.success -eq $true -and
        $worker.qualified -eq $false -and $worker.runtimePinChanged -eq $false) {
      if ([System.IO.Path]::GetDirectoryName($worker.directory) -cne $root -or
          $worker.receipt.protocol -cne 'brc38-windows-bootstrap-build/v1' -or
          $worker.receipt.qualified -ne $false -or $worker.receipt.runtimePinChanged -ne $false -or
          $worker.receipt.engineOrAddonOrSupervisorExecuted -ne $false -or $worker.receipt.candidates.Count -ne 2) {
        throw 'Bootstrap worker result differs'
      }
      (& $helper -Mode Inspect -Directory $worker.directory) | Out-Null
      $candidates = @()
      for ($i = 0; $i -lt 2; $i++) {
        $candidateInput = $worker.receipt.candidates[$i]
        if ($candidateInput.path -cne @('brc38-build-supervisor.exe','brc38_windows.node')[$i]) { throw 'Bootstrap candidate path differs' }
        $image = Open-FrozenInput (Join-Path $worker.directory $candidateInput.path) 2097152 $candidateInput
        Assert-PE $image $options.architecture ($i -eq 1)
        $candidates += [ordered]@{path=$candidateInput.path;bytes=$image.Length;sha256=(Get-InputHash $image)}
      }
      $result.candidates = $candidates
    } else { $failures.Add('Bootstrap original worker or build failed') }
  } else { $failures.Add('Original Windows worker remains unproved; independent host shutdown required') }
}
catch { $failures.Add($_.Exception.Message) }
finally {
  # Retain every owned build directory, including failures. No generic tree rm.
  for ($i = $held.Count - 1; $i -ge 0; $i--) {
    try { $held[$i].Dispose() } catch { $failures.Add($_.Exception.Message) }
  }
}
if ($null -ne $root -and $null -ne $result) {
  $result.controllerErrors = @($failures.ToArray())
  $result.controllerFilesClosed = ($failures.Count -eq 0)
  Write-NewRecord (Join-Path $root 'controller-result.json') $result
  [ordered]@{protocol='brc38-windows-bootstrap-controller-location/v1';directory=$root;
    success=($failures.Count -eq 0);qualified=$false;runtimePinChanged=$false} | ConvertTo-Json -Compress
}
if ($failures.Count -ne 0) { throw ($failures -join '; ') }
