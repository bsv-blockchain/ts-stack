# Maintainer source route only. Requires a separately admitted Hyper-V host and
# an existing, operator-prepared disposable guest. Never creates/configures VMs,
# admits runtime artifacts, installs host tools or serializes guest credentials.
param([Parameter(Mandatory=$true)][string]$Configuration,
      [Parameter(Mandatory=$true)][System.Management.Automation.PSCredential]$GuestCredential)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or [IntPtr]::Size -ne 8 -or
    $PSVersionTable.PSVersion.Major -lt 5) { throw 'Hyper-V bootstrap requires its admitted Windows64 host' }
Import-Module Hyper-V -ErrorAction Stop
Import-Module ScheduledTasks -ErrorAction Stop
$held = [System.Collections.Generic.List[System.IO.FileStream]]::new()
$errors = [System.Collections.Generic.List[string]]::new()
$vm = $null; $worker = $null; $job = $null; $order = $null
$watchdogRegistered = $false; $startAttempted = $false; $stopped = $false
$guest = $null; $taskName = $null; $encoded = $null; $hostExecutable = $null
$memoryBytes = 17179869184L; $CPUCount = 4; $deadlineMilliseconds = 1200000; $drainMilliseconds = 30000
function Assert-Coordinate([string]$Name) {
  if ($Name.Length -gt 2048 -or $Name -notmatch '^[A-Za-z]:\\' -or $Name -match '[\x00-\x1f"<>|?*]' -or
      -not [String]::Equals([IO.Path]::GetFullPath($Name), $Name, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Host bootstrap coordinate differs'
  }
  foreach ($part in $Name.Substring(3).Split('\')) {
    if ($part.Length -eq 0 -or $part -match '[. ]$' -or $part.Contains(':') -or
        $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Host bootstrap coordinate aliases a file' }
  }
}
function Hash-Input([IO.FileStream]$File) {
  $File.Position = 0; $digest = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($digest.ComputeHash($File)).Replace('-','').ToLowerInvariant() }
  finally { $digest.Dispose(); $File.Position = 0 }
}
function Open-Input([string]$Name, $Pin) {
  Assert-Coordinate $Name
  $item = [IO.FileInfo]::new($Name)
  if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Host input absent or reparsed' }
  for ($ancestor = $item.Directory; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Host input reparse ancestor' }
  }
  $file = [IO.FileStream]::new($Name, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $held.Add($file)
  if ($file.Length -lt 1 -or $file.Length -gt 1048576) { throw 'Host input extent differs' }
  if ($null -ne $Pin -and ($Pin.bytes -ne $file.Length -or $Pin.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
      (Hash-Input $file) -cne $Pin.sha256)) { throw 'Host input fixed bytes differ' }
  return $file
}
function Read-Text([IO.FileStream]$File) {
  $bytes = [byte[]]::new([int]$File.Length); $at = 0; $File.Position = 0
  while ($at -lt $bytes.Length) {
    $read = $File.Read($bytes, $at, $bytes.Length - $at)
    if ($read -eq 0) { throw 'Host input truncated' }; $at += $read
  }
  $File.Position = 0
  return [Text.UTF8Encoding]::new($false,$true).GetString($bytes)
}
function System-VM {
  $rows = @(Get-CimInstance -Namespace root/virtualization/v2 -ClassName Msvm_ComputerSystem -Filter "Name = '$($order.vmId)'" -OperationTimeoutSec 5)
  if ($rows.Count -ne 1 -or $null -eq $rows[0].ProcessID -or $rows[0].HealthState -ne 5) { throw 'Original VM system observation differs' }
  return $rows[0]
}
function Owned-VM {
  $rows = @(Get-VM -Id ([Guid]$order.vmId) -ErrorAction Stop)
  if ($rows.Count -ne 1 -or $rows[0].Id.ToString() -cne $order.vmId -or
      $rows[0].Name -cne ('ts569-native-windows-bootstrap-' + $order.runId) -or
      $rows[0].Notes -cne ('brc38-bootstrap/' + $order.runId)) { throw 'Original disposable VM ownership differs' }
  return $rows[0]
}
function Assert-VMEnvelope {
  $actual = Owned-VM
  $memory = Get-VMMemory -VM $actual -ErrorAction Stop
  $cpu = Get-VMProcessor -VM $actual -ErrorAction Stop
  if ($memory.DynamicMemoryEnabled -ne $false -or $memory.Startup -ne $memoryBytes -or $cpu.Count -ne $CPUCount -or
      $cpu.ExposeVirtualizationExtensions -ne $false -or $cpu.Maximum -ne 100 -or
      $actual.AutomaticStartAction.ToString() -ne 'Nothing' -or $actual.AutomaticStopAction.ToString() -ne 'TurnOff' -or
      $actual.AutomaticCheckpointsEnabled -ne $false -or @(Get-VMSnapshot -VM $actual -ErrorAction Stop).Count -ne 0 -or
      @(Get-VMNetworkAdapter -VM $actual -ErrorAction Stop).Count -ne 0) { throw 'Actual guest resource/network/lifetime settings differ' }
  # This maintainer adapter currently requires the documented English service
  # name. Other host locales must be qualified explicitly, never guessed.
  # No host file-copy integration, pass-through disks or host clipboard session.
  $copy = @(Get-VMIntegrationService -VM $actual -ErrorAction Stop | Where-Object { $_.Name -ceq 'Guest Service Interface' })
  if ($copy.Count -ne 1 -or $copy[0].Enabled -ne $false) { throw 'Guest host-file-copy integration is not disabled' }
  $disks = @(Get-VMHardDiskDrive -VM $actual -ErrorAction Stop)
  if ($disks.Count -lt 1) { throw 'Disposable guest has no retained local disk' }
  foreach ($disk in $disks) {
    if ([String]::IsNullOrEmpty($disk.Path) -or $null -ne $disk.DiskNumber) { throw 'Host pass-through disk refused' }
    Assert-Coordinate $disk.Path
    $file = [IO.FileInfo]::new($disk.Path)
    if (-not $file.Exists -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Guest disk absent or reparsed' }
    for ($parent = $file.Directory; $null -ne $parent; $parent = $parent.Parent) {
      if (($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Guest disk reparse ancestor' }
    }
  }
}
function Original-ProcessPresent {
  if ($null -eq $worker) { return $false }
  $rows = @(Get-CimInstance Win32_Process -Filter "ProcessId = $($worker.pid)" -OperationTimeoutSec 5)
  if ($rows.Count -eq 0) { return $false }
  if ($rows.Count -ne 1 -or $null -eq $rows[0].CreationDate) { throw 'Original VM process observation unavailable' }
  # A reused numeric PID is not the original process and is never terminated.
  return $rows[0].CreationDate.ToUniversalTime().Ticks -eq $worker.createdTicks
}
function Assert-Watchdog {
  $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
  $sid = if ($task.Principal.UserId -match '^S-') { [Security.Principal.SecurityIdentifier]::new($task.Principal.UserId).Value } else { [Security.Principal.NTAccount]::new($task.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value }
  if ($sid -ne 'S-1-5-18' -or $task.Principal.RunLevel.ToString() -ne 'Highest' -or $task.Actions.Count -ne 1 -or
      $task.Actions[0].Execute -cne $hostExecutable -or $task.Actions[0].Arguments -cne ('-NoProfile -NonInteractive -EncodedCommand ' + $encoded) -or
      $task.Triggers.Count -ne 1 -or $task.Settings.StartWhenAvailable -ne $true -or
      $task.Settings.DisallowStartIfOnBatteries -ne $false -or $task.Settings.StopIfGoingOnBatteries -ne $false -or
      [Xml.XmlConvert]::ToTimeSpan($task.Settings.ExecutionTimeLimit).TotalSeconds -ne 60 -or
      [Math]::Abs(([DateTimeOffset]::Parse($task.Triggers[0].StartBoundary).UtcDateTime - $watchdogAt.ToUniversalTime()).TotalSeconds) -gt 2) {
    throw 'Independent actual shutdown watchdog differs'
  }
}
try {
  Assert-Coordinate $Configuration
  $privacy = (& (Join-Path $PSScriptRoot 'Brc38WindowsBootstrapDirectory.ps1') -Mode Inspect -Directory ([IO.Path]::GetDirectoryName($Configuration))) | ConvertFrom-Json
  if ($privacy.protectedActorOnly -ne $true) { throw 'Host work-order parent is not private' }
  $config = Open-Input $Configuration $null; $configurationHash = Hash-Input $config
  $order = (Read-Text $config) | ConvertFrom-Json
  $fields = @('protocol','runId','vmId','architecture','guestActorSid','hostController','guestController','guestConfiguration')
  if (@($order.PSObject.Properties).Count -ne $fields.Count -or $order.protocol -cne 'brc38-windows-bootstrap-host-work-order/v1' -or
      $order.runId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $order.vmId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
      [Guid]$order.runId -eq [Guid]::Empty -or [Guid]$order.vmId -eq [Guid]::Empty -or
      $order.architecture -notin @('arm64','x64') -or $order.guestActorSid -cnotmatch '^S-1-5-21(-[1-9][0-9]{0,9}){4}$') {
    throw 'Host work-order target or actor differs'
  }
  foreach ($part in $order.guestActorSid.Split('-')[4..7]) { if ([UInt64]$part -gt 4294967295) { throw 'Guest SID extent differs' } }
  foreach ($name in $fields) { if ($null -eq $order.PSObject.Properties[$name]) { throw 'Host work-order field absent' } }
  foreach ($pin in @($order.hostController, $order.guestController, $order.guestConfiguration)) {
    if (($pin.bytes -isnot [int] -and $pin.bytes -isnot [long]) -or $pin.bytes -lt 1 -or $pin.bytes -gt 1048576 -or
        $pin.sha256 -isnot [string] -or $pin.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Host source pin type or extent differs' }
  }
  $source = Open-Input $PSCommandPath $order.hostController
  foreach ($input in @($order.guestController, $order.guestConfiguration)) {
    Assert-Coordinate $input.filename
    if ($input.bytes -lt 1 -or $input.bytes -gt 1048576 -or $input.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Guest input pin differs' }
  }
  if ([IO.Path]::GetFileName($order.guestController.filename) -cne 'Brc38WindowsBootstrapController.ps1' -or
      $order.guestController.filename -ceq $order.guestConfiguration.filename) { throw 'Guest reviewed controller coordinate differs' }
  $vm = Owned-VM; Assert-VMEnvelope; $system = System-VM
  if ($vm.State.ToString() -ne 'Off' -or $system.EnabledState -ne 3 -or $system.ProcessID -ne 0 -or
      (Get-VMHost -ErrorAction Stop).EnableEnhancedSessionMode -ne $false) { throw 'Disposable VM not independently stopped or host permits enhanced sessions' }
  if ($env:SystemRoot -notmatch '^[A-Za-z]:\\Windows$') { throw 'Host system root differs' }
  $hostExecutable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $taskName = 'ts569-bootstrap-stop-' + $order.runId
  # A fresh SYSTEM task is outside this controller and guest. No Force/replace;
  # keep it until the original VM/process is independently observed gone.
  $watch = "`$ErrorActionPreference='Stop';Import-Module Hyper-V;`$v=Get-VM -Id '$($order.vmId)';if(`$v.Id.ToString() -cne '$($order.vmId)' -or `$v.Name -cne 'ts569-native-windows-bootstrap-$($order.runId)' -or `$v.Notes -cne 'brc38-bootstrap/$($order.runId)'){throw 'Original VM differs'};if(`$v.State.ToString() -ne 'Off'){Stop-VM -VM `$v -TurnOff -Confirm:`$false}"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watch))
  $watchdogAt = [DateTime]::Now.AddMilliseconds($deadlineMilliseconds)
  $action = New-ScheduledTaskAction -Execute $hostExecutable -Argument ('-NoProfile -NonInteractive -EncodedCommand ' + $encoded)
  $trigger = New-ScheduledTaskTrigger -Once -At $watchdogAt
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromSeconds(60))
  if (@(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -ceq $taskName }).Count -ne 0) { throw 'Existing shutdown watchdog belongs to a prior run' }
  # Registration may succeed before an observation fails: retain it conservatively.
  $watchdogRegistered = $true
  Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -ErrorAction Stop | Out-Null
  Assert-Watchdog
  $clock = [Diagnostics.Stopwatch]::StartNew(); $beganUTC = [DateTime]::UtcNow
  $startAttempted = $true; Start-VM -VM $vm -ErrorAction Stop | Out-Null
  $system = System-VM
  $process = @(Get-CimInstance Win32_Process -Filter "ProcessId = $($system.ProcessID)" -OperationTimeoutSec 5)
  if ($system.EnabledState -ne 2 -or $system.EnhancedSessionModeState -ne 3 -or $system.ProcessID -eq 0 -or
      $process.Count -ne 1 -or $null -eq $process[0].CreationDate -or $process[0].Name -ine 'vmwp.exe') { throw 'Original VM process or enhanced-session observation differs' }
  $worker = [ordered]@{pid=[UInt32]$system.ProcessID;createdTicks=$process[0].CreationDate.ToUniversalTime().Ticks}
  Assert-VMEnvelope; Assert-Watchdog
  # The complete guest PowerShell/helper/Add-Type preparation is already inside
  # the VM enclosure before the existing nested Node/compiler Job is prepared.
  $job = Invoke-Command -VMId ([Guid]$order.vmId) -Credential $GuestCredential -AsJob -ArgumentList $order -ScriptBlock {
    param($expected)
    $ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($identity.IsSystem -or $identity.User.Value -cne $expected.guestActorSid -or
        $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
        [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or [IntPtr]::Size -ne 8 -or
        [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant() -cne $expected.architecture) {
      throw 'Guest ordinary actor or actual OS architecture differs'
    }
    $files = [Collections.Generic.List[IO.FileStream]]::new()
    try {
      foreach ($input in @($expected.guestController, $expected.guestConfiguration)) {
        $item = [IO.FileInfo]::new($input.filename)
        if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Guest input absent or reparsed' }
        for ($parent = $item.Directory; $null -ne $parent; $parent = $parent.Parent) {
          if (($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Guest input reparse ancestor' }
        }
        $file = [IO.FileStream]::new($input.filename, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); $files.Add($file)
        if ($file.Length -ne $input.bytes) { throw 'Guest original input extent differs' }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($sha.ComputeHash($file)).Replace('-','').ToLowerInvariant() }
        finally { $sha.Dispose(); $file.Position = 0 }
        if ($hash -cne $input.sha256) { throw 'Guest original source digest differs' }
      }
      $lines = @(& $expected.guestController.filename -Configuration $expected.guestConfiguration.filename)
      if ($lines.Count -ne 1 -or ([string]$lines[0]).Length -gt 1048576) { throw 'Guest bounded controller location differs' }
      $location = $lines[0] | ConvertFrom-Json
      if ($location.protocol -cne 'brc38-windows-bootstrap-controller-location/v1' -or $location.success -ne $true -or
          $location.qualified -ne $false -or $location.runtimePinChanged -ne $false) { throw 'Guest build failed or claimed qualification' }
      return [ordered]@{protocol='brc38-windows-bootstrap-guest-location/v1';location=$location;ordinaryActorChecked=$true;qualified=$false}
    } finally { for ($i=$files.Count-1; $i -ge 0; $i--) { $files[$i].Dispose() } }
  }
  while ($job.State.ToString() -in @('NotStarted','Running')) {
    if ($clock.ElapsedMilliseconds -ge $deadlineMilliseconds -or
        [Math]::Abs(([DateTime]::UtcNow - $beganUTC).TotalMilliseconds - $clock.ElapsedMilliseconds) -gt 5000) { throw 'Outer guest deadline or host clock changed' }
    Assert-VMEnvelope; Assert-Watchdog
    if (-not (Original-ProcessPresent) -or (Owned-VM).State.ToString() -ne 'Running') { throw 'Original VM stopped during preparation' }
    Start-Sleep -Milliseconds 100
  }
  if ($job.State.ToString() -ne 'Completed' -or $clock.ElapsedMilliseconds -ge $deadlineMilliseconds) { throw 'Guest preparation job failed or exceeded its deadline' }
  $values = @(Receive-Job -Job $job -ErrorAction Stop)
  if ($values.Count -ne 1 -or $values[0].protocol -cne 'brc38-windows-bootstrap-guest-location/v1') { throw 'Guest output extent or protocol differs' }
  $guest = $values[0]
  if ((Hash-Input $config) -cne $configurationHash -or (Hash-Input $source) -cne $order.hostController.sha256) { throw 'Original host source/config postimage differs' }
}
catch { $errors.Add($_.Exception.GetType().FullName) }
finally {
  # No delete/reset/restart of any VHD, VM, build directory or other worker.
  if ($startAttempted) {
    try {
      $original = Owned-VM
      if ($original.State.ToString() -ne 'Off') {
        $stopJob = Stop-VM -VM $original -TurnOff -AsJob -Confirm:$false -ErrorAction Stop
        try { Wait-Job -Job $stopJob -Timeout 30 | Out-Null } finally {
          if ($stopJob.State.ToString() -notin @('Completed','Failed','Stopped')) { Stop-Job -Job $stopJob -ErrorAction Stop }
          Remove-Job -Job $stopJob -ErrorAction Stop
        }
      }
      $drain = [Diagnostics.Stopwatch]::StartNew()
      do {
        $system = System-VM
        $stopped = (Owned-VM).State.ToString() -eq 'Off' -and $system.EnabledState -eq 3 -and $system.ProcessID -eq 0 -and -not (Original-ProcessPresent)
        if (-not $stopped) { Start-Sleep -Milliseconds 100 }
      } while (-not $stopped -and $drain.ElapsedMilliseconds -lt $drainMilliseconds)
      if (-not $stopped) { throw 'Original physical VM process shutdown remains unproved' }
    } catch { $errors.Add($_.Exception.GetType().FullName) }
  } elseif ($null -ne $vm) {
    try { $stopped = (Owned-VM).State.ToString() -eq 'Off' -and (System-VM).ProcessID -eq 0 }
    catch { $errors.Add($_.Exception.GetType().FullName) }
  }
  if ($null -ne $job) {
    try {
      if ($job.State.ToString() -notin @('Completed','Failed','Stopped')) { Stop-Job -Job $job -ErrorAction Stop }
      Remove-Job -Job $job -ErrorAction Stop
    } catch { $errors.Add($_.Exception.GetType().FullName) }
  }
  if ($watchdogRegistered -and $stopped) {
    try {
      Assert-Watchdog
      Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
      if (@(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -ceq $taskName }).Count -ne 0) { throw 'Original watchdog removal unproved' }
      $watchdogRegistered = $false
    } catch { $errors.Add($_.Exception.GetType().FullName) }
  }
  for ($i=$held.Count-1; $i -ge 0; $i--) {
    try { $held[$i].Dispose() } catch { $errors.Add($_.Exception.GetType().FullName) }
  }
}
# Output is bounded comparison DATA; it never admits an SDK executable/host.
[ordered]@{protocol='brc38-windows-bootstrap-hyperv/v1';originalVMProcess=$worker;
  originalVMStopped=$stopped;watchdogRetained=$watchdogRegistered;guest=$guest;errors=@($errors.ToArray());
  memoryLimitBytes=$memoryBytes;CPUCount=$CPUCount;deadlineMilliseconds=$deadlineMilliseconds;
  actualHostQualificationRequired=$true;qualified=$false;runtimePinChanged=$false;fullSystemQualified=$false} | ConvertTo-Json -Depth 12 -Compress
if ($errors.Count -ne 0 -or -not $stopped -or $watchdogRegistered -or $null -eq $guest) { throw 'Outer Windows bootstrap failed; original evidence and any shutdown watchdog retained' }
